import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { isStaffRole, ROLE_INFO, ROLES, STAFF_ROLES } from "@/modules/auth/permissions";
import { type AccessEvent, LINK_HOURS, staffOverview } from "@/modules/auth/staff";
import { emailAvailable } from "@/modules/email/service";
import { ActionForm, Field, SelectField } from "../_components/action-form";
import { ActionPanel } from "../_components/panel";
import { AdminShell, formatTime, noticeFor, Section } from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { changeRoleAction, inviteStaffAction, passwordLinkAction, revokeLinkAction, revokeSessionsAction, setEnabledAction } from "./actions";

export const metadata = { title: "Staff & access · Admin" };

const roleOptions = STAFF_ROLES.map((r) => ({ value: r, label: ROLE_INFO[r].label }));
const roleLabel = (role: unknown) => (typeof role === "string" && (ROLES as readonly string[]).includes(role) ? ROLE_INFO[role as (typeof ROLES)[number]].label : "a role");

/** One line of access history in plain words. Ids and roles only are stored; names come from the accounts. */
function describe(e: AccessEvent): string {
  const who = e.actorName ?? "The system";
  const whom = e.subjectName ?? "someone";
  const d = e.detail;
  switch (e.event) {
    case "staff_invited":
      return `${who} sent an invitation as ${roleLabel(d.role)}`;
    case "staff_invitation_revoked":
      return `${who} revoked a link`;
    case "staff_joined":
      return `${whom} accepted the invitation as ${roleLabel(d.role)}`;
    case "staff_role_changed":
      return `${who} changed ${whom} from ${roleLabel(d.roleBefore)} to ${roleLabel(d.roleAfter)}`;
    case "staff_disabled":
      return `${who} disabled ${whom}'s access`;
    case "staff_enabled":
      return `${who} re-enabled ${whom}'s access`;
    case "staff_sessions_revoked":
      return `${who} signed ${whom} out everywhere`;
    case "staff_password_link":
      return `${who} sent ${whom} a set-password link`;
    case "staff_password_set":
      return `${whom} set a new password`;
    case "access_changed":
      return `Access record changed for ${whom}${d.roleAfter ? ` (${roleLabel(d.roleAfter)})` : ""}${d.disabledAfter === true ? ", disabled" : ""}`;
    default:
      return e.event.replace(/_/g, " ");
  }
}

const LINK_STATE: Record<string, { label: string; tone: "wait" | "ok" | "bad" | "quiet" }> = {
  open: { label: "Waiting to be used", tone: "wait" },
  expired: { label: "Expired", tone: "quiet" },
  accepted: { label: "Used", tone: "ok" },
  revoked: { label: "Revoked", tone: "quiet" },
};

// Staff & access (ADR-0013): who can use Admin, with which role, and the history of every change. Owner only (users:manage).
export default async function StaffPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requireAdmin("users:manage");
  const { done } = await searchParams;
  const { members, links, history } = await staffOverview(getDb(), principal);
  const email = emailAvailable();
  const notices: Record<string, string> = {
    invited: "Invitation emailed. It works once, for 72 hours.",
    "password-link": "Set-password link emailed. It works once, for 72 hours.",
    "link-revoked": "Link revoked. It no longer works.",
    "role-changed": "Role changed. It applies from their next page.",
    "staff-disabled": "Access disabled. They were signed out everywhere and cannot sign in.",
    "staff-enabled": "Access re-enabled. They can sign in again with their password.",
    "sessions-ended": "Signed out everywhere. They can sign in again with their password.",
  };
  const notice = typeof done === "string" ? (notices[done] ?? noticeFor(done)) : undefined;
  const open = links.filter((l) => l.state === "open");

  return (
    <AdminShell title="Staff & access" current="staff" notice={notice}>
      <p className="max-w-prose text-sm text-gray-700">
        Everyone who works in Admin signs in with their own email and password. A role decides what they can see and change; the server checks it on every page and action. Staff can never
        become an Owner, and nothing here can change your own access.
      </p>

      <Section title="People with access">
        <ul className="divide-y divide-gray-200" aria-label="People with access" data-testid="staff-list">
          {members.map((m) => {
            const staff = isStaffRole(m.role);
            return (
              <li key={m.userId} className="space-y-3 py-4 first:pt-0 last:pb-0" data-testid="staff-member" data-email={m.email}>
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {m.name}
                      {m.userId === principal.userId ? <span className="font-normal text-gray-600"> (you)</span> : null}
                    </p>
                    <p className="text-sm break-all text-gray-700">{m.email}</p>
                    <p className="text-xs text-gray-600">
                      {m.lastSignInAt ? `Last signed in ${formatTime(m.lastSignInAt)}` : "Has not signed in yet"}
                      {m.activeSessions ? `, signed in on ${m.activeSessions} device${m.activeSessions === 1 ? "" : "s"} now` : ""}
                    </p>
                  </div>
                  <p className="flex flex-wrap gap-2">
                    <span className="of-pill" data-tone={m.role === "owner" ? "move" : "quiet"} data-testid="staff-role">
                      {ROLE_INFO[m.role].label}
                    </span>
                    <span className="of-pill" data-tone={m.disabled ? "bad" : "ok"} data-testid="staff-status">
                      {m.disabled ? "Disabled" : "Active"}
                    </span>
                  </p>
                </div>
                {staff ? (
                  <ActionPanel key={`${m.userId}-${m.role}-${m.disabled}`} label={`Manage ${m.name}'s access`}>
                    <div className="grid gap-5 md:grid-cols-2">
                      <ActionForm action={changeRoleAction} idempotencyKey={randomUUID()} hidden={{ userId: m.userId, fromRole: m.role }} submitLabel="Change role" variant="secondary">
                        <SelectField name="role" label="Role" options={roleOptions} defaultValue={m.role} hint="Takes effect on their next page or action." />
                      </ActionForm>
                      <div className="space-y-3">
                        {m.disabled ? (
                          <ActionForm action={setEnabledAction} idempotencyKey={randomUUID()} hidden={{ userId: m.userId, enabled: "true" }} submitLabel="Re-enable access" variant="secondary" />
                        ) : (
                          <ActionForm
                            action={setEnabledAction}
                            idempotencyKey={randomUUID()}
                            hidden={{ userId: m.userId, enabled: "false" }}
                            submitLabel="Disable access"
                            variant="secondary"
                            confirm={`Disable ${m.name}'s access? They are signed out everywhere at once and cannot sign in until you re-enable them.`}
                          />
                        )}
                        {m.activeSessions > 0 ? (
                          <ActionForm
                            action={revokeSessionsAction}
                            idempotencyKey={randomUUID()}
                            hidden={{ userId: m.userId }}
                            submitLabel="Sign out everywhere"
                            variant="secondary"
                            confirm={`Sign ${m.name} out on every device? They can sign in again with their password.`}
                          />
                        ) : null}
                        <ActionForm
                          action={passwordLinkAction}
                          idempotencyKey={randomUUID()}
                          hidden={{ userId: m.userId }}
                          submitLabel={email ? "Email a set-password link" : "Create a set-password link"}
                          variant="secondary"
                          confirm={`Create a link for ${m.name} to set a new password? Their current password keeps working until they use it.`}
                        />
                      </div>
                    </div>
                  </ActionPanel>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Invite someone">
        <p className="text-sm text-gray-700">
          {email
            ? `We email them a link that works once, for ${LINK_HOURS} hours. They choose their own name and password; you never see or send a password.`
            : `Email is not set up, so you get a link to send them privately (for example on WhatsApp). It works once, for ${LINK_HOURS} hours. They choose their own name and password.`}
        </p>
        <ActionForm action={inviteStaffAction} idempotencyKey={randomUUID()} submitLabel={email ? "Send invitation" : "Create invitation link"}>
          <Field name="email" label="Their email" required maxLength={254} hint="They sign in with this address. It must not already have an Admin account." />
          <SelectField name="role" label="Role" options={roleOptions} defaultValue="orders" hint="You can change it later. See what each role can do below." />
        </ActionForm>
      </Section>

      <Section title="What each role can do">
        <div className="grid gap-4 md:grid-cols-2" data-testid="role-guide">
          {ROLES.map((role) => {
            const info = ROLE_INFO[role];
            return (
              <div key={role} className="space-y-2 rounded-xl border border-gray-200 p-4 text-sm">
                <p className="font-semibold">{info.label}</p>
                <p className="text-gray-700">{info.summary}</p>
                <ul className="list-disc space-y-0.5 ps-5" aria-label={`${info.label} can`}>
                  {info.can.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                {info.cannot.length ? (
                  <>
                    <p className="pt-1 font-semibold text-gray-800">Cannot</p>
                    <ul className="list-disc space-y-0.5 ps-5 text-gray-700" aria-label={`${info.label} cannot`}>
                      {info.cannot.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Invitations and links">
        {links.length ? (
          <ul className="divide-y divide-gray-200 text-sm" aria-label="Invitations and links" data-testid="staff-links">
            {links.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                <div className="min-w-0">
                  <p className="font-medium break-all">{l.email}</p>
                  <p className="text-xs text-gray-600">
                    {l.kind === "invite" ? `Invitation as ${roleLabel(l.role)}` : "Set-password link"}, created {formatTime(l.createdAt)}
                    {l.state === "open" ? `, works until ${formatTime(l.expiresAt)}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="of-pill" data-tone={LINK_STATE[l.state].tone}>
                    {LINK_STATE[l.state].label}
                  </span>
                  {l.state === "open" ? (
                    <ActionForm action={revokeLinkAction} idempotencyKey={randomUUID()} hidden={{ invitationId: l.id }} submitLabel="Revoke" variant="secondary" compact confirm="Revoke this link? It stops working at once." />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-700">No invitations yet. Invite someone above when you need help with orders, products or stock.</p>
        )}
        {open.length ? <p className="text-xs text-gray-600">Sending a new link to the same address revokes the old one.</p> : null}
      </Section>

      <Section title="Access history">
        {history.length ? (
          <ol className="of-timeline text-sm" aria-label="Access history" data-testid="access-history">
            {history.map((e) => (
              <li key={e.id}>
                <p className="font-medium">{describe(e)}</p>
                <p className="text-xs text-gray-600">{formatTime(e.at)}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-gray-700">Nothing has changed yet.</p>
        )}
      </Section>
    </AdminShell>
  );
}
