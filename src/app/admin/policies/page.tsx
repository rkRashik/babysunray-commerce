import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getDb } from "@/db/client";
import { POLICY_CHECKLIST } from "@/modules/policies/checklist";
import { listPolicyDrafts, POLICY_TITLES, type PolicyStatus, policyHistory } from "@/modules/policies/drafts";
import { publicationStates } from "@/modules/policies/publication";
import { ActionForm, Checkbox } from "../_components/action-form";
import { formatTime, noticeFor, AdminShell } from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { markPolicyReviewedAction, publishPolicyAction, withdrawPolicyAction } from "./actions";
import { CopyText, PolicyEditor } from "./policy-editor";

export const metadata = { title: "Policies · Admin" };

// The policy workspace (S-17). Drafts are private; a reviewed version reaches customers only when the founder publishes it
// here with the explicit approval box (src/modules/policies/publication.ts). The questions beside each editor come from
// decisions already made (src/modules/policies/checklist.ts); open questions are left open. Text is shown as plain text
// only (React escapes everything), so pasted markup is never run.

const STATUS: Record<PolicyStatus, string> = {
  empty: "Empty",
  drafted: "Drafted, not reviewed",
  reviewed: "Reviewed by you",
};

export default async function PoliciesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requireAdmin("policies:read");
  const { done, policy } = await searchParams;
  const db = getDb();
  const [drafts, published] = await Promise.all([listPolicyDrafts(db, principal), publicationStates(db, principal)]);
  // One policy at a time: the one asked for, else the first whose current wording is not what customers see.
  const current = (kind: string) => published[kind as keyof typeof published]?.draftVersion === drafts.find((d) => d.kind === kind)?.version;
  const selected = drafts.find((d) => d.kind === policy) ?? drafts.find((d) => !current(d.kind)) ?? drafts[0];
  const shown = selected ? [selected] : [];
  const histories = await Promise.all(shown.map((d) => policyHistory(db, principal, d.kind)));
  return (
    <AdminShell title="Policies" current="policies" notice={noticeFor(done)}>
      <div role="note" className="rounded border border-gray-400 bg-white p-4 text-sm">
        <p className="font-semibold">Drafts are private. Customers see a policy only after you publish it here.</p>
        <p className="mt-1">
          Write the real wording yourself, in English and Bangla. &quot;Reviewed&quot; records that you checked this version; it is not legal approval. Publishing is your approval of that exact wording for
          customers: it is copied, dated and shown in the shop footer and checkout. Public checkout stays disabled until the delivery, return and privacy policies are published and the launch gate
          is opened. For external review, copy the text or export the &quot;Customer policy drafts&quot; dataset.
        </p>
      </div>
      <nav aria-label="Choose a policy" className="of-card p-2">
        <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
          {drafts.map((d) => (
            <li key={d.kind}>
              <Link
                href={`/admin/policies?policy=${d.kind}#${d.kind}`}
                aria-current={d.kind === selected?.kind ? "page" : undefined}
                className="block min-h-11 rounded-xl px-3 py-2.5 hover:bg-gray-100 aria-[current=page]:bg-amber-100"
                data-testid={`policy-tab-${d.kind}`}
              >
                <span className="block font-semibold">{POLICY_TITLES[d.kind]}</span>
                <span className="block text-xs text-gray-700">
                  {STATUS[d.status]} · {published[d.kind] ? (current(d.kind) ? "published" : "published, draft changed since") : "not published"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {shown.map((draft, i) => (
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
          <p className="text-sm" data-testid={`policy-published-${draft.kind}`}>
            {published[draft.kind]
              ? `Published to customers: version ${published[draft.kind]!.draftVersion}, ${formatTime(published[draft.kind]!.publishedAt)}${published[draft.kind]!.draftVersion !== draft.version ? ". The draft has changed since; customers still see the published version." : "."}`
              : "Not published: customers do not see this policy."}
          </p>

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
              {draft.status === "reviewed" && published[draft.kind]?.draftVersion !== draft.version ? (
                <ActionForm action={publishPolicyAction} idempotencyKey={randomUUID()} hidden={{ kind: draft.kind, version: String(draft.version) }} submitLabel={`Publish version ${draft.version} to customers`}>
                  <Checkbox name="approve" label={`I am the founder and I approve this exact wording of the ${POLICY_TITLES[draft.kind].toLowerCase()}, in English and Bangla, for customers.`} />
                </ActionForm>
              ) : null}
              {published[draft.kind] ? (
                <ActionForm action={withdrawPolicyAction} idempotencyKey={randomUUID()} hidden={{ kind: draft.kind }} submitLabel="Withdraw from customers" variant="secondary" confirm="Withdraw this policy? Customers will no longer see it." />
              ) : null}
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
    </AdminShell>
  );
}
