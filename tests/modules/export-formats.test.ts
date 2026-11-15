import { inflateRawSync } from "node:zlib";
import readXlsxFile from "read-excel-file/node";
import { describe, expect, it } from "vitest";
import { type Column, crc32, csvCell, csvChunks, dhakaTimestamp, jsonChunks, type Row, xlsxChunks, xmlText } from "../../src/modules/exports/formats";
import { validateExport } from "../../src/modules/exports/service";

// Export file formats (requirements D-1 to D-4, G-5). XLSX files are read back with an independent parser
// (read-excel-file), not with this project's own writer.

const COLUMNS: Column[] = [
  { key: "order_reference", type: "text" },
  { key: "customer_name", type: "text" },
  { key: "customer_phone", type: "text" },
  { key: "total_paisa", type: "integer" },
  { key: "created_at", type: "timestamp" },
  { key: "active", type: "boolean" },
  { key: "detail", type: "json" },
];

// Fictional values, including every formula-starting character and Bangla text.
const ROWS: Row[] = [
  { order_reference: "ORD-000042", customer_name: "পরীক্ষা গ্রাহক", customer_phone: "01711000001", total_paisa: 9007199254740991, created_at: "2026-11-14T18:00:00.000Z", active: true, detail: { lines: 2 } },
  { order_reference: "ORD-000043", customer_name: "=HYPERLINK(\"http://example.test\")", customer_phone: "01811000002", total_paisa: 0, created_at: "2026-11-15T08:03:00.000Z", active: false, detail: null },
  { order_reference: "ORD-000044", customer_name: "+1+1", customer_phone: "01911000003", total_paisa: 5, created_at: "2026-11-15T17:59:59.999Z", active: null, detail: null },
  { order_reference: "ORD-000045", customer_name: "-2+3", customer_phone: "01311000004", total_paisa: 85_050, created_at: "2026-11-15T18:00:00.000Z", active: true, detail: null },
  { order_reference: "ORD-000046", customer_name: "@SUM(A1)", customer_phone: "01611000005", total_paisa: 1, created_at: "2026-01-01T00:00:00.000Z", active: true, detail: null },
  { order_reference: "ORD-000047", customer_name: "\tTabbed", customer_phone: "01511000006", total_paisa: 2, created_at: "2026-01-01T00:00:00.000Z", active: true, detail: null },
  { order_reference: "ORD-000048", customer_name: "Comma, \"quote\"\nnew line", customer_phone: "01711000007", total_paisa: 3, created_at: "2026-01-01T00:00:00.000Z", active: true, detail: null },
];

async function* batches(rows: Row[], size = 3): AsyncGenerator<Row[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of chunks) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

describe("CSV", () => {
  it("neutralises every formula-starting text value and only those", () => {
    const text: Column = { key: "x", type: "text" };
    for (const risky of ["=1+1", "+1", "-1", "@A1", "\t1", "\r1"]) expect(csvCell(text, risky).replace(/^"/, "")).toMatch(/^'/);
    expect(csvCell(text, "01711000001")).toBe("01711000001");
    expect(csvCell(text, "পরীক্ষা")).toBe("পরীক্ষা");
    expect(csvCell(text, 'a,"b"')).toBe('"a,""b"""');
    expect(csvCell(text, " padded ")).toBe('" padded "');
  });

  it("writes integers as exact digits, including negatives, and refuses inexact numbers", () => {
    const n: Column = { key: "n", type: "integer" };
    expect(csvCell(n, -3)).toBe("-3");
    expect(csvCell(n, "9007199254740991")).toBe("9007199254740991");
    expect(() => csvCell(n, 1.5)).toThrow();
    expect(() => csvCell(n, "9007199254740993")).toThrow();
  });

  it("produces a UTF-8 file with a byte-order mark, CRLF rows and Dhaka times", async () => {
    const file = await collect(csvChunks(COLUMNS, batches(ROWS)));
    expect([...file.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = file.toString("utf8").slice(1);
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("order_reference,customer_name,customer_phone,total_paisa,created_at_dhaka,active,detail");
    expect(lines[1]).toBe('ORD-000042,পরীক্ষা গ্রাহক,01711000001,9007199254740991,2026-11-15 00:00:00,true,"{""lines"":2}"');
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://example.test"")"`);
    expect(lines[3]).toContain(",'+1+1,");
    expect(lines[4]).toContain(",'-2+3,");
    expect(lines[5]).toContain(",'@SUM(A1),");
    expect(text).toContain(`,'\tTabbed,`);
    expect(text).toContain('"Comma, ""quote""\nnew line"');
    expect(text.endsWith("\r\n")).toBe(true);
  });
});

describe("timestamps", () => {
  it("converts UTC instants to Bangladesh time across midnight", () => {
    expect(dhakaTimestamp("2026-11-15T17:59:59.999Z")).toBe("2026-11-15 23:59:59");
    expect(dhakaTimestamp("2026-11-15T18:00:00.000Z")).toBe("2026-11-16 00:00:00");
  });
});

describe("JSON", () => {
  it("is one valid object with metadata, typed columns and exact integers", async () => {
    const meta = { schemaVersion: 1, dataset: "orders", scope: "filtered", filters: { source: "whatsapp" }, createdAt: "2026-11-15T08:00:00.000Z", timeZone: "Asia/Dhaka" };
    const parsed = JSON.parse((await collect(jsonChunks(meta, COLUMNS, batches(ROWS)))).toString("utf8"));
    expect(parsed).toMatchObject(meta);
    expect(parsed.columns[3]).toEqual({ name: "total_paisa", type: "integer" });
    expect(parsed.records).toHaveLength(ROWS.length);
    expect(parsed.records[0]).toEqual({ ...ROWS[0], total_paisa: 9007199254740991 });
    expect(parsed.records[1].customer_name).toBe('=HYPERLINK("http://example.test")');
    expect(parsed.records[0].customer_phone).toBe("01711000001");
  });

  it("is valid with no records", async () => {
    const parsed = JSON.parse((await collect(jsonChunks({ schemaVersion: 1 }, COLUMNS, batches([])))).toString("utf8"));
    expect(parsed.records).toEqual([]);
  });
});

describe("XLSX", () => {
  it("opens in an independent reader with typed cells, exact text and no formulas", async () => {
    const file = await collect(xlsxChunks("orders", [["Scope", "Filtered export"]], COLUMNS, batches(ROWS)));
    const sheets = await readXlsxFile(file);
    expect(sheets.map((s) => s.sheet)).toEqual(["orders", "About"]);
    const data = sheets[0].data;
    expect(data[0]).toEqual(["order_reference", "customer_name", "customer_phone", "total_paisa", "created_at_dhaka", "active", "detail"]);
    expect(data[1]).toEqual(["ORD-000042", "পরীক্ষা গ্রাহক", "01711000001", 9007199254740991, "2026-11-15 00:00:00", true, '{"lines":2}']);
    // Text stays text (leading zero kept), numbers are numbers, and risky text is stored exactly as text.
    expect(typeof data[2][2]).toBe("string");
    expect(data[2][1]).toBe('=HYPERLINK("http://example.test")');
    expect(data[3][1]).toBe("+1+1");
    expect(data[4][1]).toBe("-2+3");
    expect(data[4][3]).toBe(85_050);
    expect(data[7][1]).toBe('Comma, "quote"\nnew line');
    expect(data).toHaveLength(ROWS.length + 1);
    expect(sheets[1].data[0]).toEqual(["Scope", "Filtered export"]);
    // No cell anywhere is a formula: the writer never emits <f>.
    expect(unzip(file).get("xl/worksheets/sheet1.xml")).not.toContain("<f>");
  });

  it("is a well-formed ZIP: every CRC and size in the central directory matches the inflated data", async () => {
    const file = await collect(xlsxChunks("orders", [], COLUMNS, batches(ROWS)));
    const entries = unzip(file);
    expect([...entries.keys()]).toContain("[Content_Types].xml");
    expect(entries.get("xl/worksheets/sheet1.xml")).toContain("<sheetData>");
  });

  it("replaces characters XML cannot carry", () => {
    expect(xmlText("a\u0001b<c>&")).toBe("a�b&lt;c&gt;&amp;");
  });
});

// Reads the central directory, inflates each entry and checks its CRC-32 and size (test-only ZIP reader).
function unzip(file: Buffer): Map<string, string> {
  const eocd = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = file.readUInt16LE(eocd + 10);
  let p = file.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    expect(file.readUInt32LE(p)).toBe(0x02014b50);
    const crc = file.readUInt32LE(p + 16);
    const compressed = file.readUInt32LE(p + 20);
    const size = file.readUInt32LE(p + 24);
    const nameLength = file.readUInt16LE(p + 28);
    const local = file.readUInt32LE(p + 42);
    const name = file.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
    const data = inflateRawSync(file.subarray(dataStart, dataStart + compressed));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data.toString("utf8"));
    p += 46 + nameLength;
  }
  return out;
}

describe("export requests", () => {
  it("is complete without filters and filtered with any", () => {
    expect(validateExport({ dataset: "orders", format: "csv", filters: {} }).scope).toBe("complete");
    expect(validateExport({ dataset: "orders", format: "xlsx", filters: { source: "whatsapp" } }).scope).toBe("filtered");
    expect(validateExport({ dataset: "orders", format: "json", filters: { from: "2026-11-01", to: "2026-11-15" } }).filters).toEqual({ from: "2026-11-01", to: "2026-11-15" });
  });

  it.each([
    [{ dataset: "auth_sessions", format: "csv", filters: {} }],
    [{ dataset: "orders", format: "pdf", filters: {} }],
    [{ dataset: "orders", format: "csv", filters: { source: "facebook" } }],
    [{ dataset: "orders", format: "csv", filters: { from: "2026-11-01" } }],
    [{ dataset: "stock", format: "csv", filters: { from: "2026-11-01", to: "2026-11-02" } }],
    [{ dataset: "products_variants", format: "csv", filters: { orderStatus: "confirmed" } }],
    [{ dataset: "orders", format: "csv", filters: { paymentStatus: "settled'; drop table orders; --" } }],
  ])("refuses an unknown dataset, format or filter: %j", (request) => {
    expect(() => validateExport(request)).toThrow();
  });
});
