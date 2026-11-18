// A read-only review of migration SQL for statements that are not purely additive (Gate H.53). It is the "additive
// migration" check of the production migration plan (docs/operations/production-migration.md): it reads text only,
// connects to nothing and changes nothing. A finding is not a verdict: a constraint that is dropped and re-created
// (Drizzle's way of changing a CHECK) is routine, while dropping a column or table needs a backup, a stated reason and the
// Owner's approval first. Pure, so it can be tested and reused by a future preflight.

export type Finding = { level: "destructive" | "check"; rule: string; statement: string };

const RULES: { level: Finding["level"]; rule: string; test: RegExp }[] = [
  { level: "destructive", rule: "drops a table, column, index, type or schema", test: /^\s*(alter table .* )?drop (table|column|index|type|schema|view|trigger|function)\b/i },
  { level: "destructive", rule: "renames an object (the running application may still use the old name)", test: /^\s*alter .* rename\b/i },
  { level: "destructive", rule: "changes a column's type", test: /^\s*alter table .* alter column .* (set data )?type\b/i },
  { level: "destructive", rule: "truncates a table", test: /^\s*truncate\b/i },
  { level: "destructive", rule: "deletes rows", test: /^\s*delete from\b/i },
  { level: "check", rule: "rewrites rows (an UPDATE needs a row-count check on real data)", test: /^\s*update\b/i },
  { level: "check", rule: "makes a column NOT NULL (fails if existing rows hold NULL)", test: /^\s*alter table .* alter column .* set not null\b/i },
  { level: "check", rule: "adds a NOT NULL column without a default (fails on a table with rows)", test: /^\s*alter table .* add column (?!.*\bdefault\b)(?=.*\bnot null\b)/i },
  { level: "check", rule: "drops a constraint (confirm the same migration re-creates or replaces it)", test: /^\s*alter table .* drop constraint\b/i },
];

/** Splits a Drizzle migration into statements (`--> statement-breakpoint`) with comments and blank lines removed. */
export function statementsOf(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function reviewMigration(sql: string): Finding[] {
  const findings: Finding[] = [];
  for (const statement of statementsOf(sql)) {
    // Only the first rule that matches a statement is reported; trigger and function bodies are not statements of their own.
    if (/^\s*create (or replace )?(trigger|function)\b/i.test(statement)) continue;
    const hit = RULES.find((r) => r.test.test(statement));
    if (hit) findings.push({ level: hit.level, rule: hit.rule, statement: statement.length > 160 ? `${statement.slice(0, 157)}...` : statement });
  }
  return findings;
}
