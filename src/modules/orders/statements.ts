import "server-only";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/database";
import { courierStatementChecks, orders } from "@/db/schema";
import { assertPermission, type Principal } from "../auth/principal";
import { readImportFile } from "../catalogue/import-file";
import { DomainError } from "../domain-error";
import { type Once, runOnce } from "../idempotency/service";
import { parseTakaToPaisa } from "../money";
import { formatOrderNumber, parseOrderNumber } from "./rules";

// Courier statement check (Gate H.41; OF-8's statement reconciliation, proposed). The Owner copies a courier's
// statement into a generic template, one row per consignment, and gets a comparison with the COD money recorded
// for each order. It is read-only matching: nothing is collected, settled or deducted from a statement, because no
// courier's statement format or process is known and a file is not proof of payment. The Owner records each entry
// by hand (aftercare.ts). Each check is audited with the report it showed (order references and amounts only).

/** The template's columns, in order. Amounts are in Taka with at most two decimals, as on a statement. */
export const STATEMENT_COLUMNS = ["order_reference", "collected_taka", "deducted_taka", "remitted_taka"] as const;
/** Largest statement text accepted (it travels in a 64 KiB JSON body). */
export const MAX_STATEMENT_CHARS = 60_000;

type Amounts = { collectedPaisa: number; deductedPaisa: number; remittedPaisa: number };
export type StatementRow = {
  line: number;
  reference: string | null;
  /** matches: every amount equals the record; differs: at least one does not; the rest are not compared. */
  status: "matches" | "differs" | "order_not_found" | "duplicate" | "invalid";
  problems: string[];
  statement: Amounts | null;
  recorded: { collectedPaisa: number; settledPaisa: number; deductedPaisa: number; orderStatus: string; fulfilmentStatus: string } | null;
  /** Statement minus record, per amount (remitted is compared with settled). */
  differencePaisa: { collected: number; deducted: number; remitted: number } | null;
};
export type StatementReport = {
  fileSha256: string;
  summary: { rows: number; matches: number; differs: number; notFound: number; duplicates: number; invalid: number };
  totals: { statement: Amounts; recorded: { collectedPaisa: number; settledPaisa: number; deductedPaisa: number } };
  rows: StatementRow[];
};

const invalid = (line: number, problems: string[]): StatementRow => ({ line, reference: null, status: "invalid", problems, statement: null, recorded: null, differencePaisa: null });

/** Parses the template strictly. A wrong header or a broken CSV refuses the whole file; a bad row is reported. */
function parseStatement(text: string): { sha256: string; rows: { line: number; number: number | null; amounts: Amounts | null; problems: string[] }[] } {
  if (typeof text !== "string" || text.length === 0) throw new DomainError("INVALID_INPUT", "csv must be the statement as CSV text.");
  if (text.length > MAX_STATEMENT_CHARS) throw new DomainError("INVALID_INPUT", `csv must be at most ${MAX_STATEMENT_CHARS} characters; split the statement.`);
  const bytes = new TextEncoder().encode(text);
  const read = readImportFile(bytes);
  if (read.format !== "csv") throw new DomainError("INVALID_INPUT", "csv must be CSV text.");
  const fileIssue = read.issues.find((i) => i.line === null) ?? read.issues[0];
  if (fileIssue) throw new DomainError("INVALID_INPUT", `The statement could not be read (${fileIssue.code}${fileIssue.line ? `, line ${fileIssue.line}` : ""}).`);
  const header = read.header.map((h) => h.trim().toLowerCase());
  if (header.length !== STATEMENT_COLUMNS.length || header.some((h, i) => h !== STATEMENT_COLUMNS[i])) {
    throw new DomainError("INVALID_INPUT", `The first row must be exactly: ${STATEMENT_COLUMNS.join(",")}.`);
  }
  const rows = read.rows
    .filter((r) => r.cells.some((c) => c.trim() !== ""))
    .map((r) => {
      const problems: string[] = [];
      if (r.cells.length !== STATEMENT_COLUMNS.length) return { line: r.line, number: null, amounts: null, problems: ["wrong_column_count"] };
      const number = parseOrderNumber(r.cells[0]);
      if (number === null) problems.push("reference_invalid");
      const amount = (cell: string, column: string) => {
        try {
          return parseTakaToPaisa(cell, column);
        } catch {
          problems.push(`amount_invalid:${column}`);
          return 0;
        }
      };
      const amounts = { collectedPaisa: amount(r.cells[1], "collected_taka"), deductedPaisa: amount(r.cells[2], "deducted_taka"), remittedPaisa: amount(r.cells[3], "remitted_taka") };
      return { line: r.line, number, amounts: problems.length ? null : amounts, problems };
    });
  return { sha256: createHash("sha256").update(bytes).digest("hex"), rows };
}

/** Compares a statement with the recorded COD money (read-only). */
export async function compareStatement(db: Db, text: string): Promise<StatementReport> {
  const parsed = parseStatement(text);
  const valid = parsed.rows.filter((r) => r.amounts && r.number !== null);
  const seen = new Map<number, number>();
  for (const r of valid) seen.set(r.number as number, (seen.get(r.number as number) ?? 0) + 1);
  const numbers = [...seen.keys()].filter((n) => seen.get(n) === 1);
  const found = numbers.length
    ? await db
        .select({ number: orders.number, collected: orders.codCollectedPaisa, settled: orders.codSettledPaisa, deducted: orders.codDeductedPaisa, orderStatus: orders.orderStatus, fulfilmentStatus: orders.fulfilmentStatus })
        .from(orders)
        .where(inArray(orders.number, numbers))
    : [];
  const byNumber = new Map(found.map((o) => [o.number, o]));
  const rows: StatementRow[] = parsed.rows.map((r) => {
    if (!r.amounts || r.number === null) return invalid(r.line, r.problems);
    const reference = formatOrderNumber(r.number);
    const base = { line: r.line, reference, statement: r.amounts, problems: [] as string[] };
    if ((seen.get(r.number) ?? 0) > 1) return { ...base, status: "duplicate", problems: ["reference_repeated_in_file"], recorded: null, differencePaisa: null };
    const o = byNumber.get(r.number);
    if (!o) return { ...base, status: "order_not_found", recorded: null, differencePaisa: null };
    const problems: string[] = [];
    if (r.amounts.deductedPaisa + r.amounts.remittedPaisa > r.amounts.collectedPaisa) problems.push("statement_exceeds_collected");
    if (!["dispatched", "delivered", "rto", "rto_received"].includes(o.fulfilmentStatus)) problems.push("order_not_dispatched");
    const differencePaisa = { collected: r.amounts.collectedPaisa - o.collected, deducted: r.amounts.deductedPaisa - o.deducted, remitted: r.amounts.remittedPaisa - o.settled };
    const same = differencePaisa.collected === 0 && differencePaisa.deducted === 0 && differencePaisa.remitted === 0;
    return {
      ...base,
      status: same && problems.length === 0 ? "matches" : "differs",
      problems,
      recorded: { collectedPaisa: o.collected, settledPaisa: o.settled, deductedPaisa: o.deducted, orderStatus: o.orderStatus, fulfilmentStatus: o.fulfilmentStatus },
      differencePaisa,
    };
  });
  const sum = (pick: (r: StatementRow) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const compared = (r: StatementRow) => r.status === "matches" || r.status === "differs";
  const totals = {
    statement: {
      collectedPaisa: sum((r) => (compared(r) ? r.statement!.collectedPaisa : 0)),
      deductedPaisa: sum((r) => (compared(r) ? r.statement!.deductedPaisa : 0)),
      remittedPaisa: sum((r) => (compared(r) ? r.statement!.remittedPaisa : 0)),
    },
    recorded: {
      collectedPaisa: sum((r) => r.recorded?.collectedPaisa ?? 0),
      settledPaisa: sum((r) => r.recorded?.settledPaisa ?? 0),
      deductedPaisa: sum((r) => r.recorded?.deductedPaisa ?? 0),
    },
  };
  for (const value of [...Object.values(totals.statement), ...Object.values(totals.recorded)]) {
    if (!Number.isSafeInteger(value)) throw new DomainError("INVALID_INPUT", "The statement's totals are too large.");
  }
  const count = (status: StatementRow["status"]) => rows.filter((r) => r.status === status).length;
  return {
    fileSha256: parsed.sha256,
    summary: { rows: rows.length, matches: count("matches"), differs: count("differs"), notFound: count("order_not_found"), duplicates: count("duplicate"), invalid: count("invalid") },
    totals,
    rows,
  };
}

export type StatementCheck = StatementReport & { checkId: string; checkedAt: string };

/**
 * Checks a statement once per idempotency key (ADR-0005) and records the check with the report it showed. A retry
 * returns that same report, even if orders changed since. Requires `payments:record`. Changes no order or payment.
 */
export async function checkCourierStatementOnce(db: Db, principal: Principal, key: string, input: { csv: string }): Promise<Once<StatementCheck>> {
  const user = assertPermission(principal, "payments:record");
  const csv = typeof input.csv === "string" ? input.csv : "";
  return runOnce(
    db,
    { userId: user.userId, operation: "cod.statement.check", key, request: { csvSha256: createHash("sha256").update(csv).digest("hex") } },
    async (tx) => {
      const report = await compareStatement(tx, csv);
      const { summary } = report;
      const [row] = await tx
        .insert(courierStatementChecks)
        .values({
          actorUserId: user.userId,
          fileSha256: report.fileSha256,
          rowCount: summary.rows,
          matches: summary.matches,
          differs: summary.differs,
          notFound: summary.notFound,
          duplicates: summary.duplicates,
          invalid: summary.invalid,
          report,
        })
        .returning({ id: courierStatementChecks.id });
      return { checkId: row.id };
    },
    async (tx, ref: { checkId: string }) => {
      const [row] = await tx.select().from(courierStatementChecks).where(eq(courierStatementChecks.id, ref.checkId));
      return { ...(row.report as StatementReport), checkId: row.id, checkedAt: row.createdAt.toISOString() };
    },
  );
}
