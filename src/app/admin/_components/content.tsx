import { Check, Circle } from "lucide-react";
import { languages } from "@/modules/catalogue/content";
import type { ReadinessBasis, ReadinessItem } from "@/modules/catalogue/readiness";

// Product content helpers for Admin: which languages a field has, and the advisory readiness checklist.

/** "English ✓ · Bangla missing", as text (not colour alone), for one bilingual field. */
export function LanguageStatus({ en, bn }: { en: string | null; bn: string | null }) {
  const has = languages(en, bn);
  const part = (label: string, ok: boolean) => (
    <span className={ok ? "text-gray-700" : "font-semibold text-amber-900"}>
      {label} {ok ? "✓" : "missing"}
    </span>
  );
  return (
    <span className="text-xs">
      {part("English", has.en)} · {part("Bangla", has.bn)}
    </span>
  );
}

/** One bilingual value as a definition: both languages, each marked, with a missing one said in words. */
export function Bilingual({ label, en, bn }: { label: string; en: string | null; bn: string | null }) {
  return (
    <>
      <dt className="text-gray-600">
        {label}
        <br />
        <LanguageStatus en={en} bn={bn} />
      </dt>
      <dd className="space-y-1">
        <p className="whitespace-pre-line">{en ?? <span className="text-gray-600">— (English not entered)</span>}</p>
        <p lang="bn" className="whitespace-pre-line">
          {bn ?? <span lang="en" className="text-gray-600">— (Bangla not entered)</span>}
        </p>
      </dd>
    </>
  );
}

const BASIS: Record<ReadinessBasis, { title: string; note: string }> = {
  approved: { title: "Required by an approved requirement", note: "Founder-stated or founder-approved." },
  pending: { title: "Proposed, waiting for your decision", note: "Not approved yet (for example I-6); shown so you can prepare." },
  recommended: { title: "Engineering recommendations", note: "Suggestions for quality, never rules." },
};

/** The checklist, grouped by basis. Advisory only: there is no publish action. */
export function ReadinessList({ items }: { items: ReadinessItem[] }) {
  const done = items.filter((i) => i.met).length;
  return (
    <div className="space-y-5" data-testid="readiness">
      <div className="space-y-2">
        <p className="flex items-baseline justify-between gap-3 text-sm font-semibold">
          <span>
            {done} of {items.length} done
          </span>
          <span className="font-normal text-gray-600">advisory</span>
        </p>
        <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-gray-200">
          <div className="h-full rounded-full bg-[var(--color-sf-sun)]" style={{ width: `${items.length ? Math.round((done / items.length) * 100) : 0}%` }} />
        </div>
      </div>
      <p className="text-sm text-gray-700">
        Advisory only. Nothing here publishes the product or approves publishing: no product is shown to customers, and the publication rule (I-6) is not approved.
      </p>
      {(Object.keys(BASIS) as ReadinessBasis[]).map((basis) => (
        <div key={basis}>
          <h3 className="text-sm font-bold">{BASIS[basis].title}</h3>
          <p className="text-xs text-gray-600">{BASIS[basis].note}</p>
          <ul className="mt-2 divide-y divide-gray-200 text-sm">
            {items
              .filter((i) => i.basis === basis)
              .map((i) => (
                <li key={i.id} data-testid={`readiness-${i.id}`} data-met={i.met} className="flex gap-2.5 py-2">
                  <span aria-hidden="true" className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${i.met ? "bg-green-700 text-white" : "text-gray-400"}`}>
                    {i.met ? <Check size={13} strokeWidth={3} /> : <Circle size={18} strokeWidth={2} />}
                  </span>
                  <span>
                    <span className="font-medium">{i.label}</span> <span className="sr-only">{i.met ? "(done)" : "(not done)"}</span>
                    <span className="text-gray-700"> — {i.detail}</span> <span className="text-xs text-gray-600">({i.source})</span>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
