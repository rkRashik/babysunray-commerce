"use client";

import { createContext, type RefObject, useContext, useRef, useSyncExternalStore } from "react";
import type { CheckoutResult, Quote } from "@/modules/storefront/service";
import { rootOf, type Surface } from "./surface";

// The storefront's root element. Sheets and drawers render into a node inside it (not at the end of <body>), so they
// keep the storefront's fonts, colours, language and styles. It also tells the browser-side components which surface they
// are on (the preview or the real shop) and hands them that surface's Server Actions, so the same components never mix
// the preview's draft data with the shop's.

const PortalContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

/** The surface's Server Actions: the cart quote and the checkout check (both read-only). Each re-checks access itself. */
export type SurfaceActions = {
  quote: (input: { lines: unknown; zone: unknown }) => Promise<Quote | null>;
  check: (previous: CheckoutResult | null, form: FormData) => Promise<CheckoutResult>;
};
/** What a signed-in customer needs on the page (shop only): never an email, id or token. */
export type ShopCustomer = { name: string } | null;
export type PolicyLink = { kind: string; href: string };

type SurfaceValue = { surface: Surface; root: string; actions: SurfaceActions; customer: ShopCustomer; policies: PolicyLink[]; signIn: boolean };
const SurfaceContext = createContext<SurfaceValue | null>(null);

export function SfFrame({
  lang,
  className,
  style,
  surface = "preview",
  actions,
  customer = null,
  policies = [],
  signIn = false,
  children,
}: {
  lang: string;
  className: string;
  style?: React.CSSProperties;
  surface?: Surface;
  actions: SurfaceActions;
  customer?: ShopCustomer;
  policies?: PolicyLink[];
  /** Whether "Continue with Google" is offered (shop only, when configured). */
  signIn?: boolean;
  children: React.ReactNode;
}) {
  const portal = useRef<HTMLDivElement>(null);
  return (
    <div lang={lang} className={className} style={style}>
      <SurfaceContext value={{ surface, root: rootOf(surface), actions, customer, policies, signIn }}>
        <PortalContext value={portal}>{children}</PortalContext>
      </SurfaceContext>
      <div ref={portal} />
    </div>
  );
}

export const usePortal = () => useContext(PortalContext);

/** The surface this component renders on. Outside a frame (never in practice), the preview without actions. */
export function useSurface(): SurfaceValue {
  const value = useContext(SurfaceContext);
  if (!value) throw new Error("A storefront component rendered outside SfFrame.");
  return value;
}

const WIDE = "(min-width: 1024px)";
const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** True on a desktop-width screen (the layout's lg breakpoint); false on the server and on phones. */
export function useWide(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false);
}
