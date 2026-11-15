import { describe, expect, it } from "vitest";
import { MAX_IMPORT_ROWS, readImportFile } from "../../src/modules/catalogue/import-file";
import { buildPlan, cleanCell, IMPORT_COLUMNS } from "../../src/modules/catalogue/import-plan";
import { csvTemplate, xlsxTemplate } from "../../src/modules/catalogue/import-template";
import { buildXlsx, sharedStringsSheet } from "../support/xlsx";

// Reading and validating catalogue import files (fictional products only).

const HEADER = "product_slug,name_en,name_bn,category_slug,fabric_en,featured,sku,size,colour,price_bdt,chest_cm,length_cm";
const csv = (...lines: string[]) => new TextEncoder().encode([HEADER, ...lines].join("\r\n"));
const plan = (bytes: Uint8Array) => {
  const read = readImportFile(bytes);
  return { read, ...buildPlan(read.header, read.rows, read.issues) };
};
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("CSV reading", () => {
  it("reads quoted fields with commas, quotes and line breaks, a BOM, CRLF or LF, and Bangla text", () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line 1\nline 2"\nনরম,,"৳ 850"\r\n';
    const read = readImportFile(new TextEncoder().encode(text));
    expect(read.issues).toEqual([]);
    expect(read.header).toEqual(["a", "b", "c"]);
    expect(read.rows.map((r) => [r.line, r.cells])).toEqual([
      [2, ["x, y", 'say "hi"', "line 1\nline 2"]],
      [4, ["নরম", "", "৳ 850"]],
    ]);
  });

  it("refuses malformed CSV, non-UTF-8 bytes, semicolon files, old .xls, empty and oversized files", () => {
    const bad: [Uint8Array, string][] = [
      [new TextEncoder().encode('a,b\n"open,1'), "malformed_csv"],
      [new TextEncoder().encode('a,b\nx"y,1'), "malformed_csv"],
      [new TextEncoder().encode('a,b\n"x"y,1'), "malformed_csv"],
      [Uint8Array.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe, 0x2c, 0x31]), "not_utf8"],
      [new TextEncoder().encode("a;b;c\n1;2;3"), "wrong_separator"],
      [Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "unsupported_type"],
      [new Uint8Array(0), "empty_file"],
      [new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61), "file_too_large"],
    ];
    for (const [bytes, code] of bad) {
      const read = readImportFile(bytes);
      expect(codes(read.issues), code).toEqual([code]);
      expect(read.rows).toEqual([]);
    }
  });

  it("refuses more than 1,000 rows and cells over 5,000 characters", () => {
    const many = new TextEncoder().encode(`a\n${"x\n".repeat(MAX_IMPORT_ROWS + 1)}`);
    expect(codes(readImportFile(many).issues)).toEqual(["too_many_rows"]);
    expect(codes(readImportFile(new TextEncoder().encode(`a\n${"y".repeat(5001)}`)).issues)).toEqual(["cell_too_long"]);
  });
});

describe("XLSX reading", () => {
  it("reads the first sheet with shared strings, numbers and Bangla, and the template round-trips", async () => {
    const { sheet, shared } = sharedStringsSheet([
      ["product_slug", "name_bn", "sku", "price_bdt"],
      ["fic-romper", "কাল্পনিক রম্পার", "FIC-1", "850.5"],
    ]);
    const read = readImportFile(await buildXlsx({ sheet, shared }));
    expect(read).toMatchObject({ format: "xlsx", issues: [], header: ["product_slug", "name_bn", "sku", "price_bdt"] });
    expect(read.rows).toEqual([{ line: 2, cells: ["fic-romper", "কাল্পনিক রম্পার", "FIC-1", "850.5"] }]);
    const template = readImportFile(await xlsxTemplate());
    expect([template.format, template.header, template.rows]).toEqual(["xlsx", IMPORT_COLUMNS, []]);
    expect(readImportFile(csvTemplate()).header).toEqual(IMPORT_COLUMNS);
  });

  it("reports a formula cell and never uses its cached value", async () => {
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>product_slug</t></is></c><c r="B1" t="inlineStr"><is><t>price_bdt</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>fic-x</t></is></c><c r="B2"><f>HYPERLINK("http://example.test")</f><v>850</v></c></row></sheetData></worksheet>`;
    const read = readImportFile(await buildXlsx({ sheet }));
    expect(read.issues).toMatchObject([{ line: 2, column: 1, code: "formula" }]);
    expect(read.rows[0].cells[1]).toBe("");
  });

  it("refuses macros, a DOCTYPE or entity, a missing sheet and a part that expands too far (zip bomb)", async () => {
    const { sheet, shared } = sharedStringsSheet([["product_slug"], ["fic-a"]]);
    const macros = await buildXlsx({ sheet, shared, extra: { "xl/vbaProject.bin": "fake macro" } });
    expect(codes(readImportFile(macros).issues)).toEqual(["macros"]);
    const doctype = await buildXlsx({ sheet: `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>${sheet.slice(sheet.indexOf("<worksheet"))}` });
    expect(codes(readImportFile(doctype).issues)).toEqual(["invalid_xlsx"]);
    const bomb = await buildXlsx({ sheet: `${sheet.replace("</sheetData>", `${" ".repeat(41 * 1024 * 1024)}</sheetData>`)}` });
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    expect(readImportFile(bomb).issues[0]).toMatchObject({ code: "invalid_xlsx" });
    const notExcel = await buildXlsx({ sheet, contentTypes: "<Types/>" });
    expect(codes(readImportFile(notExcel).issues)).toEqual(["invalid_xlsx"]);
    const cut = macros.subarray(0, macros.length - 30);
    expect(codes(readImportFile(cut).issues)).toEqual(["invalid_xlsx"]);
  });
});

describe("building the plan", () => {
  it("groups rows into products: product fields from the first row, one SKU per row, measurements by size", () => {
    const { plan: p, issues, warnings, emptyRows } = plan(
      csv(
        "fic-romper,Fictional Romper,কাল্পনিক রম্পার,fic-cat,Fictional fabric,yes,fic-r-1,0-3M,Ivory,850,24.5,38",
        ",,,,,,,,,,,",
        "fic-romper,,,,,,FIC-R-2,0-3M,Sand,850.50,24.5,",
        "fic-cap,,কাল্পনিক টুপি,,,,FIC-C-1,,,120,,",
      ),
    );
    expect(issues).toEqual([]);
    expect(emptyRows).toBe(1);
    expect(warnings.map((w) => w.code)).toEqual(["fabric_unconfirmed"]);
    expect(p.products.map((x) => [x.slug, x.nameEn, x.nameBn, x.categorySlug, x.featured, x.variants.map((v) => [v.sku, v.colour, v.pricePaisa]), x.measurements])).toEqual([
      ["fic-romper", "Fictional Romper", "কাল্পনিক রম্পার", "fic-cat", true, [["FIC-R-1", "Ivory", 85_000], ["FIC-R-2", "Sand", 85_050]], [{ size: "0-3M", point: "chest", valueMm: 245 }, { size: "0-3M", point: "length", valueMm: 380 }]],
      ["fic-cap", null, "কাল্পনিক টুপি", null, false, [["FIC-C-1", null, 12_000]], []],
    ]);
  });

  it("names every problem by row and column and never guesses", () => {
    const { issues, rejectedRows } = plan(
      csv(
        "Bad Slug,Name,,,,,FIC-1,,,850,,",
        "fic-a,,,,,,FIC-2,,,850,,",
        "fic-b,Name,,,,maybe,FIC-3,,,850.505,,",
        "fic-c,Name,,,,,FIC-3,0-3M,,0,,",
        "fic-d,Name,,,,,FIC-4,,,850,24,",
        "fic-e,Name,,,,,FIC-5,0-3M,,850,24.55,",
        "fic-e,Other,,,,,FIC-6,0-3M,,850,25,",
        "fic-f,=HYPERLINK(1),,,,,FIC-7,,,850,,",
        "fic-g,Name,,UNKNOWN CAT,,,ফিক,,,৳850,,",
      ),
    );
    const found = issues.map((i) => `${i.line}:${i.column}:${i.code}`);
    expect(found).toEqual(
      expect.arrayContaining([
        "2:product_slug:invalid_slug",
        "3:name_en:missing_name",
        "4:featured:invalid_featured",
        "4:price_bdt:invalid_price",
        "5:sku:duplicate_sku",
        "5:price_bdt:invalid_price",
        "6:chest_cm:measurement_without_size",
        "7:chest_cm:invalid_measurement",
        "8:name_en:conflicting_product_value",
        "9:name_en:formula_like",
        "10:category_slug:invalid_category",
        "10:sku:invalid_sku",
        "10:price_bdt:invalid_price",
      ]),
    );
    expect(rejectedRows).toBe(9);
  });

  it("refuses unknown, repeated and missing columns before reading any row", () => {
    const read = readImportFile(new TextEncoder().encode("product_slug,sku,secret_margin,sku\nfic-a,FIC-1,5,FIC-1"));
    const built = buildPlan(read.header, read.rows);
    expect(codes(built.issues).sort()).toEqual(["duplicate_column", "missing_column", "unknown_column"]);
    expect(built.plan.products).toEqual([]);
  });

  it("cleans cells: NFC, line breaks only in long text, no control characters, broken Unicode or formula starts", () => {
    expect(cleanCell("  নরম  ", "name_bn")).toEqual({ value: "নরম" });
    expect(cleanCell("é", "name_en")).toEqual({ value: "é" });
    expect(cleanCell("a\r\nb", "description_en")).toEqual({ value: "a\nb" });
    expect(cleanCell("- dash list", "description_en")).toEqual({ value: "- dash list" });
    // Surrounding tabs and spaces are trimmed before the formula check, so a hidden tab cannot shield a formula.
    expect(cleanCell("	=x", "name_en")).toMatchObject({ code: "formula_like" });
    // Surrounding tabs and spaces are trimmed away before the formula check, so they cannot start a formula.
    expect(cleanCell("	=x", "name_en")).toMatchObject({ code: "formula_like" });
    for (const [value, column, code] of [
      ["a\nb", "name_en", "invalid_characters"],
      ["a\u0007b", "description_en", "invalid_characters"],
      ["\uD800x", "name_en", "invalid_unicode"],
      ["=1+1", "name_en", "formula_like"],
      ["+8801", "colour", "formula_like"],
      ["@SUM(A1)", "care_en", "formula_like"],
      ["-1", "size", "formula_like"],
      ["x".repeat(201), "name_en", "too_long"],
    ] as const) {
      expect(cleanCell(value, column), value).toMatchObject({ code });
    }
  });

  it("keeps prices exact in paisa: two decimals at most, no symbols, no grouping, no floating point", () => {
    const prices = (value: string) => plan(csv(`fic-p,Name,,,,,FIC-P,,,${value},,`));
    expect(prices("0.01").plan.products[0].variants[0].pricePaisa).toBe(1);
    expect(prices("1234567.89").plan.products[0].variants[0].pricePaisa).toBe(123_456_789);
    for (const bad of ["1,250", "850.555", "-5", "1e3", "850 ", "Tk 850", "0"]) {
      if (bad.trim() === "850") continue;
      expect(codes(prices(`"${bad}"`).issues), bad).toContain("invalid_price");
    }
  });
});
