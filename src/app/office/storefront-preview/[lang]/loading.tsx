// Shown while a preview page loads: a short text in both languages (the chosen one is not known here) and the shape of
// a product list, so the layout does not jump when it arrives. The shapes shimmer only when motion is allowed.
export default function PreviewLoading() {
  return (
    <div role="status" className="space-y-6" data-testid="preview-loading">
      <p className="sr-only">
        <span lang="en">Loading…</span> <span lang="bn">লোড হচ্ছে…</span>
      </p>
      <div aria-hidden="true" className="space-y-4">
        <div className="sf-skeleton h-10 w-2/3 max-w-sm" />
        <div className="flex gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="sf-skeleton h-11 w-24 rounded-full" />
          ))}
        </div>
      </div>
      <ul aria-hidden="true" className="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4 lg:gap-x-6">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <li key={i} className="space-y-2.5">
            <div className="sf-skeleton aspect-[4/5] rounded-[9999px_9999px_1.375rem_1.375rem]" />
            <div className="sf-skeleton h-4 w-4/5" />
            <div className="sf-skeleton h-4 w-1/3" />
          </li>
        ))}
      </ul>
    </div>
  );
}
