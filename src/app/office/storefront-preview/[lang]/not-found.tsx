import Link from "next/link";

// A product that does not exist or is archived. Both languages, because the chosen one is not known here.
export default function PreviewNotFound() {
  return (
    <div className="max-w-xl space-y-4 py-12">
      <h1 className="text-2xl font-semibold">
        <span lang="en">Not found</span> · <span lang="bn">পাওয়া যায়নি</span>
      </h1>
      <p lang="en">This product does not exist or has been archived.</p>
      <p lang="bn">এই পণ্যটি নেই অথবা আর্কাইভ করা হয়েছে।</p>
      <Link href="/office/storefront-preview/en/products" className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
        All products
      </Link>
    </div>
  );
}
