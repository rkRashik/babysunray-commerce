import { DomainError } from "@/modules/domain-error";
import { type DateRange, MAX_RANGE_DAYS, parseDateRange } from "@/modules/reports/dates";

/** The date range from a report URL, or the message to show for an invalid one. */
export function readRange(query: Record<string, string | string[] | undefined>): { range: DateRange | null; error?: string } {
  const value = (name: string) => (typeof query[name] === "string" && query[name] ? (query[name] as string) : undefined);
  try {
    return { range: parseDateRange(value("from"), value("to")) };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { range: null, error: `Choose a start and end date (the start not after the end, at most ${MAX_RANGE_DAYS} days).` };
  }
}
