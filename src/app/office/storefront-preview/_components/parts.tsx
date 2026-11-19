import { Banknote, Lock, Truck } from "lucide-react";
import Link from "next/link";
import { SunMark } from "@/app/_design/sun-mark";
import type { InstallationIdentity } from "@/config/installation";
import { type CdnImages, cdnConfig, cdnImages } from "@/modules/media/cdn";
import { dictionary, formatTaka, type Lang, localised, toBnDigits } from "@/modules/storefront/i18n";
import type { Facets, PhotoRef, ProductCard } from "@/modules/storefront/service";
import { NoPhoto } from "./no-photo";

export { NoPhoto };

// Server-rendered building blocks of the First Light storefront (docs/design/storefront-design-system.md): the arch photo,
// the product card, grid and rail, section headings, the trust lines and the ordering steps, the preview strip and the
// footer. The preview is Owner-only.

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

/** The garment tints: a calm ground behind each product, the same one every time for the same product. */
const TINTS = ["bg-sf-peach", "bg-sf-butter", "bg-sf-sage", "bg-sf-sky", "bg-sf-blush"];
export function tintFor(key: string): string {
  let sum = 0;
  for (const ch of key) sum = (sum + ch.charCodeAt(0)) % 997;
  return TINTS[sum % TINTS.length];
}

const WIDTHS = [320, 640, 1280];

/**
 * The Cloudinary delivery of a photo, only when the photo has a recorded CDN copy (which exists only while its product is
 * published, src/modules/media/cdn-sync.ts) and Cloudinary is configured; otherwise null and the Owner-only media route
 * serves the photo. A draft photo is therefore never delivered from the CDN.
 */
export function cdnFor(photo: { cdnPublicId?: string | null }): CdnImages | null {
  const configured = cdnConfig(process.env);
  return configured.ok && configured.config && photo.cdnPublicId ? cdnImages(configured.config, photo.cdnPublicId) : null;
}

/** The product's name in the chosen language, else the other one, else its slug: never empty, never invented. */
export const productName = (lang: Lang, p: { nameEn: string | null; nameBn: string | null; slug: string }) =>
  localised(lang, p.nameEn, p.nameBn) ?? localised(lang === "en" ? "bn" : "en", p.nameEn, p.nameBn) ?? p.slug;

/**
 * A product photo, in the sizes the layout needs: from the CDN when the photo has a copy there, else from the Owner-only
 * media route. The width and height attributes reserve the space, so nothing shifts when it loads. The description is in
 * the chosen language, else the other one, else the product name: never empty, never invented. Inside a link that already
 * names the product in text (a card, a tile), the photo is `decorative`, so the link is read once, by its visible name.
 */
export function Photo({ photo, lang, name, sizes, className = "", priority = false, decorative = false }: { photo: PhotoRef; lang: Lang; name: string; sizes: string; className?: string; priority?: boolean; decorative?: boolean }) {
  const widths = WIDTHS.filter((w) => w < photo.width);
  const alt = decorative ? "" : (localised(lang, photo.altEn, photo.altBn) ?? localised(lang === "en" ? "bn" : "en", photo.altEn, photo.altBn) ?? name);
  const cdn = cdnFor(photo);
  return (
    // Photos are private (Owner session); Next.js image optimisation would fetch them without it, and a CDN copy is already optimised.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cdn ? cdn.src : `/office/media/${photo.id}?w=${widths.includes(640) ? 640 : (widths.at(-1) ?? "")}`}
      srcSet={cdn ? cdn.srcSet : [...widths.map((w) => `/office/media/${photo.id}?w=${w} ${w}w`), `/office/media/${photo.id} ${photo.width}w`].join(", ")}
      sizes={sizes}
      width={photo.width}
      height={photo.height}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      className={className}
    />
  );
}

/** Text in the chosen language; when it was not written, the other language marked as such (screen readers too). */
export function Localised({ lang, en, bn, missing }: { lang: Lang; en: string | null; bn: string | null; missing?: string }) {
  const value = localised(lang, en, bn);
  if (value !== null) return <>{value}</>;
  const other = lang === "en" ? "bn" : "en";
  const fallback = localised(other, en, bn);
  if (fallback === null) return <span className="text-sf-ink-2">{missing ?? "—"}</span>;
  return (
    <>
      <span lang={other}>{fallback}</span>
      {missing ? <span className="sr-only"> ({missing})</span> : null}
    </>
  );
}

/** A product card: the photograph in its arch leads, then the name and the price. Stock is said only when something is sold out. */
export function ProductTile({ product, lang, from, priority = false, sizes, className = "" }: { product: ProductCard; lang: Lang; from?: string; priority?: boolean; sizes?: string; className?: string }) {
  const t = dictionary(lang);
  const name = productName(lang, product);
  const price = product.minPricePaisa === product.maxPricePaisa ? formatTaka(product.minPricePaisa, lang) : t.from(formatTaka(product.minPricePaisa, lang));
  const href = `${base(lang)}/products/${product.slug}${from ? `?from=${encodeURIComponent(from)}` : ""}`;
  const out = product.stock === "out";
  return (
    <li className={`min-w-0 ${className}`}>
      <Link href={href} className="group block rounded-[1.375rem]">
        <div className={`sf-photo sf-arch aspect-[4/5] ${tintFor(product.id)}`}>
          {product.photo ? (
            <Photo
              photo={product.photo}
              lang={lang}
              name={name}
              sizes={sizes ?? "(min-width: 1024px) 22vw, (min-width: 640px) 31vw, 46vw"}
              priority={priority}
              decorative
              className={`transition-transform duration-500 ease-out group-hover:scale-[1.03] ${out ? "opacity-70 grayscale-[35%]" : ""}`}
            />
          ) : (
            <NoPhoto label={t.noPhoto} />
          )}
          {out ? (
            <span className="sf-badge absolute top-[14%] start-1/2 -translate-x-1/2 rtl:translate-x-1/2" data-tone="out" data-testid="card-sold-out">
              {t.soldOut}
            </span>
          ) : null}
        </div>
        <div className="space-y-1 px-1 pt-3">
          <p className="line-clamp-2 text-[0.9375rem] leading-snug font-semibold group-hover:underline group-hover:decoration-sf-sun group-hover:decoration-2 group-hover:underline-offset-4">
            <Localised lang={lang} en={product.nameEn} bn={product.nameBn} missing={t.untitled} />
          </p>
          <p className={`sf-price text-[1.0625rem] ${out ? "text-sf-ink-2" : ""}`}>{price}</p>
          {product.stock === "partial" ? (
            <p>
              <span className="sf-badge" data-tone="info">
                {t.someSizesOut}
              </span>
            </p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

export function ProductGrid({ products, lang, label, from, priorityCount = 0 }: { products: ProductCard[]; lang: Lang; label: string; from?: string; priorityCount?: number }) {
  return (
    <ul aria-label={label} className="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4 lg:gap-x-6 lg:gap-y-10">
      {products.map((p, i) => (
        <ProductTile key={p.id} product={p} lang={lang} from={from} priority={i < priorityCount} />
      ))}
    </ul>
  );
}

/** A row of products that scrolls sideways on a phone and becomes a grid on a desktop. */
export function ProductRail({ products, lang, label }: { products: ProductCard[]; lang: Lang; label: string }) {
  return (
    <ul aria-label={label} className="sf-rail lg:mx-0 lg:grid lg:grid-cols-4 lg:gap-x-6 lg:gap-y-10 lg:overflow-visible lg:px-0">
      {products.map((p) => (
        <ProductTile key={p.id} product={p} lang={lang} sizes="(min-width: 1024px) 22vw, 44vw" className="w-[42vw] max-w-[13.5rem] sm:w-[30vw] lg:w-auto lg:max-w-none" />
      ))}
    </ul>
  );
}

/** A section heading in the display face, with an optional link on the far side, both on one baseline. */
export function SectionHeading({ id, title, action }: { id: string; title: string; action?: { href: string; label: string } }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4 lg:mb-7">
      <h2 id={id} className="text-[1.75rem] lg:text-[2.5rem]">
        {title}
      </h2>
      {action ? (
        <Link href={action.href} className="sf-link -my-3 inline-flex min-h-11 shrink-0 items-center text-[0.9375rem]">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/** The Owner's reminder that this is a preview: one quiet line above the shop, outside its design. */
export function PreviewStrip({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  return (
    <div className="sf-on-dark bg-sf-ink text-[0.8125rem] text-sf-paper">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 lg:px-8">
        <p className="flex min-w-0 items-center gap-2 py-1.5">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-sf-sun-glow" />
          <strong className="truncate font-semibold" data-testid="preview-banner">
            {t.previewBanner}
          </strong>
          <span className="hidden truncate text-sf-paper/80 lg:inline">{t.previewNote}</span>
        </p>
        <Link href="/office" className="inline-flex min-h-8 shrink-0 items-center font-semibold underline decoration-sf-sun-glow underline-offset-4">
          {t.backToOffice}
        </Link>
      </div>
    </div>
  );
}

/** Three plain promises, each an approved rule: cash on delivery, the charge before ordering, a private tracking link. */
export function TrustLines({ lang, className = "" }: { lang: Lang; className?: string }) {
  const t = dictionary(lang);
  const items = [
    { icon: Banknote, text: t.trustCod },
    { icon: Truck, text: t.trustCharge },
    { icon: Lock, text: t.trustTrack },
  ];
  return (
    <ul className={`grid gap-3 lg:grid-cols-3 lg:gap-4 ${className}`} aria-label={t.deliveryAndPayment}>
      {items.map(({ icon: Icon, text }) => (
        <li key={text} className="flex items-center gap-3.5 lg:rounded-[1.25rem] lg:border lg:border-sf-line lg:bg-sf-card lg:px-5 lg:py-4">
          <span aria-hidden="true" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sf-card text-sf-sun-deep lg:bg-sf-sun-soft">
            <Icon size={22} strokeWidth={1.75} />
          </span>
          <span className="font-semibold leading-snug">{text}</span>
        </li>
      ))}
    </ul>
  );
}

/** How ordering works, in three numbered steps (the approved order rules, said plainly). */
export function HowToOrder({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  const n = (i: number) => (lang === "bn" ? toBnDigits(i) : String(i));
  return (
    <section aria-labelledby="sf-how" className="rounded-[2rem] border border-sf-line bg-sf-card px-5 py-8 lg:grid lg:grid-cols-[1fr_3fr] lg:items-center lg:gap-10 lg:px-12 lg:py-11">
      <h2 id="sf-how" className="mb-5 text-[1.75rem] lg:mb-0 lg:text-[2.25rem]">
        {t.howTitle}
      </h2>
      <ol className="grid gap-4 lg:grid-cols-3 lg:gap-8">
        {t.howSteps.map((step, i) => (
          <li key={step} className="flex items-start gap-3.5">
            <span className="sf-step-num h-10 w-10 text-base" data-state="current" aria-hidden="true">
              {n(i + 1)}
            </span>
            <span className="pt-1.5 font-semibold leading-snug">{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Footer({ lang, identity, facets }: { lang: Lang; identity: InstallationIdentity; facets: Facets }) {
  const t = dictionary(lang);
  const other = lang === "en" ? "bn" : "en";
  const lineHere = localised(lang, identity.storeLine.en, identity.storeLine.bn);
  const line = lineHere ?? localised(other, identity.storeLine.en, identity.storeLine.bn);
  const contact = [identity.contact.phone, identity.contact.email].filter(Boolean);
  const link = "inline-flex min-h-11 items-center text-sf-paper/85 hover:text-sf-paper hover:underline hover:decoration-sf-sun-glow hover:underline-offset-4";
  return (
    <footer className="sf-on-dark mt-16 bg-sf-ink text-sf-paper lg:mt-24">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 pt-12 pb-8 lg:grid-cols-[1.6fr_1fr_1fr] lg:px-8 lg:pt-16">
        <div className="space-y-4">
          <SunMark className="h-6 w-10 text-sf-sun-glow" />
          <p className="fl-wordmark text-[1.75rem]">{identity.storeName}</p>
          {line ? (
            <p lang={lineHere === null ? other : undefined} className="max-w-sm text-sf-paper/85">
              {line}
            </p>
          ) : null}
        </div>
        <nav aria-label={t.mainNav}>
          <h2 className="sf-plain mb-2 text-[0.9375rem] text-sf-sun-glow">{t.mainNav}</h2>
          <ul>
            <li>
              <Link href={`${base(lang)}/products`} className={link}>
                {t.shopAll}
              </Link>
            </li>
            {facets.categories.map((c) => (
              <li key={c.slug}>
                <Link href={`${base(lang)}/products?category=${c.slug}`} className={link}>
                  <Localised lang={lang} en={c.nameEn} bn={c.nameBn} />
                </Link>
              </li>
            ))}
            <li>
              <Link href={`${base(lang)}/order`} className={link}>
                {t.tabOrder}
              </Link>
            </li>
          </ul>
        </nav>
        <div className="space-y-3">
          <h2 className="sf-plain text-[0.9375rem] text-sf-sun-glow">{t.deliveryAndPayment}</h2>
          <p className="text-sf-paper/85">{t.cod}</p>
          {contact.length ? (
            <p data-testid="store-contact">
              {t.contactLabel}:{" "}
              {contact.map((c, i) => (
                <span key={c} lang="en">
                  {i ? ", " : ""}
                  {c}
                </span>
              ))}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mx-auto max-w-7xl space-y-1 border-t border-sf-paper/15 px-4 py-5 text-[0.8125rem] text-sf-paper/75 lg:px-8">
        <p>{t.policiesPending}</p>
        <p>{t.prototypeNote}</p>
      </div>
    </footer>
  );
}
