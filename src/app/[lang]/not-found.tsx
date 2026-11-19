import { SearchX } from "lucide-react";
import Link from "next/link";

// A product that does not exist or is archived. Both languages, because the chosen one is not known here.
export default function ShopNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-14 text-center">
      <span aria-hidden="true" className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-sf-sun-soft text-sf-sun-deep">
        <SearchX size={28} strokeWidth={1.5} />
      </span>
      <h1 className="text-[1.75rem]">
        <span lang="en">Not found</span> / <span lang="bn">পাওয়া যায়নি</span>
      </h1>
      <p lang="en" className="text-sf-ink-2">
        This product is not available.
      </p>
      <p lang="bn" className="text-sf-ink-2">
        এই পণ্যটি পাওয়া যাচ্ছে না।
      </p>
      <Link href="/en/products" className="sf-btn mt-2">
        Shop All
      </Link>
    </div>
  );
}
