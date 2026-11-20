import { getDb } from "@/db/client";
import { recoveryCodesLeft } from "@/modules/auth/setup";
import { AdminShell, Section } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { RecoveryCodes } from "./recovery-codes";

export const metadata = { title: "Account security · Admin" };

// The signed-in Owner's recovery codes: how many are left, and a new set (the old ones stop working).
export default async function SecurityPage() {
  const principal = await requireAdmin();
  const left = await recoveryCodesLeft(getDb(), principal.userId).catch(() => null);
  return (
    <AdminShell title="Account security" current="security">
      <Section title="Recovery codes">
        <p className="text-sm" data-testid="codes-left">
          {left === null ? "This database needs its latest update (migration 0021) first." : `${left} unused recovery code${left === 1 ? "" : "s"} left. Each one lets you set a new password once at /admin/recover.`}
        </p>
        {left !== null ? <RecoveryCodes /> : null}
      </Section>
    </AdminShell>
  );
}
