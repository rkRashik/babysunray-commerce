"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A sideways-scrolling region that says so: soft fades at the edges that still have more to see (`fade`, for a row of
 * chips) or a shadow beside the sticky column plus a short hint (`hint`, for a wide table), shown only while the content
 * really overflows. Keyboard users can scroll it too (it is focusable only when it overflows).
 */
export function ScrollArea({ children, label, fade = false, hint, className = "" }: { children: React.ReactNode; label: string; fade?: boolean; hint?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ overflow: false, left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const overflow = el.scrollWidth > el.clientWidth + 1;
      setState({ overflow, left: overflow && el.scrollLeft > 1, right: overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);
  return (
    <div className={`of-scrollarea ${className}`} data-overflow={state.overflow} data-left={state.left} data-right={state.right} data-fade={fade}>
      <div ref={ref} role="region" aria-label={label} tabIndex={state.overflow ? 0 : undefined} className="of-scrollarea-inner">
        {children}
      </div>
      {hint && state.overflow ? <p className="of-scrollarea-hint">{hint}</p> : null}
    </div>
  );
}
