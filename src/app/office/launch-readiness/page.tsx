import Link from "next/link";
import { getDb } from "@/db/client";
import { type CheckStatus, launchReadiness } from "@/modules/launch/readiness";
import { OfficeShell, Section } from "../_components/shell";
import { requireOffice } from "../_lib/session";

export const metadata = { title: "Launch readiness · Owner Office" };

// What still blocks a public shop, from live data where the system can check it (src/modules/launch/readiness.ts).
// Functional layout only. No score or percentage: each row says what it rests on and what happens next.

const STATUS: Record<CheckStatus, { label: string; className: string }> = {
  ready: { label: "Ready", className: "border-green-700 bg-green-50 text-green-900" },
  incomplete: { label: "Incomplete", className: "border-amber-700 bg-amber-50 text-amber-950" },
  founder_approval: { label: "Requires founder approval", className: "border-blue-800 bg-blue-50 text-blue-950" },
  not_verified: { label: "Not verified", className: "border-gray-700 bg-gray-100 text-gray-900" },
  not_applicable: { label: "Not applicable", className: "border-gray-400 bg-white text-gray-700" },
};

export default async function LaunchReadinessPage() {
  const principal = await requireOffice("launch:read");
  const readiness = await launchReadiness(getDb(), principal);
  return (
    <OfficeShell title="Launch readiness" current="launch">
      <div role="note" className="rounded border border-gray-400 bg-white p-4 text-sm">
        <p className="font-semibold">The public shop is closed.</p>
        <p className="mt-1">
          Nothing on this page can open it. Public checkout stays disabled until you approve and publish the delivery, return and privacy policies (S-17, G-7) and the decisions below are made. A passing check
          here is evidence about this system only: it is not legal approval, and it does not make a host or a policy safe.
        </p>
      </div>

      <Section title="Why public checkout is closed">
        <ol className="list-decimal space-y-2 pl-5 text-sm" data-testid="gate-blockers">
          {readiness.gate.blockers.map((b) => (
            <li key={b.id}>
              <span className="font-medium">{b.reason}</span> <span className="text-gray-700">({b.requirement})</span>
              <br />
              <span className="text-gray-700">Next: {b.next}</span>
            </li>
          ))}
        </ol>
      </Section>

      {readiness.sections.map((section) => (
        <Section key={section.id} title={section.title}>
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
                  <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${STATUS[check.status].className}`}>{STATUS[check.status].label}</span>
                </div>
                <p className="mt-1 text-sm">{check.evidence}</p>
                {check.next ? <p className="mt-1 text-sm text-gray-700">Next: {check.next}</p> : null}
                <p className="mt-1 text-xs text-gray-600">Rests on: {check.source}</p>
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </OfficeShell>
  );
}
