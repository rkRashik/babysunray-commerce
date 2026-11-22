import { getDb } from "@/db/client";
import { recoveryCodesLeft } from "@/modules/auth/setup";
import { AdminShell, Section } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { RecoveryCodes } from "./recovery-codes";

export const metadata = { title: "Account security · Admin" };

// The signed-in Owner's recovery codes: how many are left, and a new set (the old ones stop working). Recovery codes exist
// for the Owner only; a staff member who forgets a password gets a new set-password link from the Owner (Staff & access).
export default async function SecurityPage() {
  const principal = await requireAdmin();
  if (principal.role !== "owner") {
    return (
      <AdminShell title="Account security" current="security">
        <Section title="Your password">
          <p className="text-sm" data-testid="staff-security">
            You sign in with your own email and password. If you forget your password, ask the Owner to send you a new set-password link from Staff &amp; access.
            Never share your password; the Owner never needs it.
          </p>
        </Section>
      </AdminShell>
    );
  }
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
