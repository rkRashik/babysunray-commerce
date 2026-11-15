import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { dictionary, isLang } from "@/modules/storefront/i18n";
import { previewFacets } from "@/modules/storefront/service";
import { requireOffice } from "../../_lib/session";
import { Header } from "../_components/header";
import { Footer, PreviewBanner } from "../_components/parts";

export const metadata = { title: "Storefront preview · Owner Office" };

// The private storefront preview (Owner only, `storefront:preview`). It lives under /office, so every response
// carries the Office's private headers (no framing, noindex, no-store); each page and action also checks the
// session itself, since a layout check alone is not access control. The wrapper's `lang` gives screen readers
// and fonts the chosen language.
export default async function PreviewLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const principal = await requireOffice("storefront:preview");
  const facets = await previewFacets(getDb(), principal);
  const t = dictionary(lang);
  return (
    <div lang={lang} className="sf min-h-screen bg-sf-ivory text-sf-cocoa">
      <a href="#sf-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded-sm focus:bg-white focus:px-3 focus:py-2">
        {t.skip}
      </a>
      <PreviewBanner lang={lang} />
      <Header lang={lang} facets={facets} />
      <main id="sf-main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8 focus:outline-none">
        {children}
      </main>
      <Footer lang={lang} />
    </div>
  );
}
