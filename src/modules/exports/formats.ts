import { Readable } from "node:stream";
import { pipeline } from "node:stream";
import { createDeflateRaw } from "node:zlib";

// File formats for exports (requirements D-1 to D-4). Pure streaming encoders: each takes the column list and
// an async sequence of row batches and yields bytes, so memory stays bounded however many rows there are.
//
// Cell types: text stays text in every format (phone numbers keep their leading zero, order references stay
// "ORD-000042"); integers (amounts in paisa, quantities) are exact numbers; timestamps are UTC instants.
// XLSX writes text as inline strings and never writes a formula, so no cell can execute. CSV has no cell
// types at all: see csvCell for the formula-injection rule and its visible cost.

export type ColumnType = "text" | "integer" | "timestamp" | "date" | "boolean" | "json";
export type Column = { key: string; type: ColumnType; description?: string };
export type Value = string | number | boolean | null | Record<string, unknown>;
export type Row = Record<string, Value>;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

/** "2026-11-15T08:03:00.000Z" → "2026-11-15 14:03:00" (Bangladesh time, for spreadsheets). */
const dhakaFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Dhaka",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
export function dhakaTimestamp(iso: string): string {
  const parts = Object.fromEntries(dhakaFormat.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Spreadsheet header text for a column: timestamps say which clock they are in. */
export const spreadsheetHeader = (c: Column) => (c.type === "timestamp" ? `${c.key}_dhaka` : c.key);

/** A cell as spreadsheet text (CSV, and XLSX text cells): timestamps in Dhaka time, JSON as compact text. */
function spreadsheetText(column: Column, value: Value): string {
  if (value === null) return "";
  if (column.type === "timestamp") return dhakaTimestamp(String(value));
  if (column.type === "json") return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------------------------------------
// CSV: RFC 4180 (comma, CRLF, double quotes doubled), UTF-8 with a byte-order mark so desktop Excel reads
// Bangla correctly.

// A cell Excel or another spreadsheet would treat as a formula or command: = + - @ at the start, or a tab or
// carriage return (OWASP CSV injection guidance). Quoting does NOT prevent this.
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV field. A text value that would start a formula gets a leading apostrophe, so it is shown as text;
 * the apostrophe is then part of the value (visible), which changes the data: JSON and XLSX keep the exact text.
 * Numbers are written as digits only (validated integers), so they cannot start a formula.
 */
export function csvCell(column: Column, value: Value): string {
  if (value === null) return "";
  if (column.type === "integer") return String(exactInteger(value));
  if (column.type === "boolean") return value ? "true" : "false";
  let text = spreadsheetText(column, value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function* csvChunks(columns: Column[], batches: AsyncIterable<Row[]>): AsyncGenerator<Uint8Array> {
  yield bytes(`﻿${columns.map((c) => spreadsheetHeader(c)).join(",")}\r\n`);
  for await (const batch of batches) {
    if (batch.length) yield bytes(batch.map((row) => `${columns.map((c) => csvCell(c, row[c.key] ?? null)).join(",")}\r\n`).join(""));
  }
}

// ---------------------------------------------------------------------------------------------------------
// JSON: one object, streamed. Integers stay JSON numbers (every amount is an exact safe integer of paisa);
// timestamps are ISO 8601 UTC; ids are strings.

export async function* jsonChunks(meta: Record<string, unknown>, columns: Column[], batches: AsyncIterable<Row[]>): AsyncGenerator<Uint8Array> {
  const head = JSON.stringify({ ...meta, columns: columns.map((c) => ({ name: c.key, type: c.type, ...(c.description ? { description: c.description } : {}) })) });
  yield bytes(`${head.slice(0, -1)},"records":[`);
  let first = true;
  for await (const batch of batches) {
    if (!batch.length) continue;
    const text = batch
      .map((row) => JSON.stringify(Object.fromEntries(columns.map((c) => [c.key, c.type === "integer" && row[c.key] !== null ? exactInteger(row[c.key]) : (row[c.key] ?? null)]))))
      .join(",");
    yield bytes(first ? text : `,${text}`);
    first = false;
  }
  yield bytes("]}\n");
}

// ---------------------------------------------------------------------------------------------------------
// XLSX (Office Open XML, ECMA-376): a ZIP of a few XML parts. Written here rather than with a library because
// the subset needed (one data sheet, one "About" sheet, inline strings, integers, booleans) is small and
// streams; no formula element is ever written.

export function exactInteger(value: Value): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Export value is not an exact integer.");
  return n;
}

// XML 1.0 allows tab, LF, CR and most of Unicode; anything else (other control characters, lone surrogates,
// U+FFFE/FFFF) is replaced so the file always parses.
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const xmlText = (text: string) => text.replace(XML_INVALID, "�").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function xlsxCell(ref: string, column: Column, value: Value, style = 0): string {
  const s = style ? ` s="${style}"` : "";
  if (value === null) return "";
  if (column.type === "integer") return `<c r="${ref}"${s}><v>${exactInteger(value)}</v></c>`;
  if (column.type === "boolean") return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(spreadsheetText(column, value))}</t></is></c>`;
}

const TEXT: Column = { key: "", type: "text" };
const textRow = (rowNumber: number, values: string[], style = 0) =>
  `<row r="${rowNumber}">${values.map((v, i) => xlsxCell(`${columnName(i)}${rowNumber}`, TEXT, v, style)).join("")}</row>`;

const SHEET_HEAD =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';

async function* dataSheet(columns: Column[], batches: AsyncIterable<Row[]>): AsyncGenerator<Uint8Array> {
  yield bytes(
    `${SHEET_HEAD}<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${textRow(1, columns.map(spreadsheetHeader), 1)}`,
  );
  let r = 1;
  for await (const batch of batches) {
    let xml = "";
    for (const row of batch) {
      r += 1;
      xml += `<row r="${r}">${columns.map((c, i) => xlsxCell(`${columnName(i)}${r}`, c, row[c.key] ?? null)).join("")}</row>`;
    }
    if (xml) yield bytes(xml);
  }
  yield bytes("</sheetData></worksheet>");
}

function aboutSheet(about: [string, string][]): Uint8Array {
  return bytes(`${SHEET_HEAD}<sheetData>${about.map(([k, v], i) => textRow(i + 1, [k, v])).join("")}</sheetData></worksheet>`);
}

const STATIC_PARTS = (sheetName: string): [string, string][] => [
  [
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  ],
  [
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  ],
  [
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/><sheet name="About" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  ],
  [
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  ],
  [
    "xl/styles.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>',
  ],
];

/** Sheet names: at most 31 characters, none of : \ / ? * [ ]. Dataset names already satisfy this. */
export async function* xlsxChunks(sheetName: string, about: [string, string][], columns: Column[], batches: AsyncIterable<Row[]>): AsyncGenerator<Uint8Array> {
  yield* zipChunks([
    ...STATIC_PARTS(sheetName).map(([name, xml]) => ({ name, data: once(bytes(xml)) })),
    { name: "xl/worksheets/sheet1.xml", data: dataSheet(columns, batches) },
    { name: "xl/worksheets/sheet2.xml", data: once(aboutSheet(about)) },
  ]);
}

async function* once(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
  yield chunk;
}

// ---------------------------------------------------------------------------------------------------------
// ZIP (PKWARE APPNOTE 6.3): deflated entries, each followed by a data descriptor (flag bit 3), so an entry is
// written while its content is still being generated. ZIP32 limits (4 GiB, 65,535 entries) are far above the
// export row limit; exceeding them throws instead of writing a corrupt file.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

const DOS_DATE = (1 << 5) | 1; // 1980-01-01: entries carry no meaningful time
const ZIP32_MAX = 0xffffffff;

function header(size: number, write: (view: DataView) => void): Uint8Array {
  const buffer = new Uint8Array(size);
  write(new DataView(buffer.buffer));
  return buffer;
}

async function* deflate(input: AsyncIterable<Uint8Array>, stats: { crc: number; size: number; compressed: number }): AsyncGenerator<Uint8Array> {
  const counted = (async function* () {
    for await (const chunk of input) {
      stats.crc = crc32(chunk, stats.crc);
      stats.size += chunk.length;
      yield chunk;
    }
  })();
  // pipeline destroys both streams on an error, so a failing source makes this loop throw.
  const output = pipeline(Readable.from(counted), createDeflateRaw(), () => {});
  for await (const chunk of output as AsyncIterable<Buffer>) {
    stats.compressed += chunk.length;
    yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
  }
}

export async function* zipChunks(entries: { name: string; data: AsyncIterable<Uint8Array> }[]): AsyncGenerator<Uint8Array> {
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = bytes(entry.name);
    const local = header(30 + name.length, (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0x0008, true);
      v.setUint16(8, 8, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, DOS_DATE, true);
      v.setUint16(26, name.length, true);
    });
    local.set(name, 30);
    const start = offset;
    yield local;
    offset += local.length;
    const stats = { crc: 0, size: 0, compressed: 0 };
    for await (const chunk of deflate(entry.data, stats)) {
      offset += chunk.length;
      yield chunk;
    }
    if (stats.size > ZIP32_MAX || stats.compressed > ZIP32_MAX || offset > ZIP32_MAX) throw new Error("Export is too large for a ZIP32 file.");
    const descriptor = header(16, (v) => {
      v.setUint32(0, 0x08074b50, true);
      v.setUint32(4, stats.crc, true);
      v.setUint32(8, stats.compressed, true);
      v.setUint32(12, stats.size, true);
    });
    yield descriptor;
    offset += descriptor.length;
    const record = header(46 + name.length, (v) => {
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0008, true);
      v.setUint16(10, 8, true);
      v.setUint16(14, DOS_DATE, true);
      v.setUint32(16, stats.crc, true);
      v.setUint32(20, stats.compressed, true);
      v.setUint32(24, stats.size, true);
      v.setUint16(28, name.length, true);
      v.setUint32(42, start, true);
    });
    record.set(name, 46);
    central.push(record);
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  for (const record of central) yield record;
  yield header(22, (v) => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, central.length, true);
    v.setUint16(10, central.length, true);
    v.setUint32(12, size, true);
    v.setUint32(16, offset, true);
  });
}
