import { invalidInput } from "../domain-error";
import { dhakaToday } from "../orders/rules";

// Report and export date ranges. The Owner picks calendar dates in Bangladesh time, both inclusive; queries
// use the half-open UTC interval [start of `from` in Dhaka, start of the day after `to` in Dhaka), so the last
// instant of `to` is included and nothing of the next day is.

export const TIME_ZONE = "Asia/Dhaka";
/** Technical bound so one report or export cannot scan years of history by accident (not a business rule). */
export const MAX_RANGE_DAYS = 366;

export type DateRange = { from: string; to: string };

const DAY = 86_400_000;

function calendarDate(raw: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw invalidInput(field, "must be a date (YYYY-MM-DD)");
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) throw invalidInput(field, "must be a real calendar date");
  return raw;
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Validates an inclusive Dhaka date range; defaults to the first of this month up to today. */
export function parseDateRange(from: string | undefined, to: string | undefined, today = dhakaToday()): DateRange {
  const range = {
    from: from ? calendarDate(from, "from") : `${today.slice(0, 8)}01`,
    to: to ? calendarDate(to, "to") : today,
  };
  if (range.from > range.to) throw invalidInput("from", "must not be after the end date");
  if ((Date.parse(range.to) - Date.parse(range.from)) / DAY + 1 > MAX_RANGE_DAYS) throw invalidInput("to", `must be at most ${MAX_RANGE_DAYS} days after the start date`);
  return range;
}

/** The UTC offset of Asia/Dhaka at `instant`, in minutes (from the platform's time-zone data, not hardcoded). */
function dhakaOffsetMinutes(instant: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name ?? "");
  if (!match) throw new Error("Unexpected time-zone offset format.");
  return match[1] ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

/** The UTC instant at which a Dhaka calendar date begins. */
export function dhakaDayStart(date: string): Date {
  const utcMidnight = Date.parse(`${calendarDate(date, "date")}T00:00:00Z`);
  // Two passes handle a date whose offset differs from the offset at UTC midnight.
  let start = utcMidnight - dhakaOffsetMinutes(new Date(utcMidnight)) * 60_000;
  start = utcMidnight - dhakaOffsetMinutes(new Date(start)) * 60_000;
  return new Date(start);
}

/** [start, end) in UTC for an inclusive Dhaka date range. */
export function rangeInstants(range: DateRange): { start: Date; end: Date } {
  return { start: dhakaDayStart(range.from), end: dhakaDayStart(addDays(range.to, 1)) };
}
