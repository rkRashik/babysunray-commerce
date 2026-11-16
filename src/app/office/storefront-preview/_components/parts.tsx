import Link from "next/link";
import { Suspense } from "react";
import type { InstallationIdentity } from "@/config/installation";
import { dictionary, formatTaka, type Lang, localised } from "@/modules/storefront/i18n";
import type { PhotoRef, ProductCard } from "@/modules/storefront/service";
import { ConceptSwitch } from "./header-client";

// Server-rendered building blocks of the storefront preview (prototype layout, not an approved design).

export const base = (lang: Lang) => `/office/storefront-preview/${lang}`;

const LIST_KEYS = ["q", "category", "size", "colour", "stock", "page"];
/**
 * A product list query carried to a product page ("Back to results"): only the list's own parameters, each at most
 * 100 characters, rebuilt from scratch, so nothing else can travel in it. Empty when there is nothing to keep.
 */
export function listQuery(raw: string | undefined | null): string {
  if (!raw || raw.length > 600) return "";
  const kept = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(raw)) if (LIST_KEYS.includes(k) && v.length <= 100 && !kept.has(k)) kept.set(k, v);
  return kept.toString();
}

const WIDTHS = [320, 640, 1280];

/**
 * A product photo from the Owner-only media route, in the sizes the layout needs. The description is in the
 * chosen language, else the other one, else the product name: never empty, never invented.
 */
export function Photo({ photo, lang, name, sizes, className = "" }: { photo: PhotoRef; lang: Lang; name: string; sizes: string; className?: string }) {
  const widths = WIDTHS.filter((w) => w < photo.width);
  const alt = localised(lang, photo.altEn, photo.altBn) ?? localised(lang === "en" ? "bn" : "en", photo.altEn, photo.altBn) ?? name;
  return (
    // Photos are private (Owner session); Next.js image optimisation would fetch them without it.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/office/media/${photo.id}?w=${widths.includes(640) ? 640 : (widths.at(-1) ?? "")}`}
      srcSet={[...widths.map((w) => `/office/media/${photo.id}?w=${w} ${w}w`), `/office/media/${photo.id} ${photo.width}w`].join(", ")}
      sizes={sizes}
      width={photo.width}
      height={photo.height}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={`h-full w-full object-cover ${className}`}
    />
  );
}

/** Text in the chosen language; when it was not written, the other language marked as such (screen readers too). */
export function Localised({ lang, en, bn, missing }: { lang: Lang; en: string | null; bn: string | null; missing?: string }) {
  const value = localised(lang, en, bn);
  if (value !== null) return <>{value}</>;
  const other = lang === "en" ? "bn" : "en";
  const fallback = localised(other, en, bn);
  if (fallback === null) return <span className="text-sf-umber">{missing ?? "—"}</span>;
  return (
    <>
      <span lang={other}>{fallback}</span>
      {missing ? <span className="sr-only"> ({missing})</span> : null}
    </>
  );
}

const STOCK = { in: "inStock", partial: "someSizesOut", out: "soldOut" } as const;

export type ConceptName = "editorial" | "family" | "hybrid";

// Concept A: image-led tiles, a quiet name in the display face, price and stock in small text; the first featured
// product can lead at double size. Concept B: cards with a square photo, bold price, a stock badge and a visible
// "See options" cue (inside the one link, hidden from screen readers so the link name stays the product name).
export function ProductTile({ product, lang, from, concept = "editorial", lead = false }: { product: ProductCard; lang: Lang; from?: string; concept?: ConceptName; lead?: boolean }) {
  const t = dictionary(lang);
  const name = localised(lang, product.nameEn, product.nameBn) ?? localised(lang === "en" ? "bn" : "en", product.nameEn, product.nameBn) ?? product.slug;
  const price = product.minPricePaisa === product.maxPricePaisa ? formatTaka(product.minPricePaisa, lang) : t.from(formatTaka(product.minPricePaisa, lang));
  const href = `${base(lang)}/products/${product.slug}${from ? `?from=${encodeURIComponent(from)}` : ""}`;
  const out = product.stock === "out";
  const title = <Localised lang={lang} en={product.nameEn} bn={product.nameBn} missing={t.untitled} />;
  const photo = (sizes: string) =>
    product.photo ? <Photo photo={product.photo} lang={lang} name={name} sizes={sizes} /> : <div className="flex h-full items-end p-3 text-sm text-sf-umber">{t.noPhoto}</div>;
  if (concept === "hybrid") {
    // Concept C: A's photography-led tile and display face, B's clear price and stock badge; no extra button.
    return (
      <li>
        <Link href={href} className="group flex h-full flex-col rounded-sm">
          <div className="sf-card aspect-[4/5] overflow-hidden bg-sf-sand">{photo("(min-width: 1024px) 22vw, (min-width: 640px) 30vw, 46vw")}</div>
          <div className="flex flex-1 flex-col gap-1 pt-3">
            <p className="sf-display text-lg leading-snug group-hover:underline group-hover:underline-offset-4">{title}</p>
            <p className="font-semibold tabular-nums">{price}</p>
            <p className={`sf-pill mt-1 w-fit border px-2 py-0.5 text-sm ${out ? "border-sf-danger font-medium text-sf-danger" : "border-sf-line text-sf-umber"}`}>{t[STOCK[product.stock]]}</p>
          </div>
        </Link>
      </li>
    );
  }
  if (concept === "family") {
    return (
      <li>
        <Link href={href} className="sf-card group flex h-full flex-col overflow-hidden border border-sf-line bg-white">
          <div className="aspect-square overflow-hidden bg-sf-sand">{photo("(min-width: 1024px) 22vw, (min-width: 640px) 30vw, 46vw")}</div>
          <div className="flex flex-1 flex-col gap-1 p-3">
            <p className="font-semibold leading-snug group-hover:underline group-hover:underline-offset-4">{title}</p>
            <p className="text-lg font-bold tabular-nums">{price}</p>
            <p className={`sf-pill mt-auto w-fit border px-2 py-0.5 text-sm ${out ? "border-sf-danger font-medium text-sf-danger" : "border-sf-line"}`}>{t[STOCK[product.stock]]}</p>
            <span aria-hidden="true" className="sf-pill mt-2 inline-flex min-h-10 items-center justify-center bg-sf-cocoa px-3 text-sm font-semibold text-sf-ivory">
              {t.seeOptions}
            </span>
          </div>
        </Link>
      </li>
    );
  }
  return (
    <li className={lead ? "col-span-2 lg:row-span-2" : undefined}>
      <Link href={href} className="group block rounded-sm">
        <div className="aspect-[4/5] overflow-hidden bg-sf-sand">{photo(lead ? "(min-width: 1024px) 60vw, 92vw" : "(min-width: 1024px) 30vw, 46vw")}</div>
        <p className={`sf-display mt-3 leading-snug group-hover:underline group-hover:underline-offset-4 ${lead ? "text-2xl" : "text-lg"}`}>{title}</p>
        <p className="mt-1 text-sm tabular-nums">{price}</p>
        <p className={out ? "text-sm font-medium text-sf-danger" : "text-sm text-sf-umber"}>{t[STOCK[product.stock]]}</p>
      </Link>
    </li>
  );
}

export function ProductGrid({ products, lang, label, from, concept = "editorial", lead = false }: { products: ProductCard[]; lang: Lang; label: string; from?: string; concept?: ConceptName; lead?: boolean }) {
  const layout =
    concept === "family"
      ? "grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4"
      : concept === "hybrid"
        ? "grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 lg:gap-x-6"
        : "grid grid-cols-2 gap-x-5 gap-y-10 lg:grid-cols-3 lg:gap-x-8";
  return (
    <ul aria-label={label} className={layout}>
      {products.map((p, i) => (
        <ProductTile key={p.id} product={p} lang={lang} from={from} concept={concept} lead={lead && i === 0 && products.length > 2} />
      ))}
    </ul>
  );
}

export function PreviewBanner({ lang, concept }: { lang: Lang; concept: ConceptName }) {
  const t = dictionary(lang);
  return (
    <div className="bg-sf-amber text-sf-cocoa">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 text-sm">
        <p>
          <strong className="font-semibold" data-testid="preview-banner">{t.previewBanner}</strong> <span className="hidden sm:inline">{t.previewNote}</span>
        </p>
        <Suspense>
          <ConceptSwitch concept={concept} labels={{ label: t.conceptLabel, editorial: t.conceptEditorial, family: t.conceptFamily, hybrid: t.conceptHybrid }} />
        </Suspense>
        <Link href="/office" className="font-medium underline underline-offset-2">
          {t.backToOffice}
        </Link>
      </div>
    </div>
  );
}

export function Footer({ lang, identity }: { lang: Lang; identity: InstallationIdentity }) {
  const t = dictionary(lang);
  const line = localised(lang, identity.storeLine.en, identity.storeLine.bn);
  const contact = [identity.contact.phone, identity.contact.email].filter(Boolean).join(" · ");
  return (
    <footer className="mt-16 border-t border-sf-line">
      <div className="mx-auto max-w-6xl space-y-2 px-4 py-8 text-sm text-sf-umber">
        {line ? <p>{line}</p> : null}
        {contact ? (
          <p data-testid="store-contact">
            {t.contactLabel}: <span lang="en">{contact}</span>
          </p>
        ) : null}
        <p>{t.policiesPending}</p>
        <p>{t.prototypeNote}</p>
      </div>
    </footer>
  );
}
