import type { Viewport } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { flFontVariables } from "@/app/_design/fonts";
import { requireShop } from "@/app/_shop/access";
import { SfFrame } from "@/app/office/storefront-preview/_components/frame";
import { Header } from "@/app/office/storefront-preview/_components/header";
import { TabBar } from "@/app/office/storefront-preview/_components/header-client";
import { AcceptanceStrip, Footer } from "@/app/office/storefront-preview/_components/parts";
import { installationIdentity } from "@/config/installation";
import { getDb } from "@/db/client";
import { currentCustomer, customerSignInAvailable } from "@/modules/customers/server";
import { publishedPolicies } from "@/modules/policies/publication";
import { dictionary, isLang } from "@/modules/storefront/i18n";
import { catalogueFacets, PUBLIC_SCOPE } from "@/modules/storefront/service";
import { checkShopCheckoutAction, quoteShopCartAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };
export const viewport: Viewport = { viewportFit: "cover", themeColor: "#f9f6f1" };

// The real shop (ADR-0011): published products only, real carts, real orders, the same First Light components as the
// Owner's preview. It exists only while the shop is open for this request (src/modules/launch/acceptance.ts): a founder
// acceptance pass on the staging database now, the public launch gate later. Closed, every page is a plain 404. Each page,
// Server Action and route checks access itself; this layout's check is not access control.
export default async function ShopLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const access = await requireShop();
  const db = getDb();
  const [facets, published, customer] = await Promise.all([catalogueFacets(db, PUBLIC_SCOPE), publishedPolicies(db), currentCustomer(await headers()).catch(() => null)]);
  const policies = published.map((p) => ({ kind: p.kind, href: `/${lang}/policies/${p.kind}` }));
  const t = dictionary(lang);
  const identity = installationIdentity();
  const theme = { "--color-sf-ink": identity.theme.ink, "--color-sf-sun": identity.theme.accent, "--color-sf-paper": identity.theme.paper } as React.CSSProperties;
  return (
    <SfFrame
      lang={lang}
      className={`sf ${flFontVariables} flex min-h-dvh flex-col`}
      style={theme}
      surface="shop"
      actions={{ quote: quoteShopCartAction, check: checkShopCheckoutAction }}
      customer={customer ? { name: customer.name } : null}
      policies={policies}
      signIn={customerSignInAvailable()}
    >
      <a href="#sf-main" className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-full focus:bg-sf-card focus:px-5 focus:py-3 focus:shadow-lg">
        {t.skip}
      </a>
      {access === "acceptance" ? <AcceptanceStrip lang={lang} /> : null}
      <Header lang={lang} facets={facets} storeName={identity.storeName} surface="shop" />
      <main id="sf-main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 pt-5 pb-4 focus:outline-none lg:px-8 lg:pt-10">
        {children}
      </main>
      <Footer lang={lang} identity={identity} facets={facets} surface="shop" policies={policies} />
      <TabBar lang={lang} categories={facets.categories} />
    </SfFrame>
  );
}
