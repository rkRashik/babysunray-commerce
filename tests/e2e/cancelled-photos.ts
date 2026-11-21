// Chrome sometimes cancels a redundant responsive-image request for a photo (a larger srcset candidate it no longer needs)
// while the same photo is drawn from another candidate. Such a cancellation is accepted only with positive evidence that the
// intended photo loaded: the same photo id was served 200 as an image on this page AND an <img> on the page is drawn from it.
// Every other cancellation, every other failed request, every HTTP error and every broken image still fails the test.

export type CancelledPhoto = { id: string; url: string };

/** The photo id of a product-photo route URL (shop or Admin), or null for anything else. */
export function photoId(url: string): string | null {
  let path: string;
  try {
    path = new URL(url, "https://x.invalid").pathname;
  } catch {
    return null;
  }
  return /^\/(?:api\/public|admin)\/media\/([^/]+)$/.exec(path)?.[1] ?? null;
}

/** The cancelled photo requests that lack that evidence, as test problems. */
export function unprovenCancellations(cancelled: CancelledPhoto[], served: ReadonlySet<string>, drawn: readonly string[]): string[] {
  const drawnIds = new Set(drawn.map(photoId).filter((id): id is string => id !== null));
  return cancelled
    .filter((c) => !(served.has(c.id) && drawnIds.has(c.id)))
    .map((c) => `request failed: GET ${c.url.slice(0, 160)} (net::ERR_ABORTED; the same photo was not both served and drawn on this page)`);
}
