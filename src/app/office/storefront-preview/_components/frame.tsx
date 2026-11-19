"use client";

import { createContext, type RefObject, useContext, useRef, useSyncExternalStore } from "react";

// The storefront's root element. Sheets and drawers render into a node inside it (not at the end of <body>), so they
// keep the storefront's fonts, colours, language and styles.

const PortalContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function SfFrame({ lang, className, style, children }: { lang: string; className: string; style?: React.CSSProperties; children: React.ReactNode }) {
  const portal = useRef<HTMLDivElement>(null);
  return (
    <div lang={lang} className={className} style={style}>
      <PortalContext value={portal}>{children}</PortalContext>
      <div ref={portal} />
    </div>
  );
}

export const usePortal = () => useContext(PortalContext);

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
