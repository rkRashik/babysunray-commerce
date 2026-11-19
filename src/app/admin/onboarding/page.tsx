import { CheckCircle2, Circle } from "lucide-react";
import Link from "next/link";
import { getDb } from "@/db/client";
import { storeSetupProgress } from "@/modules/settings/progress";
import { AdminShell } from "../_components/shell";
import { requireAdmin } from "../_lib/session";

export const metadata = { title: "Store setup · Admin" };

// The store setup checklist: each step links to the normal Admin page where it is done, and is "done" when the store's own
// data says so. Nothing is forced: the dashboard and every page work at any point.
export default async function OnboardingPage() {
  const principal = await requireAdmin("settings:write");
  const steps = await storeSetupProgress(getDb(), principal);
  const required = steps.filter((s) => s.required);
  const done = required.filter((s) => s.done).length;
  return (
    <AdminShell title="Store setup" current="onboarding">
      <p className="text-sm text-gray-700" data-testid="setup-progress">
        {done} of {required.length} essential steps done · প্রয়োজনীয় ধাপ {done}/{required.length}। You can do them in any order, and change everything later.
      </p>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.id}>
            <Link href={s.href} className="of-card flex items-start gap-3 p-4 hover:bg-gray-50" data-testid={`setup-step-${s.id}`} data-done={s.done}>
              {s.done ? <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0 text-green-700" size={22} /> : <Circle aria-hidden="true" className="mt-0.5 shrink-0 text-gray-400" size={22} />}
              <span className="min-w-0">
                <span className="block font-semibold">
                  {i + 1}. {s.title} <span lang="bn" className="font-normal text-gray-600">· {s.titleBn}</span>
                </span>
                <span className="block text-sm text-gray-700">{s.detail}</span>
                <span className="mt-1 block text-xs font-semibold">{s.done ? "Done" : s.required ? "To do" : "Optional"}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </AdminShell>
  );
}
