"use client";

import { useRef, useState } from "react";
import { dictionary, type Lang, localised, toBnDigits } from "@/modules/storefront/i18n";
import type { PhotoRef } from "@/modules/storefront/service";

// Product photo gallery: one large photo and a row of thumbnails. Thumbnails are buttons (aria-pressed); the arrow
// keys, Home and End move between them and show the photo at once. A photo whose file cannot be loaded is replaced by
// a plain "photo unavailable" box instead of a broken image. Photos come from the Owner-only media route.

const WIDTHS = [320, 640, 1280];

function src(photo: PhotoRef, width: number) {
  return width < photo.width ? `/office/media/${photo.id}?w=${width}` : `/office/media/${photo.id}`;
}

function srcSet(photo: PhotoRef) {
  return [...WIDTHS.filter((w) => w < photo.width).map((w) => `/office/media/${photo.id}?w=${w} ${w}w`), `/office/media/${photo.id} ${photo.width}w`].join(", ");
}

export function Gallery({ lang, photos, name }: { lang: Lang; photos: PhotoRef[]; name: string }) {
  const t = dictionary(lang);
  const [current, setCurrent] = useState(0);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const n = (i: number) => (lang === "bn" ? toBnDigits(i) : String(i));
  const alt = (p: PhotoRef) => localised(lang, p.altEn, p.altBn) ?? localised(lang === "en" ? "bn" : "en", p.altEn, p.altBn) ?? name;
  const fail = (id: string) => setBroken((b) => new Set(b).add(id));

  if (photos.length === 0) {
    return <div className="flex aspect-[4/5] items-end rounded-sm bg-sf-sand p-4 text-sf-umber">{t.noPhoto}</div>;
  }
  const photo = photos[Math.min(current, photos.length - 1)];
  const move = (to: number) => {
    const next = (to + photos.length) % photos.length;
    setCurrent(next);
    buttons.current[next]?.focus();
  };

  return (
    <div className="space-y-3">
      <div className="aspect-[4/5] overflow-hidden rounded-sm bg-sf-sand" data-testid="gallery-main">
        {broken.has(photo.id) ? (
          <div className="flex h-full items-end p-4 text-sf-umber" role="img" aria-label={`${alt(photo)}: ${t.photoUnavailable}`}>
            {t.photoUnavailable}
          </div>
        ) : (
          // Private photos (Owner session): Next.js image optimisation would fetch them without it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={photo.id}
            src={src(photo, 1280)}
            srcSet={srcSet(photo)}
            sizes="(min-width: 768px) 55vw, 100vw"
            width={photo.width}
            height={photo.height}
            alt={alt(photo)}
            onError={() => fail(photo.id)}
            className="h-full w-full object-cover"
          />
        )}
      </div>
      {photos.length > 1 ? (
        <div role="group" aria-label={t.photos(n(photos.length))} className="flex gap-2 overflow-x-auto pb-1">
          {photos.map((p, i) => (
            <button
              key={p.id}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              aria-pressed={i === current}
              aria-label={t.showPhoto(n(i + 1), n(photos.length))}
              tabIndex={i === current ? 0 : -1}
              onClick={() => setCurrent(i)}
              onKeyDown={(e) => {
                const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: photos.length - 1 }[e.key];
                if (to === undefined) return;
                e.preventDefault();
                move(to);
              }}
              className="h-20 w-16 shrink-0 overflow-hidden rounded-sm border-2 border-transparent bg-sf-sand aria-pressed:border-sf-cocoa"
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
