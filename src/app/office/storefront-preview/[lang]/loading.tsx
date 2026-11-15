// Shown while a preview page loads. Both languages, because the chosen one is not known here.
export default function PreviewLoading() {
  return (
    <p role="status" className="py-16 text-lg">
      <span lang="en">Loading…</span> <span lang="bn">লোড হচ্ছে…</span>
    </p>
  );
}
