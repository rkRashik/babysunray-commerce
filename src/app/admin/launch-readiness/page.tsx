import Link from "next/link";
import { getDb } from "@/db/client";
import { type CheckStatus, launchReadiness } from "@/modules/launch/readiness";
import { AdminShell, Section } from "../_components/shell";
import { requireAdmin } from "../_lib/session";

export const metadata = { title: "Launch readiness · Admin" };

// What still blocks a public shop, from live data where the system can check it (src/modules/launch/readiness.ts).
// No score or percentage: each section counts its checks by status, and each row says what it rests on and what happens next.

// Status pills in the shared Admin tones (the word carries the meaning; colour only groups).
const STATUS: Record<CheckStatus, { label: string; tone: "ok" | "wait" | "move" | "quiet" }> = {
  ready: { label: "Ready", tone: "ok" },
  incomplete: { label: "Incomplete", tone: "wait" },
  founder_approval: { label: "Requires founder approval", tone: "move" },
  not_verified: { label: "Not verified", tone: "quiet" },
  not_applicable: { label: "Not applicable", tone: "quiet" },
};
const ORDER: CheckStatus[] = ["incomplete", "founder_approval", "not_verified", "ready", "not_applicable"];

export default async function LaunchReadinessPage() {
  const principal = await requireAdmin("launch:read");
  const readiness = await launchReadiness(getDb(), principal);
  return (
    <AdminShell title="Launch readiness" current="launch">
      <div role="note" className="rounded border border-gray-400 bg-white p-4 text-sm">
        <p className="font-semibold">The public shop is closed.</p>
        <p className="mt-1">
          Nothing on this page can open it. Public checkout stays disabled until you approve and publish the delivery, return and privacy policies and the decisions below are made. A passing check
          here is evidence about this system only: it is not legal approval, and it does not make a host or a policy safe.
        </p>
      </div>

      <Section title="Why public checkout is closed">
        <p className="text-sm font-semibold" data-testid="gate-count">
          {readiness.gate.blockers.length === 1 ? "1 thing keeps" : `${readiness.gate.blockers.length} things keep`} public checkout closed. Each says what comes next.
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm" data-testid="gate-blockers">
          {readiness.gate.blockers.map((b) => (
            <li key={b.id}>
              <span className="font-medium">{b.reason}</span>
              <br />
              <span className="text-gray-700">Next: {b.next}</span>
            </li>
          ))}
        </ol>
      </Section>

      {readiness.sections.map((section) => (
        <Section key={section.id} title={section.title}>
          {/* A count of checks by status, not a score: each row below still says what it rests on. */}
          <ul className="flex flex-wrap gap-2" aria-label={`${section.title}: checks by status`}>
            {ORDER.map((status) => {
              const n = section.checks.filter((c) => c.status === status).length;
              return n ? (
                <li key={status} className="of-pill" data-tone={STATUS[status].tone}>
                  {n} {STATUS[status].label.toLowerCase()}
                </li>
              ) : null;
            })}
          </ul>
          <ul className="divide-y divide-gray-200">
            {section.checks.map((check) => (
              <li key={check.id} className="py-3" data-testid={`check-${check.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {check.href ? (
                      <Link href={check.href} className="underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900">
                        {check.label}
                      </Link>
                    ) : (
                      check.label
                    )}
                  </p>
                  <span className="of-pill" data-tone={STATUS[check.status].tone}>
                    {STATUS[check.status].label}
                  </span>
                </div>
                <p className="mt-1 text-sm">{check.evidence}</p>
                {check.next ? <p className="mt-1 text-sm text-gray-700">Next: {check.next}</p> : null}
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </AdminShell>
  );
}
