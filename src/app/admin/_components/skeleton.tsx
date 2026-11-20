/** Placeholder blocks while a heavy page (the dashboard, reports) reads its figures. Quiet: a slow shimmer that stops for reduced motion. */
export function PageSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      <div className="of-skeleton h-12 w-full" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="of-skeleton h-28" />
        ))}
      </div>
      <div className="of-skeleton h-64 w-full" />
    </div>
  );
}
