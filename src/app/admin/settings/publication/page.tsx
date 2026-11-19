import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { READINESS_ITEMS } from "@/modules/catalogue/readiness";
import { storeSettingsForAdmin } from "@/modules/settings/store";
import { ActionForm, Checkbox } from "../../_components/action-form";
import { AdminShell, Section, formatTime, noticeFor } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { approvePublicationRuleAction } from "../actions";

export const metadata = { title: "Publication requirements · Admin" };

// The publication rule (requirement I-6) as the Owner's own decision: which checklist items every product must meet,
// on top of a current review, before it can be published. Approving it records who and when.
export default async function PublicationSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin("catalog:publish");
  const principal = await requireAdmin("settings:write");
  const { done } = await searchParams;
  const { settings, schemaReady } = await storeSettingsForAdmin(getDb(), principal);
  const chosen = Array.isArray(settings?.publicationRuleItems) ? (settings.publicationRuleItems as string[]) : READINESS_ITEMS.map((i) => i.id);
  return (
    <AdminShell title="Publication requirements" current="publication" notice={noticeFor(done)}>
      <p className="text-sm text-gray-700" data-testid="rule-state">
        {settings?.publicationRuleApprovedAt
          ? `Approved on ${formatTime(settings.publicationRuleApprovedAt)}. Products must meet the ticked items and have a current review to be published.`
          : "Not approved yet. Until you approve requirements, products cannot be published (except in founder acceptance on the staging database)."}
      </p>
      {!schemaReady ? <p role="alert">This database needs its latest update (migration 0021) first.</p> : null}
      <Section title="What every product needs before customers can see it · প্রকাশের শর্ত">
        <ActionForm action={approvePublicationRuleAction} idempotencyKey={randomUUID()} hidden={{ version: String(settings?.version ?? 0) }} submitLabel="Approve these requirements">
          <fieldset className="space-y-2">
            <legend className="sr-only">Requirements</legend>
            {READINESS_ITEMS.map((item) => (
              <label key={item.id} className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="items" value={item.id} defaultChecked={item.basis === "approved" || chosen.includes(item.id)} disabled={item.basis === "approved"} className="mt-0.5 h-5 w-5" />
                <span>
                  {item.label}
                  {item.basis === "approved" ? <span className="text-gray-600"> (always required)</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
          <Checkbox name="approve" label="I am the Owner and I approve these publication requirements for this store." />
        </ActionForm>
      </Section>
    </AdminShell>
  );
}
