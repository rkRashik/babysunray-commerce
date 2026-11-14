import { invalidInput } from "./domain-error";

// Money is integer paisa everywhere (1 BDT = 100 paisa). These convert to and from the Taka text a person
// types and reads, with string arithmetic only, so no floating-point rounding can change an amount.

/** "850", "850.5" or "850.50" Taka → 85050 paisa. At most two decimals; no sign, grouping or currency symbol. */
export function parseTakaToPaisa(raw: string, field = "price"): number {
  const match = /^([0-9]{1,14})(?:\.([0-9]{1,2}))?$/.exec(raw.trim());
  if (!match) throw invalidInput(field, "must be an amount in Taka with at most two decimals, for example 850 or 850.50");
  const paisa = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(paisa)) throw invalidInput(field, "is too large");
  return paisa;
}

/** 85050 → "850.50" (Taka with two decimals, no grouping). */
export function formatPaisa(paisa: number): string {
  const sign = paisa < 0 ? "-" : "";
  const abs = Math.abs(paisa);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
