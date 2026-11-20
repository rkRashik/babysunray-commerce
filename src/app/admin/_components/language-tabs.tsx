"use client";

import { useId, useRef, useState } from "react";

type Lang = "en" | "bn";

/**
 * English and Bangla product text in two tabs. Both panels are always in the form (the hidden one is only not shown), so one
 * Save keeps both languages; the tab says how many of its fields were empty when the page loaded. Arrow keys move between tabs.
 */
export function LanguageTabs({ english, bangla, emptyEn = 0, emptyBn = 0 }: { english: React.ReactNode; bangla: React.ReactNode; emptyEn?: number; emptyBn?: number }) {
  const base = useId();
  const [tab, setTab] = useState<Lang>("en");
  const refs = { en: useRef<HTMLButtonElement>(null), bn: useRef<HTMLButtonElement>(null) };
  const go = (to: Lang) => {
    setTab(to);
    refs[to].current?.focus();
  };
  const tabs: { id: Lang; label: string; empty: number }[] = [
    { id: "en", label: "English", empty: emptyEn },
    { id: "bn", label: "Bangla", empty: emptyBn },
  ];
  return (
    <div>
      <div role="tablist" aria-label="Language of the product text" className="flex gap-1 border-b border-gray-300">
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={refs[t.id]}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="of-ltab"
            onClick={() => setTab(t.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "Home" || event.key === "End") {
                event.preventDefault();
                go(event.key === "ArrowLeft" || event.key === "Home" ? "en" : "bn");
              }
            }}
          >
            {t.label}
            {t.empty > 0 ? <span className="of-count">{t.empty} empty</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`${base}-panel-${t.id}`} aria-labelledby={`${base}-tab-${t.id}`} hidden={tab !== t.id} className="space-y-3 pt-4">
          {t.id === "en" ? english : bangla}
        </div>
      ))}
    </div>
  );
}
