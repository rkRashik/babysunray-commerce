import { languages } from "@/modules/catalogue/content";
import type { ReadinessBasis, ReadinessItem } from "@/modules/catalogue/readiness";

// Product content helpers for the Office: which languages a field has, and the advisory readiness checklist.

/** "English ✓ · Bangla missing", as text (not colour alone), for one bilingual field. */
export function LanguageStatus({ en, bn }: { en: string | null; bn: string | null }) {
  const has = languages(en, bn);
  const part = (label: string, ok: boolean) => (
    <span className={ok ? "text-gray-700" : "font-medium text-amber-900"}>
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
  return (
    <div className="space-y-4" data-testid="readiness">
      <p className="text-sm text-gray-700">
        Advisory only. Nothing here publishes the product or approves publishing: no product is shown to customers, and the publication rule (I-6) is not approved.
      </p>
      {(Object.keys(BASIS) as ReadinessBasis[]).map((basis) => (
        <div key={basis}>
          <h3 className="text-sm font-semibold">{BASIS[basis].title}</h3>
          <p className="text-xs text-gray-600">{BASIS[basis].note}</p>
          <ul className="mt-1 space-y-1 text-sm">
            {items
              .filter((i) => i.basis === basis)
              .map((i) => (
                <li key={i.id} data-testid={`readiness-${i.id}`} data-met={i.met} className="flex gap-2">
                  <span aria-hidden="true" className={i.met ? "text-green-800" : "text-amber-900"}>
                    {i.met ? "✓" : "○"}
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
