"use client";

import { useCallback, useSyncExternalStore } from "react";
import { type CartLine, validateCartLines } from "@/modules/storefront/cart";

// The preview cart in this browser: SKUs and quantities only (no prices, names or personal data), in
// localStorage so it survives a reload and is shared by the preview's tabs. Storage may be unavailable (private
// mode, blocked); then the cart simply starts empty. Anything unreadable is dropped, never trusted.

const KEY = "babysunray-preview-cart-v1";
const EMPTY: CartLine[] = [];
const listeners = new Set<() => void>();
let cache: CartLine[] | null = null;

function read(): CartLine[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? validateCartLines(JSON.parse(raw)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function snapshot(): CartLine[] {
  cache ??= read();
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    cache = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function write(lines: CartLine[]): void {
  cache = lines;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Kept for this page only.
  }
  for (const listener of listeners) listener();
}

/** The cart and a setter. The server render sees an empty cart; the browser's arrives after hydration. */
export function useCart(): [CartLine[], (next: CartLine[]) => void] {
  const lines = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  return [lines, useCallback((next: CartLine[]) => write(next), [])];
}
