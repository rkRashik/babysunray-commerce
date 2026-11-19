"use client";

import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CdnImages } from "@/modules/media/cdn";
import { dictionary, type Lang, localised, toBnDigits } from "@/modules/storefront/i18n";
import type { PhotoRef } from "@/modules/storefront/service";
import { NoPhoto } from "./no-photo";

/** A photo with its Cloudinary delivery when it has a copy there (only while its product is published). */
export type GalleryPhoto = PhotoRef & { cdn?: CdnImages | null };

// The product's photographs (Embla carousel) in the arch, First Light's frame. On a phone: swiped with a finger, with dots
// under the arch and a counter. On a desktop: with arrows and a row of small arches as thumbnails. Thumbnails are buttons (aria-pressed); the arrow keys, Home and
// End move between them and show that photo. A file that cannot be loaded becomes a plain "photo unavailable" panel. One
// photo: no controls at all. No photo: the same shape with "No photo yet".

const WIDTHS = [320, 640, 1280];

function src(photo: GalleryPhoto, width: number) {
  if (photo.cdn) return width <= 320 ? photo.cdn.srcSet.split(", ")[0].split(" ")[0] : photo.cdn.src;
  return width < photo.width ? `/office/media/${photo.id}?w=${width}` : `/office/media/${photo.id}`;
}

function srcSet(photo: GalleryPhoto) {
  if (photo.cdn) return photo.cdn.srcSet;
  return [...WIDTHS.filter((w) => w < photo.width).map((w) => `/office/media/${photo.id}?w=${w} ${w}w`), `/office/media/${photo.id} ${photo.width}w`].join(", ");
}

export function Gallery({ lang, photos, name }: { lang: Lang; photos: GalleryPhoto[]; name: string }) {
  const t = dictionary(lang);
  const [viewport, embla] = useEmblaCarousel({ align: "start", skipSnaps: false, duration: 24 });
  const [current, setCurrent] = useState(0);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const n = (i: number) => (lang === "bn" ? toBnDigits(i) : String(i));
  const alt = (p: GalleryPhoto) => localised(lang, p.altEn, p.altBn) ?? localised(lang === "en" ? "bn" : "en", p.altEn, p.altBn) ?? name;
  const fail = (id: string) => setBroken((b) => new Set(b).add(id));
  const count = photos.length;

  useEffect(() => {
    if (!embla) return;
    const onSelect = () => setCurrent(embla.selectedScrollSnap());
    embla.on("select", onSelect).on("reInit", onSelect);
    return () => {
      embla.off("select", onSelect).off("reInit", onSelect);
    };
  }, [embla]);

  const show = useCallback(
    (to: number, focus = false) => {
      const next = (to + count) % count;
      setCurrent(next);
      embla?.scrollTo(next);
      if (focus) thumbs.current[next]?.focus();
    },
    [embla, count],
  );

  if (count === 0) {
    return (
      <div className="sf-photo sf-arch aspect-[4/5] bg-sf-oat" data-testid="gallery-main">
        <NoPhoto label={t.noPhoto} />
      </div>
    );
  }

  return (
    <div className="space-y-3 lg:sticky lg:top-24">
      <div className="group relative">
        <div
          ref={viewport}
          className="sf-arch overflow-hidden bg-sf-oat"
          data-testid="gallery-main"
          aria-roledescription={count > 1 ? "carousel" : undefined}
          aria-label={count > 1 ? t.photos(n(count)) : undefined}
          role={count > 1 ? "region" : undefined}
        >
          <div className="flex touch-pan-y">
            {photos.map((p, i) => (
              <div
                key={p.id}
                className="aspect-[4/5] min-w-0 flex-[0_0_100%]"
                role={count > 1 ? "group" : undefined}
                aria-roledescription={count > 1 ? "slide" : undefined}
                aria-label={count > 1 ? t.photoPosition(n(i + 1), n(count)) : undefined}
                aria-hidden={count > 1 && i !== current ? true : undefined}
              >
                {broken.has(p.id) ? (
                  <div className="h-full" role="img" aria-label={`${alt(p)}: ${t.photoUnavailable}`}>
                    <NoPhoto label={t.photoUnavailable} />
                  </div>
                ) : (
                  // Private photos (Owner session): Next.js image optimisation would fetch them without it.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src(p, 1280)}
                    srcSet={srcSet(p)}
                    sizes="(min-width: 1024px) 50vw, 100vw"
                    width={p.width}
                    height={p.height}
                    alt={alt(p)}
                    loading={i === 0 ? "eager" : "lazy"}
                    fetchPriority={i === 0 ? "high" : "auto"}
                    draggable={false}
                    onError={() => fail(p.id)}
                    className="h-full w-full object-cover select-none"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
        {count > 1 ? (
          <>
            <span aria-hidden="true" className="sf-badge sf-num absolute end-4 bottom-4 shadow-sm lg:hidden">
              {t.photoPosition(n(current + 1), n(count))}
            </span>
            <div aria-hidden="true" className="flex justify-center gap-2 pt-3 lg:hidden">
              {photos.map((p, i) => (
                <span key={p.id} className={`h-2 rounded-full transition-all duration-300 ${i === current ? "w-6 bg-sf-ink" : "w-2 bg-sf-line-strong/60"}`} />
              ))}
            </div>
            <button type="button" onClick={() => show(current - 1)} aria-label={t.previousPhoto} className="sf-icon-btn absolute start-4 top-1/2 hidden -translate-y-1/2 bg-sf-card/95 shadow-md lg:inline-flex lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100">
              <ChevronLeft aria-hidden="true" size={22} strokeWidth={1.75} className="rtl:rotate-180" />
            </button>
            <button type="button" onClick={() => show(current + 1)} aria-label={t.nextPhoto} className="sf-icon-btn absolute end-4 top-1/2 hidden -translate-y-1/2 bg-sf-card/95 shadow-md lg:inline-flex lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100">
              <ChevronRight aria-hidden="true" size={22} strokeWidth={1.75} className="rtl:rotate-180" />
            </button>
          </>
        ) : null}
      </div>
      {count > 1 ? (
        <div role="group" aria-label={t.photos(n(count))} className="sf-rail hidden gap-2.5 lg:mx-0 lg:flex lg:px-0" data-testid="gallery-thumbs">
          {photos.map((p, i) => (
            <button
              key={p.id}
              ref={(el) => {
                thumbs.current[i] = el;
              }}
              type="button"
              aria-pressed={i === current}
              aria-label={t.showPhoto(n(i + 1), n(count))}
              tabIndex={i === current ? 0 : -1}
              onClick={() => show(i)}
              onKeyDown={(e) => {
                const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: count - 1 }[e.key];
                if (to === undefined) return;
                e.preventDefault();
                show(to, true);
              }}
              className="sf-arch h-24 w-[4.8rem] shrink-0 overflow-hidden bg-sf-oat opacity-70 ring-sf-ink ring-offset-2 ring-offset-sf-paper transition-opacity hover:opacity-100 aria-pressed:opacity-100 aria-pressed:ring-2"
            >
              {broken.has(p.id) ? null : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src(p, 320)} alt="" width={p.width} height={p.height} loading="lazy" onError={() => fail(p.id)} className="h-full w-full object-cover" />
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
