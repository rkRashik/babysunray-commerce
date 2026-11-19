import type { Lang } from "@/modules/storefront/i18n";

// Where a storefront page lives. The same First Light components serve two surfaces:
//   preview  the Owner-only preview under /office/storefront-preview (drafts included, checkout simulated);
//   shop     the real shop at /en and /bn (published products only, real orders; open only for founder acceptance
//            or after the public launch, src/modules/launch/acceptance.ts).
export type Surface = "preview" | "shop";

export const rootOf = (surface: Surface) => (surface === "shop" ? "" : "/office/storefront-preview");
export const base = (lang: Lang, surface: Surface = "preview") => `${rootOf(surface)}/${lang}`;

/** A product photo's URL on this surface (when it has no CDN copy): the Owner-only media route, or the shop's photo route. */
export const photoPath = (surface: Surface, id: string, width?: number) => `${surface === "shop" ? "/api/public/media" : "/office/media"}/${id}${width ? `?w=${width}` : ""}`;
