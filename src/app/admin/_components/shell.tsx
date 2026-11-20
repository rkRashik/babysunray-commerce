import {
  BarChart3,
  ClipboardCheck,
  ClipboardList,
  Eye,
  FileDown,
  FileText,
  FolderTree,
  ImageIcon,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  PackageCheck,
  Rocket,
  Shirt,
  Store,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { BrandMark } from "@/app/_design/brand";
import { flFontVariables } from "@/app/_design/fonts";
import { currentStoreIdentity } from "@/app/_design/identity";
import { DEFAULT_STORE_NAME } from "@/config/installation";
import { SignOutButton } from "./auth-forms";
import { Toast } from "./toast";
import { AdminMenu } from "./admin-menu";

type Crumb = { href: string; label: string; lang?: string };
type Current = "dashboard" | "products" | "preparation" | "reviews" | "categories" | "orders" | "delivery" | "reports" | "counts" | "exports" | "media" | "preview" | "policies" | "launch" | "acceptance" | "onboarding" | "store" | "publication" | "security";

// Admin's navigation, grouped by the work it serves. Every Admin screen is reachable from here.
const NAV: { group: string; items: { key: Current; href: string; label: string; icon: LucideIcon }[] }[] = [
  {
    group: "Daily work",
    items: [
      { key: "dashboard", href: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { key: "orders", href: "/admin/orders", label: "Orders", icon: ClipboardList },
      { key: "counts", href: "/admin/stock-counts", label: "Stock counts", icon: PackageCheck },
    ],
  },
  {
    group: "Catalogue",
    items: [
      { key: "products", href: "/admin", label: "Products", icon: Shirt },
      { key: "preparation", href: "/admin/catalogue-preparation", label: "Catalogue checklist", icon: ListChecks },
      { key: "reviews", href: "/admin/product-reviews", label: "Product reviews", icon: ClipboardCheck },
      { key: "categories", href: "/admin/categories", label: "Categories", icon: FolderTree },
      { key: "media", href: "/admin/media-health", label: "Photo storage", icon: ImageIcon },
    ],
  },
  {
    group: "Money and records",
    items: [
      { key: "reports", href: "/admin/reports", label: "Reports", icon: BarChart3 },
      { key: "exports", href: "/admin/exports", label: "Exports", icon: FileDown },
    ],
  },
  {
    group: "Settings",
    items: [
      { key: "onboarding", href: "/admin/onboarding", label: "Store setup", icon: ListChecks },
      { key: "store", href: "/admin/settings/store", label: "Store settings", icon: Store },
      { key: "delivery", href: "/admin/settings/delivery", label: "Delivery charges", icon: Truck },
      { key: "publication", href: "/admin/settings/publication", label: "Publication requirements", icon: ClipboardCheck },
      { key: "security", href: "/admin/settings/security", label: "Account security", icon: KeyRound },
    ],
  },
  {
    group: "Shop",
    items: [
      { key: "preview", href: "/admin/storefront-preview", label: "Storefront preview", icon: Eye },
      { key: "policies", href: "/admin/policies", label: "Policies", icon: FileText },
      { key: "acceptance", href: "/admin/acceptance", label: "Shop acceptance", icon: Store },
      { key: "launch", href: "/admin/launch-readiness", label: "Launch readiness", icon: Rocket },
    ],
  },
];

/** The First Light surface of Admin: its fonts and its remapped palette (globals.css, `.of`). */
export const adminSurface = `of ${flFontVariables}`;

// The three pages the Owner uses all day, always one tap away on a phone (bottom bar); everything else is in its "Menu".
const QUICK: Current[] = ["dashboard", "orders", "products"];

// Admin layout (First Light, the professional side of the system): a cocoa sidebar on a desktop; on a phone a
// slim top bar, and a bottom bar (Dashboard, Orders, Products, Menu) under the thumb. The Menu lists every page, grouped,
// in large rows with their icons.
export async function AdminShell({
  title,
  titleLang,
  children,
  notice,
  breadcrumbs = [],
  current,
  actions,
  wide = false,
}: {
  title: string;
  /** A wider page for data tables (Orders, Products, Reports). */
  wide?: boolean;
  /** "bn" when the title is a Bangla product name. */
  titleLang?: string;
  children: React.ReactNode;
  notice?: string;
  /** Where this page sits, from Products down; the page itself is the title. */
  breadcrumbs?: Crumb[];
  current?: Current;
  /** Buttons or links beside the title (the page's main actions). */
  actions?: React.ReactNode;
}) {
  const identity = await currentStoreIdentity();
  // The installation's own name (Store settings, else STORE_NAME). Only a store with no name at all shows a neutral
  // placeholder and a link to set it, never a made-up brand.
  const named = identity.storeName !== DEFAULT_STORE_NAME;
  const storeName = named ? identity.storeName : "Your store";
  return (
    <div className={`${adminSurface} min-h-screen lg:flex`}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:shadow-lg"
      >
        Skip to content
      </a>
      <aside className="z-30 bg-of-night text-[#eadfcf] lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col">
        <div className="flex items-center gap-3 px-4 py-3 lg:px-5 lg:pt-6 lg:pb-5">
          <span className="inline-flex shrink-0 items-center justify-center rounded-xl bg-sf-paper p-1">
            <BrandMark name={storeName} size={34} />
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate font-bold text-white">{storeName}</p>
            {named ? (
              <p className="text-[0.8125rem] text-[#bfae9b]">Admin</p>
            ) : (
              <Link href="/admin/settings/store" className="text-[0.8125rem] whitespace-nowrap text-[#e3c77e] underline underline-offset-2">
                Set store name
              </Link>
            )}
          </div>
          <SignOutButton dark />
        </div>
        <nav aria-label="Admin" className="of-scroll hidden lg:block lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-3 lg:pb-5">
          <ul className="space-y-4">
            {NAV.map(({ group, items }) => (
              <li key={group}>
                <p className="px-3 pb-1.5 text-[0.75rem] font-semibold tracking-wide text-[#bfae9b]">{group}</p>
                <ul className="space-y-0.5">
                  {items.map(({ key, href, label, icon: Icon }) => (
                    <li key={key}>
                      <Link href={href} aria-current={current === key ? "page" : undefined} className="of-nav-link">
                        <Icon aria-hidden="true" size={18} strokeWidth={1.75} className="shrink-0" />
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <nav aria-label="Quick links" className="of-bar lg:hidden">
        <ul className="mx-auto grid h-[var(--of-bar-h)] max-w-lg grid-cols-4">
          {NAV.flatMap((g) => g.items)
            .filter((i) => QUICK.includes(i.key))
            .sort((a, b) => QUICK.indexOf(a.key) - QUICK.indexOf(b.key))
            .map(({ key, href, label, icon: Icon }) => (
              <li key={key}>
                <Link href={href} aria-current={current === key ? "page" : undefined} className="of-tab">
                  <Icon aria-hidden="true" size={24} strokeWidth={1.75} />
                  <span>{label}</span>
                </Link>
              </li>
            ))}
          <li>
            <AdminMenu title="All pages" closeLabel="Close menu" label="Menu" highlighted={current !== undefined && !QUICK.includes(current)}>
              <nav aria-label="Admin">
                {NAV.map(({ group, items }) => (
                  <div key={group} className="pb-2">
                    <p className="px-3 pt-3 pb-1 text-[0.8125rem] font-semibold text-gray-600">{group}</p>
                    <ul>
                      {items.map(({ key, href, label, icon: Icon }) => (
                        <li key={key}>
                          <Link href={href} aria-current={current === key ? "page" : undefined} className="of-menu-link">
                            <Icon aria-hidden="true" size={22} strokeWidth={1.75} className="shrink-0 text-gray-600" />
                            {label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
            </AdminMenu>
          </li>
        </ul>
      </nav>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
        <div className={`mx-auto ${wide ? "max-w-[78rem]" : "max-w-5xl"} space-y-6 px-4 pt-6 pb-[calc(var(--of-bar-h)+2.5rem)] lg:px-10 lg:pt-10 lg:pb-16`}>
          <div className="space-y-2">
            {breadcrumbs.length ? (
              <nav aria-label="Breadcrumb" className="text-sm text-gray-600">
                <ol className="flex flex-wrap items-center gap-1">
                  {breadcrumbs.map((crumb) => (
                    <li key={crumb.href} className="flex items-center gap-1">
                      <Link href={crumb.href} lang={crumb.lang} className="rounded font-medium text-gray-700 underline-offset-4 hover:underline">
                        {crumb.label}
                      </Link>
                      <span aria-hidden="true">›</span>
                    </li>
                  ))}
                </ol>
              </nav>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 lang={titleLang} className="text-[1.625rem] leading-tight font-bold tracking-[-0.01em] break-words lg:text-[1.875rem]">
                {title}
              </h1>
              {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
            </div>
          </div>
          {notice ? <Toast message={notice} /> : null}
          {children}
        </div>
      </main>
    </div>
  );
}

/** A titled panel; the heading names the region for assistive technology. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="of-card space-y-4 p-5 lg:p-6">
      <h2 id={id} className="text-[1.0625rem] font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const dhaka = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });
/** Stored in UTC, shown in Bangladesh time. */
export const formatTime = (date: Date) => `${dhaka.format(date)} (Dhaka)`;

/** Product title as shown in Admin: English name, else Bangla name (marked as Bangla), else the slug. */
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
  reviewed: "Review recorded for the content as it is now. Nothing was published.",
  published: "Published. Customers who can open the shop see this product now; its photos are being copied to the image CDN.",
  withdrawn: "Withdrawn. The product is a draft again and no longer in the shop; its CDN photo copies are being removed.",
  policyPublished: "Published. Customers who can open the shop now see this policy, exactly as you approved it.",
  policyWithdrawn: "Withdrawn. Customers no longer see this policy.",
  acceptanceStarted: "Acceptance started in this browser for a few hours. Open the shop below.",
  acceptanceEnded: "Acceptance ended in this browser. The shop is closed to it again.",
  storeSaved: "Store settings saved.",
  logoSaved: "Logo saved.",
  logoRemoved: "Logo removed.",
  ruleApproved: "Publication requirements approved. Products that meet them can now be published.",
  "policy-saved": "Draft saved. It is private and not published.",
  "policy-reviewed": "Marked as reviewed by you. This is not publication or legal approval.",
};
export const noticeFor = (done: string | string[] | undefined) => (typeof done === "string" ? NOTICES[done] : undefined);
