"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

/**
 * Makes a form apply itself: a choice in a drop-down or tick box submits at once; typing in a search box submits once the
 * typing pauses (and when at least `minChars` characters, or none, are typed). The submit goes through the form's own
 * handler, so a form can keep a name or phone number out of the address bar. Pressing Enter or the button still works.
 */
export function useAutoSubmit(form: React.RefObject<HTMLFormElement | null>, { debounceMs = 450, minChars = 2 }: { debounceMs?: number; minChars?: number } = {}) {
  useEffect(() => {
    const el = form.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = new FormData(el).get("q");
    const submit = () => el.requestSubmit();
    const onChange = (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.matches("select, input[type=checkbox], input[type=radio], input[type=date]")) submit();
    };
    const onInput = (event: Event) => {
      const target = event.target as HTMLInputElement;
      if (!target.matches("input[type=search], input[data-auto-search]")) return;
      clearTimeout(timer);
      const value = target.value.trim();
      if (value === String(last ?? "").trim()) return;
      if (value.length !== 0 && value.length < minChars) return;
      timer = setTimeout(() => {
        last = value;
        submit();
      }, debounceMs);
    };
    // A submit by hand (Enter, the button) answers whatever is typed: a pause timer still running must not submit it again.
    const onSubmit = () => {
      clearTimeout(timer);
      last = new FormData(el).get("q");
    };
    el.addEventListener("change", onChange);
    el.addEventListener("input", onInput);
    el.addEventListener("submit", onSubmit);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("change", onChange);
      el.removeEventListener("input", onInput);
      el.removeEventListener("submit", onSubmit);
    };
  }, [form, debounceMs, minChars]);
}

/**
 * A GET filter form whose address is its filters (nothing personal): applies on every change, replaces the current
 * history entry while filtering so the Back button is not filled with every keystroke, and keeps focus in the box.
 */
export function AutoFilterForm({ action, children, className, ariaLabel }: { action: string; children: React.ReactNode; className?: string; ariaLabel?: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [pending, start] = useTransition();
  useAutoSubmit(ref);
  return (
    <form
      ref={ref}
      action={action}
      method="get"
      className={className}
      aria-label={ariaLabel}
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        const params = new URLSearchParams();
        for (const [key, value] of new FormData(event.currentTarget)) if (typeof value === "string" && value.trim() !== "") params.set(key, value.trim());
        start(() => router.replace(params.size ? `${action}?${params}` : action));
      }}
    >
      {children}
    </form>
  );
}
