// Shown while a preview page loads: a short text in both languages (the chosen one is not known here) and the shape of
// a product page, so the layout does not jump when it arrives. The shapes pulse only when motion is allowed.
export default function PreviewLoading() {
  const block = "rounded-sm bg-sf-sand motion-safe:animate-pulse";
  return (
    <div role="status" className="space-y-8 py-4" data-testid="preview-loading">
      <p className="text-sm text-sf-umber">
        <span lang="en">Loading…</span> <span lang="bn">লোড হচ্ছে…</span>
      </p>
      <div aria-hidden="true" className="space-y-3">
        <div className={`h-10 w-2/3 max-w-md ${block}`} />
        <div className={`h-4 w-1/2 max-w-sm ${block}`} />
      </div>
      <ul aria-hidden="true" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="space-y-2">
            <div className={`aspect-[4/5] ${block}`} />
            <div className={`h-4 w-3/4 ${block}`} />
            <div className={`h-4 w-1/3 ${block}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}
