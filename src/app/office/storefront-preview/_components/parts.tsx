import Link from "next/link";
import { dictionary, formatTaka, type Lang, localised } from "@/modules/storefront/i18n";
import type { PhotoRef, ProductCard } from "@/modules/storefront/service";

// Server-rendered building blocks of the storefront preview (prototype layout, not an approved design).

export const base = (lang: Lang) => `/office/storefront-preview/${lang}`;

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

export function ProductTile({ product, lang }: { product: ProductCard; lang: Lang }) {
  const t = dictionary(lang);
  const name = localised(lang, product.nameEn, product.nameBn) ?? localised(lang === "en" ? "bn" : "en", product.nameEn, product.nameBn) ?? product.slug;
  const price = product.minPricePaisa === product.maxPricePaisa ? formatTaka(product.minPricePaisa, lang) : t.from(formatTaka(product.minPricePaisa, lang));
  return (
    <li>
      <Link href={`${base(lang)}/products/${product.slug}`} className="group block rounded-sm">
        <div className="aspect-[4/5] overflow-hidden rounded-sm bg-sf-sand">
          {product.photo ? (
            <Photo photo={product.photo} lang={lang} name={name} sizes="(min-width: 1024px) 22vw, (min-width: 640px) 30vw, 46vw" />
          ) : (
            <div className="flex h-full items-end p-3 text-sm text-sf-umber">{t.noPhoto}</div>
          )}
        </div>
        <p className="mt-2 font-medium leading-snug group-hover:underline group-hover:underline-offset-4">
          <Localised lang={lang} en={product.nameEn} bn={product.nameBn} missing={t.untitled} />
        </p>
        <p className="tabular-nums">{price}</p>
        <p className={product.stock === "out" ? "text-sm font-medium text-sf-danger" : "text-sm text-sf-umber"}>{t[STOCK[product.stock]]}</p>
      </Link>
    </li>
  );
}

export function ProductGrid({ products, lang, label }: { products: ProductCard[]; lang: Lang; label: string }) {
  return (
    <ul aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((p) => (
        <ProductTile key={p.id} product={p} lang={lang} />
      ))}
    </ul>
  );
}

export function PreviewBanner({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  return (
    <div className="bg-sf-amber text-sf-cocoa">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm">
        <p>
          <strong className="font-semibold" data-testid="preview-banner">{t.previewBanner}</strong> <span>{t.previewNote}</span>
        </p>
        <Link href="/office" className="font-medium underline underline-offset-2">
          {t.backToOffice}
        </Link>
      </div>
    </div>
  );
}

export function Footer({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  return (
    <footer className="mt-16 border-t border-sf-line">
      <div className="mx-auto max-w-6xl space-y-2 px-4 py-8 text-sm text-sf-umber">
        <p>{t.storeLine}</p>
        <p>{t.policiesPending}</p>
        <p>{t.prototypeNote}</p>
      </div>
    </footer>
  );
}
