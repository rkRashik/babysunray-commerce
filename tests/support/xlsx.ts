import { zipChunks } from "../../src/modules/exports/formats";

// Hand-built XLSX files for the import tests (fictional content): shared strings like Excel writes them, and
// deliberately hostile variants (formulas, macros, a DOCTYPE, an oversized part).

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

export function sharedStringsSheet(rows: string[][]): { sheet: string; shared: string } {
  const strings: string[] = [];
  const index = (s: string) => {
    const at = strings.indexOf(s);
    if (at >= 0) return at;
    strings.push(s);
    return strings.length - 1;
  };
  const col = (i: number) => String.fromCharCode(65 + i);
  const body = rows
    .map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => (v === "" ? "" : `<c r="${col(c)}${r + 1}" t="s"><v>${index(v)}</v></c>`)).join("")}</row>`)
    .join("");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    sheet: xml(`<worksheet ${NS}><sheetData>${body}</sheetData></worksheet>`),
    shared: xml(`<sst ${NS} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`),
  };
}

export async function buildXlsx(parts: { sheet: string; shared?: string; extra?: Record<string, string>; contentTypes?: string }): Promise<Buffer> {
  const types =
    parts.contentTypes ??
    xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    );
  const files: Record<string, string> = {
    "[Content_Types].xml": types,
    "xl/workbook.xml": xml(`<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Products" sheetId="1" r:id="rId7"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/data.xml"/></Relationships>',
    ),
    "xl/worksheets/data.xml": parts.sheet,
    ...(parts.shared ? { "xl/sharedStrings.xml": parts.shared } : {}),
    ...parts.extra,
  };
  const chunks: Uint8Array[] = [];
  const once = async function* (text: string) {
    yield new TextEncoder().encode(text);
  };
  for await (const c of zipChunks(Object.entries(files).map(([name, text]) => ({ name, data: once(text) })))) chunks.push(c);
  return Buffer.concat(chunks);
}
