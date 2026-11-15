import { type Column, xlsxChunks } from "../exports/formats";
import { IMPORT_COLUMNS, MEASUREMENT_COLUMNS } from "./import-plan";

// The blank import templates: the column names only, no example product, price or category (nothing invented).
// The XLSX template has a second sheet explaining each column; the import reads the first sheet only.

const MEANING: Record<string, string> = {
  product_slug: "Required. New product's web name: lowercase a-z, digits and single hyphens. Rows with the same slug are one product.",
  name_en: "Product name in English. The first row of a product needs name_en or name_bn.",
  name_bn: "Product name in Bangla.",
  description_en: "Optional description in English (line breaks allowed).",
  description_bn: "Optional description in Bangla.",
  category_slug: "Optional. The slug of an existing category (Office → Categories). Unknown slugs are refused.",
  fabric_en: "Optional fabric statement in English. Imported as NOT confirmed: confirm it in the Office after checking evidence.",
  fabric_bn: "Optional fabric statement in Bangla.",
  care_en: "Optional care instructions in English.",
  care_bn: "Optional care instructions in Bangla.",
  size_guidance_en: "Optional size or age guidance in English.",
  size_guidance_bn: "Optional size or age guidance in Bangla.",
  featured: "Optional: yes or no (empty means no).",
  sku: "Required. One row per SKU: A-Z, digits, hyphen, underscore (stored in capitals). Must be new and unique.",
  size: "Optional size label, for example 0-3M.",
  colour: "Optional colour.",
  price_bdt: "Required. Price in Taka with at most two decimals, for example 850 or 850.50. No ৳ sign, no commas.",
};
for (const column of MEASUREMENT_COLUMNS) MEANING[column] = "Optional measurement in centimetres (at most one decimal) for this row's size.";

const COLUMNS: Column[] = IMPORT_COLUMNS.map((key) => ({ key, type: "text" }));

export function csvTemplate(): Uint8Array {
  return new TextEncoder().encode(`﻿${IMPORT_COLUMNS.join(",")}\r\n`);
}

export async function xlsxTemplate(): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const about: [string, string][] = [
    ["How to use", "Fill one row per SKU on the first sheet. Keep the column names. Do not use formulas. All products are created as drafts with zero stock."],
    ...IMPORT_COLUMNS.map((c): [string, string] => [c, MEANING[c]]),
  ];
  async function* none() {}
  for await (const chunk of xlsxChunks("Products", about, COLUMNS, none())) parts.push(chunk);
  return Buffer.concat(parts);
}
