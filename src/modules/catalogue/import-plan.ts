import { DomainError } from "../domain-error";
import { parseTakaToPaisa } from "../money";
import { MAX_CONTENT_LENGTH, MEASUREMENT_POINTS, type MeasurementPoint, parseCentimetres } from "./content";
import type { RawRow, ReadIssue } from "./import-file";
import { normalizeSku, validateSlug } from "./rules";

// Turning rows of text into a plan of new draft products (docs/operations/catalogue-import.md). One row per SKU;
// rows with the same product_slug form one product, whose fields come from its first row (a later row may
// leave them empty, or repeat them exactly). Pure: no database access; import-service.ts checks what already
// exists. The plan is create-only and changes nothing by itself.

export const PRODUCT_COLUMNS = [
  "product_slug",
  "name_en",
  "name_bn",
  "description_en",
  "description_bn",
  "category_slug",
  "fabric_en",
  "fabric_bn",
  "care_en",
  "care_bn",
  "size_guidance_en",
  "size_guidance_bn",
  "featured",
] as const;
export const VARIANT_COLUMNS = ["sku", "size", "colour", "price_bdt"] as const;
export const MEASUREMENT_COLUMNS = MEASUREMENT_POINTS.map((p) => `${p}_cm` as const);
export const IMPORT_COLUMNS = [...PRODUCT_COLUMNS, ...VARIANT_COLUMNS, ...MEASUREMENT_COLUMNS];
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
const REQUIRED: ImportColumn[] = ["product_slug", "sku", "price_bdt"];
const MULTILINE = new Set<string>(["description_en", "description_bn", "fabric_en", "fabric_bn", "care_en", "care_bn", "size_guidance_en", "size_guidance_bn"]);
const LIMITS: Partial<Record<ImportColumn, number>> = {
  name_en: 200,
  name_bn: 200,
  description_en: 5000,
  description_bn: 5000,
  size: 64,
  colour: 64,
  ...Object.fromEntries(["fabric_en", "fabric_bn", "care_en", "care_bn", "size_guidance_en", "size_guidance_bn"].map((c) => [c, MAX_CONTENT_LENGTH])),
};

export type ImportIssue = { line: number | null; column: string | null; code: string; message: string };
export type PlannedVariant = { sku: string; size: string | null; colour: string | null; pricePaisa: number; line: number };
export type PlannedProduct = {
  slug: string;
  nameEn: string | null;
  nameBn: string | null;
  descriptionEn: string | null;
  descriptionBn: string | null;
  categorySlug: string | null;
  fabricEn: string | null;
  fabricBn: string | null;
  careEn: string | null;
  careBn: string | null;
  sizeGuidanceEn: string | null;
  sizeGuidanceBn: string | null;
  featured: boolean;
  variants: PlannedVariant[];
  measurements: { size: string; point: MeasurementPoint; valueMm: number }[];
  lines: number[];
};
export type ImportPlan = { products: PlannedProduct[] };
export type PlanResult = { plan: ImportPlan; issues: ImportIssue[]; warnings: ImportIssue[]; emptyRows: number; rejectedRows: number };

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Text a spreadsheet program could treat as a formula when the data is opened again (CSV injection).
const FORMULA_LIKE = /^(?:[=+@\t\r]|-(?!\s))/;

/** One cell as stored text: NFC, trimmed, checked. Returns the text or an issue code with a message. */
export function cleanCell(raw: string, column: string): { value: string } | { code: string; message: string } {
  if (LONE_SURROGATE.test(raw)) return { code: "invalid_unicode", message: "contains broken Unicode characters" };
  const value = raw.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (CONTROL.test(value) || (!MULTILINE.has(column) && value.includes("\n"))) return { code: "invalid_characters", message: "contains line breaks or control characters that are not allowed here" };
  if (FORMULA_LIKE.test(value) && column !== "price_bdt" && !column.endsWith("_cm")) {
    return { code: "formula_like", message: "starts with =, +, -, @ or a tab, which a spreadsheet could run as a formula. Remove that first character" };
  }
  const limit = LIMITS[column as ImportColumn];
  if (limit !== undefined && value.length > limit) return { code: "too_long", message: `must be at most ${limit} characters` };
  return { value };
}

const FEATURED: Record<string, boolean> = { "": false, no: false, false: false, "0": false, yes: true, true: true, "1": true };

/** Maps the header to known columns; unknown, repeated or missing required columns make the file unusable. */
export function mapHeader(header: string[]): { columns: (ImportColumn | null)[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  const columns = header.map((raw, i): ImportColumn | null => {
    const name = raw.normalize("NFC").trim().toLowerCase();
    if (name === "") return null;
    if (!(IMPORT_COLUMNS as readonly string[]).includes(name)) {
      issues.push({ line: 1, column: raw.trim().slice(0, 60), code: "unknown_column", message: `Column ${i + 1} is not a template column. Remove it or use the template's names.` });
      return null;
    }
    if (seen.has(name)) issues.push({ line: 1, column: name, code: "duplicate_column", message: "This column appears twice." });
    seen.add(name);
    return name as ImportColumn;
  });
  for (const required of REQUIRED) if (!seen.has(required)) issues.push({ line: 1, column: required, code: "missing_column", message: "This required column is missing." });
  return { columns, issues };
}

/**
 * Validates every row and groups them into products. Errors name the row (as numbered in the file) and the
 * column; nothing is guessed: a value that cannot be read exactly is an error, never a default.
 */
export function buildPlan(header: string[], rows: RawRow[], readIssues: ReadIssue[] = []): PlanResult {
  // A file that could not be read at all: report only that, not the missing columns it caused.
  const fileLevel = readIssues.filter((r) => r.line === null);
  if (fileLevel.length) return { plan: { products: [] }, issues: fileLevel.map((r) => ({ line: null, column: null, code: r.code, message: r.message })), warnings: [], emptyRows: 0, rejectedRows: rows.length };
  const { columns, issues } = mapHeader(header);
  const warnings: ImportIssue[] = [];
  for (const r of readIssues) issues.push({ line: r.line, column: r.column === null ? null : (columns[r.column] ?? `column ${r.column + 1}`), code: r.code, message: r.message });
  if (issues.some((i) => i.line === 1 || i.line === null)) return { plan: { products: [] }, issues, warnings, emptyRows: 0, rejectedRows: rows.length };

  const products = new Map<string, PlannedProduct & { firstLine: number; raw: Partial<Record<ImportColumn, string>> }>();
  const skuLines = new Map<string, number>();
  const badLines = new Set<number>();
  let emptyRows = 0;
  const problem = (line: number, column: string | null, code: string, message: string) => {
    issues.push({ line, column, code, message });
    badLines.add(line);
  };

  for (const row of rows) {
    if (row.cells.every((c) => c.trim() === "")) {
      emptyRows += 1;
      continue;
    }
    const cell: Partial<Record<ImportColumn, string>> = {};
    let rowOk = true;
    for (const [i, raw] of row.cells.entries()) {
      const column = columns[i];
      if (column === undefined || column === null) {
        if (raw.trim() !== "") problem(row.line, `column ${i + 1}`, "value_without_column", "A value in a column without a template name.");
        continue;
      }
      const cleaned = cleanCell(raw, column);
      if ("code" in cleaned) {
        problem(row.line, column, cleaned.code, `${column} ${cleaned.message}.`);
        rowOk = false;
      } else cell[column] = cleaned.value;
    }
    if (badLines.has(row.line) && !rowOk) continue;
    const value = (c: ImportColumn) => cell[c] ?? "";
    const optional = (c: ImportColumn) => (value(c) === "" ? null : value(c));

    let slug: string;
    try {
      slug = validateSlug(value("product_slug"));
    } catch {
      problem(row.line, "product_slug", "invalid_slug", "product_slug must be lowercase letters a-z, digits and single hyphens (at most 100).");
      continue;
    }
    let sku: string | null = null;
    try {
      sku = normalizeSku(value("sku"));
    } catch (error) {
      problem(row.line, "sku", value("sku") === "" ? "missing_sku" : "invalid_sku", error instanceof DomainError ? error.message : "sku is not valid.");
    }
    if (sku) {
      const earlier = skuLines.get(sku);
      if (earlier !== undefined) problem(row.line, "sku", "duplicate_sku", `SKU ${sku} is also on row ${earlier}. Each SKU can appear once.`);
      else skuLines.set(sku, row.line);
    }
    let pricePaisa = 0;
    try {
      pricePaisa = parseTakaToPaisa(value("price_bdt"), "price_bdt");
      if (pricePaisa <= 0) throw new Error();
    } catch {
      problem(row.line, "price_bdt", "invalid_price", "price_bdt must be Taka greater than 0 with at most two decimals, for example 850 or 850.50 (no ৳ sign or commas).");
    }
    const size = optional("size");
    const measured: { point: MeasurementPoint; valueMm: number }[] = [];
    for (const [i, point] of MEASUREMENT_POINTS.entries()) {
      const column = MEASUREMENT_COLUMNS[i];
      if (value(column) === "") continue;
      if (size === null) {
        problem(row.line, column, "measurement_without_size", `${column} needs a size on the same row.`);
        continue;
      }
      try {
        measured.push({ point, valueMm: parseCentimetres(value(column), column) });
      } catch {
        problem(row.line, column, "invalid_measurement", `${column} must be centimetres with at most one decimal, from 0.1 to 300 (for example 42 or 42.5).`);
      }
    }
    let featured = false;
    const featuredText = value("featured").toLowerCase();
    if (Object.hasOwn(FEATURED, featuredText)) featured = FEATURED[featuredText];
    else problem(row.line, "featured", "invalid_featured", "featured must be yes, no or empty.");
    if (optional("category_slug") !== null) {
      try {
        validateSlug(value("category_slug"));
      } catch {
        problem(row.line, "category_slug", "invalid_category", "category_slug must be a category's slug as shown in the Office (lowercase letters, digits, hyphens).");
      }
    }

    let product = products.get(slug);
    if (!product) {
      product = {
        slug,
        nameEn: optional("name_en"),
        nameBn: optional("name_bn"),
        descriptionEn: optional("description_en"),
        descriptionBn: optional("description_bn"),
        categorySlug: optional("category_slug"),
        fabricEn: optional("fabric_en"),
        fabricBn: optional("fabric_bn"),
        careEn: optional("care_en"),
        careBn: optional("care_bn"),
        sizeGuidanceEn: optional("size_guidance_en"),
        sizeGuidanceBn: optional("size_guidance_bn"),
        featured,
        variants: [],
        measurements: [],
        lines: [],
        firstLine: row.line,
        raw: cell,
      };
      products.set(slug, product);
      if (product.nameEn === null && product.nameBn === null) problem(row.line, "name_en", "missing_name", "The first row of a product needs name_en or name_bn.");
    } else {
      for (const column of PRODUCT_COLUMNS) {
        if (column === "product_slug" || value(column) === "") continue;
        if (value(column) !== (product.raw[column] ?? "")) {
          problem(row.line, column, "conflicting_product_value", `${column} differs from row ${product.firstLine} of the same product. Leave it empty after the first row, or repeat it exactly.`);
        }
      }
    }
    product.lines.push(row.line);
    if (badLines.has(row.line) || !sku) continue;
    product.variants.push({ sku, size, colour: optional("colour"), pricePaisa, line: row.line });
    for (const m of measured) {
      const existing = product.measurements.find((x) => x.size === size && x.point === m.point);
      if (!existing) product.measurements.push({ size: size as string, ...m });
      else if (existing.valueMm !== m.valueMm) problem(row.line, `${m.point}_cm`, "conflicting_measurement", `${m.point}_cm for size ${size} differs from an earlier row of the same product.`);
    }
  }

  if ([...products.values()].some((p) => p.fabricEn || p.fabricBn)) {
    warnings.push({ line: null, column: "fabric_en", code: "fabric_unconfirmed", message: "Fabric statements are imported as not confirmed. Confirm each one in the Office only after checking the label or supplier document." });
  }
  const plan: ImportPlan = {
    products: [...products.values()].map((p) => ({
      slug: p.slug,
      nameEn: p.nameEn,
      nameBn: p.nameBn,
      descriptionEn: p.descriptionEn,
      descriptionBn: p.descriptionBn,
      categorySlug: p.categorySlug,
      fabricEn: p.fabricEn,
      fabricBn: p.fabricBn,
      careEn: p.careEn,
      careBn: p.careBn,
      sizeGuidanceEn: p.sizeGuidanceEn,
      sizeGuidanceBn: p.sizeGuidanceBn,
      featured: p.featured,
      variants: p.variants,
      lines: p.lines,
      measurements: p.measurements.sort((a, b) => (a.size < b.size ? -1 : a.size > b.size ? 1 : MEASUREMENT_POINTS.indexOf(a.point) - MEASUREMENT_POINTS.indexOf(b.point))),
    })),
  };
  return { plan, issues, warnings, emptyRows, rejectedRows: badLines.size };
}
