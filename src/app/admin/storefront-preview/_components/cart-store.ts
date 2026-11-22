"use client";

import { useCallback, useSyncExternalStore } from "react";
import { type CartLine, validateCartLines } from "@/modules/storefront/cart";
import { useSurface } from "./frame";

// The cart in this browser: SKUs and quantities only (no prices, names or personal data), in localStorage so it survives
// a reload and is shared by the surface's tabs. The preview and the real shop keep separate carts, so a draft SKU tried in
// the preview never lands in a real order. Storage may be unavailable (private mode, blocked); then the cart simply starts
// empty. Anything unreadable is dropped, never trusted.

const KEYS = { preview: "babysunray-preview-cart-v1", shop: "babysunray-cart-v1" } as const;
const EMPTY: CartLine[] = [];
const listeners = new Set<() => void>();
const cache = new Map<string, CartLine[]>();

function read(key: string): CartLine[] {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? validateCartLines(JSON.parse(raw)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function snapshot(key: string): CartLine[] {
  let lines = cache.get(key);
  if (!lines) {
    lines = read(key);
    cache.set(key, lines);
  }
  return lines;
}

function subscribe(key: string, listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key) return;
    cache.delete(key);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function write(key: string, lines: CartLine[]): void {
  cache.set(key, lines);
  try {
    window.localStorage.setItem(key, JSON.stringify(lines));
  } catch {
    // Kept for this page only.
  }
  for (const listener of listeners) listener();
}

// The delivery area chosen in the bag, so checkout starts with it (the customer does not choose twice). Only the area's
// code (dhaka_city, outside_dhaka), never an address; in sessionStorage, so it lasts for this tab only. The server prices
// it again on every quote, and an area it no longer offers is dropped (useZoneQuote).
const ZONE_KEYS = { preview: "babysunray-preview-zone-v1", shop: "babysunray-zone-v1" } as const;
const zones = new Map<string, string>();
const zoneListeners = new Set<() => void>();

function readZone(key: string): string {
  if (!zones.has(key)) {
    let stored = "";
    try {
      stored = window.sessionStorage.getItem(key) ?? "";
    } catch {
      // Storage blocked: the area is kept for this page only.
    }
    zones.set(key, /^[a-z_]{1,40}$/.test(stored) ? stored : "");
  }
  return zones.get(key)!;
}

const subscribeZone = (listener: () => void) => {
  zoneListeners.add(listener);
  return () => void zoneListeners.delete(listener);
};

/** The remembered delivery area ("" when none) and a setter. */
export function useZone(): [string, (zone: string) => void] {
  const key = ZONE_KEYS[useSurface().surface];
  const zone = useSyncExternalStore(subscribeZone, () => readZone(key), () => "");
  const set = useCallback(
    (next: string) => {
      zones.set(key, next);
      try {
        window.sessionStorage.setItem(key, next);
      } catch {
        // Kept for this page only.
      }
      for (const listener of zoneListeners) listener();
    },
    [key],
  );
  return [zone, set];
}

/** The cart and a setter. The server render sees an empty cart; the browser's arrives after hydration. */
export function useCart(): [CartLine[], (next: CartLine[]) => void] {
  const key = KEYS[useSurface().surface];
  const lines = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    () => snapshot(key),
    () => EMPTY,
  );
  return [lines, useCallback((next: CartLine[]) => write(key, next), [key])];
}
