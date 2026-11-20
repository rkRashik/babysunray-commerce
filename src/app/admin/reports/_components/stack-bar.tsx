type Segment = { label: string; value: number; tone: "wait" | "ok" | "move" | "bad" | "quiet" };

/**
 * One stacked bar for parts of a real total (counts or money from the records). It is drawn only when there is something
 * to show; every part is also listed in words with its value and share, so colour is never the only carrier of meaning.
 */
export function StackBar({ title, segments, format }: { title: string; segments: Segment[]; format: (value: number) => string }) {
  const parts = segments.filter((s) => s.value > 0);
  const total = parts.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return null;
  const share = (value: number) => `${Math.round((value / total) * 100)}%`;
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <div role="img" aria-label={`${title}: ${parts.map((s) => `${s.label} ${format(s.value)}`).join(", ")}`} className="flex h-3 overflow-hidden rounded-full bg-gray-200">
        {parts.map((s) => (
          <span key={s.label} className="of-seg" data-tone={s.tone} style={{ width: `${(s.value / total) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {parts.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span aria-hidden="true" className="of-seg h-2.5 w-2.5 rounded-full" data-tone={s.tone} />
            <span>
              {s.label} <strong className="tabular-nums">{format(s.value)}</strong> <span className="text-gray-600">({share(s.value)})</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
