import Link from "next/link";
import { SignOutButton } from "./auth-forms";

type Crumb = { href: string; label: string; lang?: string };

const NAV_LINK = "rounded px-1 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900";

// Neutral internal layout for the Owner Office. Functional only: not an approved visual design.
export function OfficeShell({
  title,
  titleLang,
  children,
  notice,
  breadcrumbs = [],
  current,
}: {
  title: string;
  /** "bn" when the title is a Bangla product name. */
  titleLang?: string;
  children: React.ReactNode;
  notice?: string;
  /** Where this page sits, from Products down; the page itself is the title. */
  breadcrumbs?: Crumb[];
  current?: "dashboard" | "products" | "new" | "import" | "preparation" | "categories" | "orders" | "delivery" | "reports" | "counts" | "exports" | "media" | "preview";
}) {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:ring-2 focus:ring-gray-900"
      >
        Skip to content
      </a>
      <header className="border-b border-gray-300 bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <nav aria-label="Owner Office" className="flex flex-wrap items-center gap-4 text-sm">
            <span className="font-semibold">Owner Office</span>
            <Link href="/office/dashboard" aria-current={current === "dashboard" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Dashboard
            </Link>
            <Link href="/office" aria-current={current === "products" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Products
            </Link>
            <Link href="/office/products/new" aria-current={current === "new" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              New product
            </Link>
            <Link href="/office/import" aria-current={current === "import" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Import
            </Link>
            <Link href="/office/catalogue-preparation" aria-current={current === "preparation" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Preparation
            </Link>
            <Link href="/office/categories" aria-current={current === "categories" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Categories
            </Link>
            <Link href="/office/orders" aria-current={current === "orders" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Orders
            </Link>
            <Link href="/office/settings/delivery" aria-current={current === "delivery" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Delivery charges
            </Link>
            <Link href="/office/reports" aria-current={current === "reports" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Reports
            </Link>
            <Link href="/office/stock-counts" aria-current={current === "counts" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Stock counts
            </Link>
            <Link href="/office/exports" aria-current={current === "exports" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Exports
            </Link>
            <Link href="/office/media-health" aria-current={current === "media" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Photo storage
            </Link>
            <Link href="/office/storefront-preview/en" aria-current={current === "preview" ? "page" : undefined} className={`${NAV_LINK} aria-[current=page]:font-semibold aria-[current=page]:underline`}>
              Storefront preview
            </Link>
          </nav>
          <SignOutButton />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-4xl space-y-6 px-4 py-6 focus:outline-none">
        {breadcrumbs.length ? (
          <nav aria-label="Breadcrumb" className="text-sm text-gray-700">
            <ol className="flex flex-wrap items-center gap-1">
              {breadcrumbs.map((crumb) => (
                <li key={crumb.href} className="flex items-center gap-1">
                  <Link href={crumb.href} lang={crumb.lang} className="underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900">
                    {crumb.label}
                  </Link>
                  <span aria-hidden="true">›</span>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <h1 lang={titleLang} className="text-xl font-semibold break-words">
          {title}
        </h1>
        {notice ? (
          <p role="status" className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">
            {notice}
          </p>
        ) : null}
        {children}
      </main>
    </div>
  );
}

/** A titled panel; the heading names the region for assistive technology. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="space-y-3 rounded border border-gray-300 bg-white p-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const dhaka = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });
/** Stored in UTC, shown in Bangladesh time. */
export const formatTime = (date: Date) => `${dhaka.format(date)} (Dhaka)`;

/** Product title as shown in the Office: English name, else Bangla name (marked as Bangla), else the slug. */
export function productTitle(p: { nameEn: string | null; nameBn: string | null; slug: string }): { title: string; lang?: string } {
  if (p.nameEn) return { title: p.nameEn };
  if (p.nameBn) return { title: p.nameBn, lang: "bn" };
  return { title: p.slug };
}

const NOTICES: Record<string, string> = {
  created: "Draft product created.",
  updated: "Product details saved.",
  variant: "Variant added.",
  "variant-updated": "Variant saved.",
  archived: "Product archived.",
  deactivated: "Variant deactivated.",
  received: "Stock receipt recorded.",
  adjusted: "Stock adjustment recorded.",
  "order-created": "Order created. It is Pending Verification and its stock is reserved.",
  confirm: "Order confirmed.",
  pack: "Order packed.",
  dispatch: "Order dispatched. Stock was deducted.",
  deliver: "Order marked delivered. Collection is recorded separately.",
  mark_rto: "Order marked for return to sender.",
  receive_rto: "Returned parcel received into inspection.",
  cancel: "Order cancelled. Any reserved stock was released.",
  close: "Order closed.",
  "request-approved": "Cancellation request approved. The order is cancelled.",
  "request-rejected": "Cancellation request rejected.",
  payment: "Payment recorded.",
  "rto-charge": "RTO charge recorded.",
  "return-created": "Return request recorded.",
  "return-step": "Return updated.",
  inspected: "Inspection recorded.",
  "link-revoked": "Tracking link revoked.",
  "zone-saved": "Delivery charge saved.",
  started: "Stock count started. The system quantities below are a snapshot; enter what you count.",
  "counts-saved": "Counted quantities saved. Nothing in stock has changed yet.",
  applied: "Stock count applied. Each difference was recorded as a stock adjustment.",
  discarded: "Stock count discarded. Nothing in stock changed.",
  "measurements-saved": "Size chart saved.",
  "category-created": "Category created.",
  "category-updated": "Category names saved.",
  "photo-uploaded": "Photo uploaded.",
  "photo-replaced": "Photo replaced. The old file was deleted.",
  "photo-described": "Photo descriptions saved.",
  "photo-moved": "Photo order saved.",
  "photo-removed": "Photo removed and its stored file deleted.",
};
export const noticeFor = (done: string | string[] | undefined) => (typeof done === "string" ? NOTICES[done] : undefined);
