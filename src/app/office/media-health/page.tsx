import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { UNREFERENCED_GRACE_MS, verifyMediaStore } from "@/modules/media/manifest";
import { mediaStoreConfig } from "@/modules/media/storage";
import { ActionForm, Checkbox } from "../_components/action-form";
import { OfficeShell, Section } from "../_components/shell";
import { removeUnreferencedAction } from "../content-actions";
import { requireOffice } from "../_lib/session";

export const metadata = { title: "Photo storage · Owner Office" };

const LIST_LIMIT = 50;

function Keys({ title, keys, testId }: { title: string; keys: string[]; testId: string }) {
  if (keys.length === 0) return null;
  return (
    <div data-testid={testId}>
      <h3 className="text-sm font-semibold">
        {title} ({keys.length})
      </h3>
      <ul className="mt-1 font-mono text-xs">
        {keys.slice(0, LIST_LIMIT).map((k) => (
          <li key={k}>{k}</li>
        ))}
      </ul>
      {keys.length > LIST_LIMIT ? <p className="text-xs text-gray-600">… and {keys.length - LIST_LIMIT} more (npm run media:verify lists all).</p> : null}
    </div>
  );
}

// The photo folder checked against the photo records, now (the same check as npm run media:verify). Read-only; the
// only change offered is deleting files that no record uses, after an explicit tick and only if untouched for an hour.
export default async function MediaHealthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOffice("catalog:read");
  const { done, removed } = await searchParams;
  const config = mediaStoreConfig(process.env, process.cwd());
  const check = config.ok ? await verifyMediaStore(getDb(), config.store) : null;
  const notice = done === "cleanup" ? `${typeof removed === "string" && /^[0-9]+$/.test(removed) ? removed : "0"} unused file(s) deleted.` : undefined;
  return (
    <OfficeShell title="Photo storage" current="media" notice={notice}>
      {!config.ok ? (
        <p role="status" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          Photos are not set up on this server: {config.problem}
        </p>
      ) : check ? (
        <>
          <Section title="Check">
            <p className="text-sm" data-testid="media-summary">
              {check.records} photo record{check.records === 1 ? "" : "s"}; {check.ok} match their file byte for byte.{" "}
              {check.missing.length + check.changed.length === 0 ? "No record is missing its file." : "Some records do not match their file: see below."}
            </p>
            <Keys title="Missing file (restore it from the photo backup)" keys={check.missing} testId="media-missing" />
            <Keys title="File differs from its record" keys={check.changed} testId="media-changed" />
            <Keys title="File without a record (left by an interrupted upload or removal)" keys={check.unreferenced} testId="media-unreferenced" />
            <Keys title="Unexpected entry in the folder (not touched by this page)" keys={check.unexpected} testId="media-unexpected" />
            <p className="text-xs text-gray-600">
              Photo files are not in the database backups. Back them up with npm run media:backup (runbook, Product photos).
            </p>
          </Section>
          {check.unreferenced.length ? (
            <Section title="Delete files without a record">
              <p className="text-sm text-gray-700">
                Deletes only files named like a photo that no record uses and that have not changed for {UNREFERENCED_GRACE_MS / 60_000} minutes, so an upload in progress is never touched. Each
                file is checked again just before it is deleted. This cannot be undone.
              </p>
              <ActionForm action={removeUnreferencedAction} idempotencyKey={randomUUID()} submitLabel="Delete unused files" variant="secondary" confirm="Delete the photo files that no record uses? This cannot be undone.">
                <Checkbox name="confirmCleanup" label="Yes, delete the files listed above that no record uses" />
              </ActionForm>
            </Section>
          ) : null}
        </>
      ) : null}
    </OfficeShell>
  );
}
