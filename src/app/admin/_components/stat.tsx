/** One figure with what it means in a line, so a number is never read as something else (expected money as received, units on hand as sellable). Use inside a dl. */
export function Stat({ term, value, note, tone, testId }: { term: string; value: React.ReactNode; note: string; tone?: "ok" | "wait"; testId?: string }) {
  return (
    <div className="of-stat" data-tone={tone}>
      <dt>{term}</dt>
      <dd>
        <span data-testid={testId}>{value}</span>
        <span className="of-stat-note">{note}</span>
      </dd>
    </div>
  );
}
