import { Check, Circle } from "lucide-react";
import { languages } from "@/modules/catalogue/content";
import type { ReadinessBasis, ReadinessItem } from "@/modules/catalogue/readiness";

// Product content helpers for Admin: which languages a field has, and the product readiness checklist.

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

type Group = { key: string; title: string; note: string; items: ReadinessItem[] };

/**
 * The checklist in business terms. With a publication rule in force: what publishing needs (the founder-stated items plus
 * the rule's) and optional improvements. Without one: the required information, the proposed requirements, and optional
 * improvements. The same grouping is used by the preparation overview.
 */
export function readinessGroups<T extends { id: string; basis: ReadinessBasis }>(items: T[], rule: { items: readonly string[] } | null) {
  if (rule) {
    const required = (i: T) => i.basis === "approved" || rule.items.includes(i.id);
    return [
      { key: "required", title: "Needed to publish", note: "Your publication requirements and the basic product information.", items: items.filter(required) },
      { key: "optional", title: "Optional improvements", note: "Help customers choose; not needed to publish.", items: items.filter((i) => !required(i)) },
    ];
  }
  return [
    { key: "required", title: "Product information", note: "Every product needs these.", items: items.filter((i) => i.basis === "approved") },
    { key: "proposed", title: "Proposed requirements", note: "Not decided yet: choose what every product needs in Settings, Publication requirements.", items: items.filter((i) => i.basis === "pending") },
    { key: "optional", title: "Optional improvements", note: "Help customers choose; never required.", items: items.filter((i) => i.basis === "recommended") },
  ];
}

/** The product's checklist with its progress. It never publishes; the product page shows what publishing still needs. */
export function ReadinessList({ items, rule }: { items: ReadinessItem[]; rule: { items: readonly string[] } | null }) {
  const groups: Group[] = readinessGroups(items, rule);
  const required = groups[0].items;
  const done = required.filter((i) => i.met).length;
  return (
    <div className="space-y-5" data-testid="readiness">
      <div className="space-y-2">
        <p className="flex items-baseline justify-between gap-3 text-sm font-semibold">
          <span>
            {done === required.length ? `${groups[0].title}: complete` : `${groups[0].title}: ${done} of ${required.length} done`}
          </span>
        </p>
        <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-gray-200">
          <div className="h-full rounded-full bg-[var(--color-sf-sun)]" style={{ width: `${required.length ? Math.round((done / required.length) * 100) : 100}%` }} />
        </div>
      </div>
      <p className="text-sm text-gray-700">This checklist only shows what is missing. Publishing is a separate step on this page.</p>
      {groups.map((g) =>
        g.items.length ? (
          <div key={g.key} data-group={g.key}>
            <h3 className="text-sm font-bold">{g.title}</h3>
            <p className="text-xs text-gray-600">{g.note}</p>
            <ul className="mt-2 divide-y divide-gray-200 text-sm">
              {g.items.map((i) => (
                <li key={i.id} data-testid={`readiness-${i.id}`} data-met={i.met} className="flex gap-2.5 py-2">
                  <span aria-hidden="true" className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${i.met ? "bg-green-700 text-white" : "text-gray-400"}`}>
                    {i.met ? <Check size={13} strokeWidth={3} /> : <Circle size={18} strokeWidth={2} />}
                  </span>
                  <span>
                    <span className="font-medium">{i.label}</span> <span className="sr-only">{i.met ? "(done)" : "(not done)"}</span>
                    <span className="text-gray-700"> — {i.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </div>
  );
}
