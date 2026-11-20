import { DomainError } from "@/modules/domain-error";
import { type DateRange, MAX_RANGE_DAYS, parseDateRange } from "@/modules/reports/dates";

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Quick ranges in Dhaka calendar dates, ending today (or covering last month). */
export function rangePresets(today: string): { label: string; range: DateRange }[] {
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = shift(monthStart, -1);
  return [
    { label: "Today", range: { from: today, to: today } },
    { label: "Last 7 days", range: { from: shift(today, -6), to: today } },
    { label: "Last 30 days", range: { from: shift(today, -29), to: today } },
    { label: "This month", range: { from: monthStart, to: today } },
    { label: "Last month", range: { from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd } },
  ];
}

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
