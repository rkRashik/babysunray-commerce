import { invalidInput } from "../domain-error";
import { optionalText } from "./rules";

// Structured product content (migration 0011): pure rules shared by the services, the Office, the storefront
// preview and the tests. Every value is entered by the Owner; nothing here writes or translates text.

/** Garment measuring points. The same list as the CHECK in src/db/schema.ts (a unit test keeps them equal). */
export const MEASUREMENT_POINTS = ["chest", "waist", "hip", "length", "shoulder", "sleeve", "inseam", "foot"] as const;
export type MeasurementPoint = (typeof MEASUREMENT_POINTS)[number];
export const isMeasurementPoint = (value: unknown): value is MeasurementPoint => typeof value === "string" && (MEASUREMENT_POINTS as readonly string[]).includes(value);

/** Technical bounds, not merchandising policy. */
export const MAX_CONTENT_LENGTH = 1000;
export const MAX_MEASUREMENT_MM = 3000;
export const MAX_MEASUREMENT_SIZES = 30;

export type Measurement = { size: string; point: MeasurementPoint; valueMm: number };

const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";

/**
 * Centimetres typed by the Owner → whole millimetres. Accepts "42", "42.5", "42,5" and Bangla digits ("৪২.৫");
 * at most one decimal, 0.1 to 300 cm. Integer millimetres keep every value exact (no floating point).
 */
export function parseCentimetres(raw: string, field = "measurement"): number {
  if (typeof raw !== "string") throw invalidInput(field, "must be a number of centimetres");
  const text = raw.trim().replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d))).replace(",", ".");
  const match = /^([0-9]{1,3})(?:\.([0-9]))?$/.exec(text);
  if (!match) throw invalidInput(field, "must be centimetres with at most one decimal, for example 42 or 42.5");
  const mm = Number(match[1]) * 10 + Number(match[2] ?? "0");
  if (mm < 1 || mm > MAX_MEASUREMENT_MM) throw invalidInput(field, "must be from 0.1 to 300 cm");
  return mm;
}

/** Whole millimetres → centimetres for display: "42", "42.5"; Bangla digits for "bn". Exact, no rounding. */
export function formatCentimetres(mm: number, locale: "en" | "bn" = "en"): string {
  const text = mm % 10 === 0 ? String(mm / 10) : `${Math.trunc(mm / 10)}.${mm % 10}`;
  return locale === "bn" ? text.replace(/[0-9]/g, (d) => BANGLA_DIGITS[Number(d)]) : text;
}

/**
 * A complete size chart: unique (size, point) pairs, known points, sizes as on the variants (trimmed, 1-64
 * characters), at most 30 sizes. An empty list removes the chart.
 */
export function validateMeasurements(rows: { size: string; point: string; valueMm: number }[]): Measurement[] {
  if (!Array.isArray(rows)) throw invalidInput("measurements", "must be a list");
  const seen = new Set<string>();
  const sizes = new Set<string>();
  const result: Measurement[] = [];
  for (const row of rows) {
    const size = optionalText(row.size, "size", 64);
    if (size === null) throw invalidInput("size", "is required for every measurement");
    if (!isMeasurementPoint(row.point)) throw invalidInput("point", `must be one of ${MEASUREMENT_POINTS.join(", ")}`);
    if (!Number.isSafeInteger(row.valueMm) || row.valueMm < 1 || row.valueMm > MAX_MEASUREMENT_MM) throw invalidInput("valueMm", "must be 1 to 3000 millimetres");
    const key = `${size}\u0000${row.point}`;
    if (seen.has(key)) throw invalidInput("measurements", `has ${row.point} twice for size ${size}`);
    seen.add(key);
    sizes.add(size);
    result.push({ size, point: row.point, valueMm: row.valueMm });
  }
  if (sizes.size > MAX_MEASUREMENT_SIZES) throw invalidInput("measurements", `may cover at most ${MAX_MEASUREMENT_SIZES} sizes`);
  return result;
}

/** Optional Owner text for fabric, care and size guidance: trimmed, at most 1000 characters, blank is null. */
export const contentText = (raw: string | null | undefined, field: string) => optionalText(raw, field, MAX_CONTENT_LENGTH);

/** Which languages a bilingual field has. */
export function languages(en: string | null, bn: string | null): { en: boolean; bn: boolean } {
  return { en: en !== null && en.trim() !== "", bn: bn !== null && bn.trim() !== "" };
}
