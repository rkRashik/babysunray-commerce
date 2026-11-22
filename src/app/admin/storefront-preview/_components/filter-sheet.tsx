"use client";

import { SlidersHorizontal } from "lucide-react";
import { dictionary, type Lang, toBnDigits } from "@/modules/storefront/i18n";
import { Sheet } from "./sheet";

// The product list's filter button and sheet. The form inside is the server's plain GET form (children), so filtering
// still works, and still lands in the URL, exactly as before; the sheet only presents it.
export function FilterSheet({ lang, active, children }: { lang: Lang; active: number; children: React.ReactNode }) {
  const t = dictionary(lang);
  return (
    <Sheet
      title={t.filterSort}
      closeLabel={t.close}
      testId="filter-sheet"
      triggerTestId="filter-button"
      triggerClassName="sf-btn sf-btn-ghost sf-btn-sm gap-2"
      trigger={
        <>
          <SlidersHorizontal aria-hidden="true" size={18} strokeWidth={1.75} />
          {t.filterSort}
          {active ? <span className="sf-count">{lang === "bn" ? toBnDigits(active) : active}</span> : null}
        </>
      }
    >
      {children}
    </Sheet>
  );
}
