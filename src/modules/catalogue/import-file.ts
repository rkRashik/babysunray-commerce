import { inflateRawSync } from "node:zlib";
import { crc32 } from "../exports/formats";

// Reading an uploaded catalogue file (CSV or XLSX) into rows of text cells, with hard limits, before any
// meaning is given to a cell (import-plan.ts does that). Nothing here touches the database or evaluates
// anything: a spreadsheet formula is refused, never calculated.
//
// XLSX is read with a small reader of our own on Node's zlib instead of a library, so every limit is ours: the
// ZIP is read from its central directory, only the few parts needed are inflated, each with a maximum output
// size (a "zip bomb" stops at the limit), CRC-checked, and the XML is scanned without a DTD processor (a
// DOCTYPE or ENTITY is refused, so no entity expansion or external fetch can happen). Macro-enabled workbooks,
// encrypted or ZIP64 entries and old binary .xls files are refused.

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_COLUMNS = 40;
export const MAX_CELL_LENGTH = 5000;
const MAX_INFLATED_TOTAL = 40 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 300;

export type FileFormat = "csv" | "xlsx";
export type RawRow = { line: number; cells: string[] };
/** A problem with the whole file (it cannot be read), or with one cell of one row. */
export type ReadIssue = { line: number | null; column: number | null; code: string; message: string };
export type ReadResult = { format: FileFormat; header: string[]; rows: RawRow[]; issues: ReadIssue[] };

class FileProblem extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const fileIssue = (code: string, message: string): ReadIssue => ({ line: null, column: null, code, message });

/** Reads an uploaded file. Never throws for bad content: problems come back as issues (and no rows). */
export function readImportFile(bytes: Uint8Array): ReadResult {
  const empty = (format: FileFormat, issue: ReadIssue): ReadResult => ({ format, header: [], rows: [], issues: [issue] });
  if (bytes.length === 0) return empty("csv", fileIssue("empty_file", "The file is empty."));
  if (bytes.length > MAX_IMPORT_BYTES) return empty("csv", fileIssue("file_too_large", "The file is larger than 2 MB. Split it into smaller files."));
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  try {
    if (starts([0x50, 0x4b, 0x03, 0x04])) return withRows("xlsx", readXlsx(bytes));
    if (starts([0xd0, 0xcf, 0x11, 0xe0])) return empty("xlsx", fileIssue("unsupported_type", "Old Excel .xls files are not supported. Save it as .xlsx (Excel Workbook) or CSV UTF-8."));
    return withRows("csv", readCsv(bytes));
  } catch (error) {
    if (error instanceof FileProblem) return empty(starts([0x50, 0x4b]) ? "xlsx" : "csv", fileIssue(error.code, error.message));
    throw error;
  }
}

function withRows(format: FileFormat, read: { table: string[][]; lines: number[]; issues: ReadIssue[] }): ReadResult {
  const [header = [], ...rest] = read.table;
  if (header.length === 0 || header.every((h) => h.trim() === "")) return { format, header: [], rows: [], issues: [fileIssue("no_header", "The first row must contain the column names from the template.")] };
  if (header.length > MAX_IMPORT_COLUMNS) return { format, header: [], rows: [], issues: [fileIssue("too_many_columns", `The file has more than ${MAX_IMPORT_COLUMNS} columns.`)] };
  const rows = rest.map((cells, i) => ({ line: read.lines[i + 1], cells }));
  if (rows.length > MAX_IMPORT_ROWS) return { format, header: [], rows: [], issues: [fileIssue("too_many_rows", `The file has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.`)] };
  for (const row of rows) {
    for (const [i, cell] of row.cells.entries()) {
      if (cell.length > MAX_CELL_LENGTH) throw new FileProblem("cell_too_long", `Row ${row.line}, column ${i + 1} is longer than ${MAX_CELL_LENGTH} characters.`);
    }
  }
  return { format, header, rows, issues: read.issues };
}

// ---------------------------------------------------------------------------------------------------------
// CSV (RFC 4180): comma-separated, double quotes around fields that contain commas, quotes or line breaks, a
// quote inside a quoted field written twice. UTF-8 only (a byte-order mark is allowed); CRLF or LF.

function readCsv(bytes: Uint8Array): { table: string[][]; lines: number[]; issues: ReadIssue[] } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileProblem("not_utf8", "The file is not valid UTF-8 text. In Excel use Save As → CSV UTF-8, or upload the .xlsx file.");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000")) throw new FileProblem("binary_file", "This does not look like a CSV text file.");
  const table: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  let fieldStart = true;
  const endRow = () => {
    row.push(field);
    table.push(row);
    lines.push(rowLine);
    row = [];
    field = "";
    fieldStart = true;
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        if (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") throw new FileProblem("malformed_csv", `Row ${rowLine}: text after a closing quote. Check the quotes on this row.`);
        continue;
      }
      if (c === "\n") line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (!fieldStart) throw new FileProblem("malformed_csv", `Row ${rowLine}: a quote inside a field that does not start with a quote.`);
      quoted = true;
      fieldStart = false;
      i += 1;
    } else if (c === ",") {
      row.push(field);
      field = "";
      fieldStart = true;
      i += 1;
    } else if (c === "\r" || c === "\n") {
      endRow();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line += 1;
      rowLine = line;
    } else {
      field += c;
      fieldStart = false;
      i += 1;
    }
    if (table.length > MAX_IMPORT_ROWS + 1) throw new FileProblem("too_many_rows", `The file has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.`);
  }
  if (quoted) throw new FileProblem("malformed_csv", `Row ${rowLine}: a quoted field is never closed.`);
  if (field !== "" || row.length > 0) endRow();
  if (table.length && table[0].length === 1 && table[0][0].includes(";")) {
    throw new FileProblem("wrong_separator", "The columns are separated by semicolons. Save the file as CSV UTF-8 (comma-separated).");
  }
  return { table, lines, issues: [] };
}

// ---------------------------------------------------------------------------------------------------------
// XLSX: the first worksheet only; shared strings, inline strings, numbers and booleans. A cell with a formula is
// reported (with its row and column) and its value is never used.

type ZipEntry = { name: string; method: number; compressed: number; size: number; crc: number; offset: number };

function centralDirectory(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 22 - 0xffff); p -= 1) {
    if (view.getUint32(p, true) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new FileProblem("invalid_xlsx", "The .xlsx file is damaged (no ZIP directory).");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count > MAX_ZIP_ENTRIES) throw new FileProblem("invalid_xlsx", "The .xlsx file has too many parts.");
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > zip.length || view.getUint32(p, true) !== 0x02014b50) throw new FileProblem("invalid_xlsx", "The .xlsx file is damaged (bad ZIP directory).");
    const flags = view.getUint16(p + 8, true);
    const entry: ZipEntry = {
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressed: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      name: new TextDecoder().decode(zip.subarray(p + 46, p + 46 + view.getUint16(p + 28, true))),
      offset: view.getUint32(p + 42, true),
    };
    if (flags & 1) throw new FileProblem("invalid_xlsx", "Password-protected (encrypted) workbooks are not supported.");
    if (entry.size === 0xffffffff || entry.compressed === 0xffffffff || entry.offset === 0xffffffff) throw new FileProblem("invalid_xlsx", "The .xlsx file is too large (ZIP64).");
    entries.push(entry);
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return entries;
}

function inflate(zip: Uint8Array, entry: ZipEntry, budget: { left: number }): string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const p = entry.offset;
  if (p + 30 > zip.length || view.getUint32(p, true) !== 0x04034b50) throw new FileProblem("invalid_xlsx", "The .xlsx file is damaged (bad ZIP entry).");
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const data = zip.subarray(start, start + entry.compressed);
  if (data.length !== entry.compressed) throw new FileProblem("invalid_xlsx", "The .xlsx file is cut short.");
  if (entry.size > budget.left) throw new FileProblem("invalid_xlsx", "The .xlsx file expands to too much data.");
  let out: Buffer;
  try {
    if (entry.method === 0) out = Buffer.from(data);
    else if (entry.method === 8) out = inflateRawSync(data, { maxOutputLength: Math.min(budget.left, entry.size + 1) });
    else throw new FileProblem("invalid_xlsx", "The .xlsx file uses an unsupported compression.");
  } catch (error) {
    if (error instanceof FileProblem) throw error;
    throw new FileProblem("invalid_xlsx", "The .xlsx file is damaged or expands to too much data.");
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw new FileProblem("invalid_xlsx", "The .xlsx file is damaged (checksum).");
  budget.left -= out.length;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(out);
  } catch {
    throw new FileProblem("invalid_xlsx", "The .xlsx file contains text that is not valid UTF-8.");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new FileProblem("invalid_xlsx", "The .xlsx file contains XML declarations that are not allowed.");
  return text;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function xmlDecode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "�";
    }
    return ENTITIES[name] ?? whole;
  });
}

/** The text of every <t> inside a fragment (rich-text runs joined), without phonetic guides. */
function textOf(fragment: string): string {
  const withoutPhonetic = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += xmlDecode(m[1] ?? "");
  return out;
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

function columnIndex(ref: string | undefined, fallback: number): number {
  const letters = ref ? /^([A-Z]{1,3})[0-9]+$/.exec(ref)?.[1] : undefined;
  if (!letters) return fallback;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(zip: Uint8Array): { table: string[][]; lines: number[]; issues: ReadIssue[] } {
  const entries = centralDirectory(zip);
  const byName = new Map(entries.map((e) => [e.name, e]));
  if (byName.has("xl/vbaProject.bin")) throw new FileProblem("macros", "Workbooks with macros are not accepted. Save the file as a normal .xlsx workbook.");
  const budget = { left: MAX_INFLATED_TOTAL };
  const part = (name: string) => {
    const entry = byName.get(name);
    return entry ? inflate(zip, entry, budget) : null;
  };
  const types = part("[Content_Types].xml");
  if (!types || !types.includes("spreadsheetml")) throw new FileProblem("invalid_xlsx", "This is not an Excel workbook (.xlsx).");
  if (/macroEnabled/i.test(types)) throw new FileProblem("macros", "Workbooks with macros are not accepted. Save the file as a normal .xlsx workbook.");
  const workbook = part("xl/workbook.xml") ?? "";
  const rels = part("xl/_rels/workbook.xml.rels") ?? "";
  const firstSheet = /<sheet\b[^>]*>/.exec(workbook)?.[0];
  const relId = firstSheet ? attr(firstSheet, "r:id") : undefined;
  const relation = relId ? [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => attr(r, "Id") === relId) : undefined;
  const target = relation ? attr(relation, "Target") : undefined;
  const sheetName = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`) : "xl/worksheets/sheet1.xml";
  if (!/^xl\/worksheets\/[A-Za-z0-9_]+\.xml$/.test(sheetName)) throw new FileProblem("invalid_xlsx", "The workbook's first sheet could not be found.");
  const sheet = part(sheetName);
  if (sheet === null) throw new FileProblem("invalid_xlsx", "The workbook's first sheet could not be found.");
  const sharedXml = part("xl/sharedStrings.xml");
  const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => textOf(m[1] ?? "")) : [];

  const table: string[][] = [];
  const lines: number[] = [];
  const issues: ReadIssue[] = [];
  let rowNumber = 0;
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rowNumber = Number(attr(rowMatch[1], "r") ?? rowNumber + 1);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) throw new FileProblem("invalid_xlsx", "The worksheet has an invalid row number.");
    const cells: string[] = [];
    let next = 0;
    for (const cell of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cell[1];
      const inner = cell[2] ?? "";
      const col = columnIndex(attr(tag, "r"), next);
      next = col + 1;
      if (col >= MAX_IMPORT_COLUMNS) throw new FileProblem("too_many_columns", `The file has more than ${MAX_IMPORT_COLUMNS} columns.`);
      const type = attr(tag, "t");
      let value = "";
      if (/<f\b/.test(inner)) {
        issues.push({ line: rowNumber, column: col, code: "formula", message: "This cell contains a formula. Formulas are not calculated: type the value itself." });
      } else if (type === "s") {
        const index = Number(/<v>([0-9]+)<\/v>/.exec(inner)?.[1] ?? "-1");
        if (index < 0 || index >= shared.length) throw new FileProblem("invalid_xlsx", "The workbook refers to text that is missing.");
        value = shared[index];
      } else if (type === "inlineStr") {
        value = textOf(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
      } else if (type === "b") {
        value = /<v>1<\/v>/.test(inner) ? "TRUE" : "FALSE";
      } else if (type === "e") {
        issues.push({ line: rowNumber, column: col, code: "cell_error", message: "This cell shows an Excel error." });
      } else {
        value = xmlDecode(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? "");
      }
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    while (table.length < rowNumber - 1) {
      table.push([]);
      lines.push(table.length);
    }
    table.push(cells);
    lines.push(rowNumber);
    if (table.length > MAX_IMPORT_ROWS + 1) throw new FileProblem("too_many_rows", `The file has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.`);
  }
  return { table, lines, issues };
}
