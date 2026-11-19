import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { POLICY_CHECKLIST } from "@/modules/policies/checklist";
import { listPolicyDrafts, POLICY_TITLES, type PolicyStatus, policyHistory } from "@/modules/policies/drafts";
import { ActionForm } from "../_components/action-form";
import { formatTime, noticeFor, OfficeShell } from "../_components/shell";
import { requireOffice } from "../_lib/session";
import { markPolicyReviewedAction } from "./actions";
import { CopyText, PolicyEditor } from "./policy-editor";

export const metadata = { title: "Policy drafts · Owner Office" };

// The private policy workspace (S-17). Owner only; never shown to customers. The questions beside each editor
// come from decisions already made (src/modules/policies/checklist.ts); open questions are left open. Drafts are
// shown as plain text only (React escapes everything), so pasted markup is never run.

const STATUS: Record<PolicyStatus, string> = {
  empty: "Empty",
  drafted: "Drafted, not reviewed",
  reviewed: "Reviewed by you · not approved for publication · not published",
};

export default async function PoliciesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requireOffice("policies:read");
  const { done } = await searchParams;
  const db = getDb();
  const drafts = await listPolicyDrafts(db, principal);
  const histories = await Promise.all(drafts.map((d) => policyHistory(db, principal, d.kind)));
  return (
    <OfficeShell title="Policy drafts" current="policies" notice={noticeFor(done)}>
      <div role="note" className="rounded border border-gray-400 bg-white p-4 text-sm">
        <p className="font-semibold">Private drafts. Nothing here is shown to customers or published.</p>
        <p className="mt-1">
          Write the real wording yourself, in English and Bangla. &quot;Reviewed&quot; only records that you checked this version; it is not legal approval. Public checkout stays disabled until the delivery, return
          and privacy policies are approved and published (S-17, G-7), which this version cannot do. For external review, copy the text or export the &quot;Customer policy drafts&quot; dataset.
        </p>
      </div>
      {drafts.map((draft, i) => (
        <section key={draft.kind} id={draft.kind} aria-labelledby={`h-${draft.kind}`} className="scroll-mt-4 space-y-4 of-card p-4 lg:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={`h-${draft.kind}`} className="text-base font-semibold">
              {POLICY_TITLES[draft.kind]}
            </h2>
            <p className="text-sm" data-testid={`policy-status-${draft.kind}`}>
              <span className="font-medium">{STATUS[draft.status]}</span>
              {draft.updatedAt ? <span className="text-gray-700"> · saved {formatTime(draft.updatedAt)}</span> : null}
              {draft.reviewedAt ? <span className="text-gray-700"> · reviewed {formatTime(draft.reviewedAt)}</span> : null}
            </p>
          </div>

          <details className="rounded border border-gray-200 p-3 text-sm">
            <summary className="cursor-pointer font-medium">Questions to answer ({POLICY_CHECKLIST[draft.kind].length})</summary>
            <dl className="mt-2 space-y-3">
              {POLICY_CHECKLIST[draft.kind].map((item) => (
                <div key={item.topic}>
                  <dt className="font-medium">
                    {item.topic} <span className="font-normal text-gray-600">({item.source})</span>
                  </dt>
                  {item.decided ? <dd>Decided: {item.decided}</dd> : null}
                  {item.open ? <dd className="text-amber-900">Open: {item.open}</dd> : null}
                </div>
              ))}
            </dl>
          </details>

          <PolicyEditor key={`${draft.kind}-${draft.version}`} kind={draft.kind} title={POLICY_TITLES[draft.kind]} version={draft.version} bodyEn={draft.bodyEn ?? ""} bodyBn={draft.bodyBn ?? ""} idempotencyKey={randomUUID()} />

          {draft.bodyEn || draft.bodyBn ? (
            <div className="space-y-2">
              <CopyText label="Copy both languages" text={`${POLICY_TITLES[draft.kind]} (draft version ${draft.version}, not published)\n\nEnglish:\n${draft.bodyEn ?? "(not written)"}\n\nBangla:\n${draft.bodyBn ?? "(not written)"}`} />
              {draft.status === "drafted" && draft.bodyEn && draft.bodyBn ? (
                <ActionForm action={markPolicyReviewedAction} idempotencyKey={randomUUID()} hidden={{ kind: draft.kind, version: String(draft.version) }} submitLabel="Mark this version as reviewed" variant="secondary" />
              ) : null}
              {draft.status === "drafted" && (!draft.bodyEn || !draft.bodyBn) ? <p className="text-sm text-gray-700">Both languages are needed before it can be marked reviewed.</p> : null}
            </div>
          ) : null}

          {histories[i].length ? (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">History ({histories[i].length})</summary>
              <ul className="mt-2 space-y-1">
                {histories[i].map((e) => (
                  <li key={e.id}>
                    {formatTime(e.createdAt)}: {e.event === "saved" ? "saved" : "marked reviewed"} version {e.version} by the Owner
                    <span className="text-gray-600"> · English {e.bodyEnSha256 ? e.bodyEnSha256.slice(0, 12) : "empty"}, Bangla {e.bodyBnSha256 ? e.bodyBnSha256.slice(0, 12) : "empty"}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ))}
    </OfficeShell>
  );
}
