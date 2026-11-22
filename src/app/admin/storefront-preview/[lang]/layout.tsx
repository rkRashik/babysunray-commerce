import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { flFontVariables } from "@/app/_design/fonts";
import { currentStoreIdentity } from "@/app/_design/identity";
import { getDb } from "@/db/client";
import { enabledPaymentMethods } from "@/modules/settings/payments";
import { dictionary, isLang } from "@/modules/storefront/i18n";
import { previewFacets } from "@/modules/storefront/service";
import { requireAdmin } from "../../_lib/session";
import { quoteCartAction, simulateCheckoutAction } from "../actions";
import { SfFrame } from "../_components/frame";
import { Header } from "../_components/header";
import { TabBar } from "../_components/header-client";
import { Footer, PreviewStrip } from "../_components/parts";

export const metadata = { title: "Storefront preview · Admin" };
// The page may draw under a phone's rounded corners and home indicator; the bars keep clear of them (safe-area insets).
export const viewport: Viewport = { viewportFit: "cover", themeColor: "#f9f6f1" };

// The private storefront preview (Owner only, `storefront:preview`). It lives under /admin, so every response
// carries Admin's private headers (no framing, noindex, no-store); each page and action also checks the
// session itself, since a layout check alone is not access control. The frame's `lang` gives screen readers
// and fonts the chosen language.
export default async function PreviewLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const principal = await requireAdmin("storefront:preview");
  const [facets, payments] = await Promise.all([previewFacets(getDb(), principal), enabledPaymentMethods(getDb())]);
  const t = dictionary(lang);
  const identity = await currentStoreIdentity();
  // The installation's colours (validated for contrast) replace ink, sun and paper for this subtree.
  const theme = { "--color-sf-ink": identity.theme.ink, "--color-sf-sun": identity.theme.accent, "--color-sf-paper": identity.theme.paper } as React.CSSProperties;
  return (
    <SfFrame
      lang={lang}
      className={`sf ${flFontVariables} flex min-h-dvh flex-col`}
      style={theme}
      surface="preview"
      actions={{ quote: quoteCartAction, check: simulateCheckoutAction }}
      payments={payments.map((p) => p.method)}
    >
      <a href="#sf-main" className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-full focus:bg-sf-card focus:px-5 focus:py-3 focus:shadow-lg">
        {t.skip}
      </a>
      <PreviewStrip lang={lang} />
      <Header lang={lang} facets={facets} storeName={identity.storeName} logo={identity.logo} surface="preview" />
      <main id="sf-main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 pt-5 pb-4 focus:outline-none lg:px-8 lg:pt-10">
        {children}
      </main>
      <Footer lang={lang} identity={identity} facets={facets} surface="preview" />
      <TabBar lang={lang} categories={facets.categories} />
    </SfFrame>
  );
}
