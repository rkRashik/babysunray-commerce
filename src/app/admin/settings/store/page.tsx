import { randomUUID } from "node:crypto";
import { BrandLogo, hasInstallationLogo } from "@/app/_design/brand";
import { currentStoreIdentity } from "@/app/_design/identity";
import { DEFAULT_STORE_NAME } from "@/config/installation";
import { getDb } from "@/db/client";
import { emailSettings } from "@/modules/email/service";
import { storeSettingsForAdmin } from "@/modules/settings/store";
import { ActionForm, Field } from "../../_components/action-form";
import { EditableSection } from "../../_components/editable-section";
import { AdminShell, Section, formatTime, noticeFor } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { updateStoreIdentityAction } from "../actions";
import { LogoSection } from "./logo-section";

export const metadata = { title: "Store settings · Admin" };

// Answers of the logo route (/admin/settings/store/logo), shown in the logo card.
const LOGO_ERRORS: Record<string, string> = {
  too_large: "The file is larger than 5 MB.",
  empty: "No file was chosen.",
  image: "That file is not a usable image (PNG, JPEG or WebP, not too large after optimisation).",
  conflict: "The settings changed after you opened this page (another tab?). Reload and try again.",
  invalid: "The upload could not be read. Try again.",
  failed: "The logo could not be saved. Try again.",
};

/** Whether customer account emails can be sent, from the server's settings (names only, never values). */
function emailStatus(): { state: "ready" | "off" | "broken"; detail?: string } {
  try {
    return emailSettings(process.env) ? { state: "ready" } : { state: "off" };
  } catch (error) {
    return { state: "broken", detail: error instanceof Error ? error.message : undefined };
  }
}

/** One saved detail as text: what customers see, or that nothing is shown. */
function Detail({ label, value, note, lang }: { label: string; value: string | null | undefined; note?: string; lang?: string }) {
  return (
    <div className="grid gap-0.5 border-b border-gray-200 py-2.5 last:border-b-0 sm:grid-cols-[13rem_1fr] sm:gap-4">
      <dt className="text-sm text-gray-600">{label}</dt>
      <dd className="min-w-0 break-words">
        {value ? (
          <>
            <span lang={lang} className="font-medium">
              {value}
            </span>
            {note ? <span className="text-sm text-gray-600"> · {note}</span> : null}
          </>
        ) : (
          <span className="text-gray-500">Not set</span>
        )}
      </dd>
    </div>
  );
}

// The store's identity, contact channels and logo (src/modules/settings/store.ts), and whether customer account emails
// can be sent. Saved values are shown as text; editing is a deliberate step. Only details you give are shown to customers.
export default async function StoreSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requireAdmin("settings:write");
  const { done, error } = await searchParams;
  const { settings, schemaReady } = await storeSettingsForAdmin(getDb(), principal);
  const identity = await currentStoreIdentity();
  const version = String(settings?.version ?? 0);
  const installed = (own: string | null | undefined, shown: string | null | undefined) => (!own && shown ? "from the installation settings" : undefined);
  const storeName = identity.storeName === DEFAULT_STORE_NAME ? null : identity.storeName;
  const uploaded = Boolean(settings?.logoSha256);
  const fallback = hasInstallationLogo() ? "the installation's logo file" : "the store name as text";
  const email = emailStatus();

  return (
    <AdminShell title="Store settings" current="store" notice={noticeFor(done)}>
      {!schemaReady ? (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          This database needs its latest update (migration 0021) before the store settings can be saved.
        </p>
      ) : null}

      <EditableSection
        key={`details-${version}`}
        title="Store details"
        editLabel="Edit details"
        view={
          <div className="space-y-3">
            <p className="text-sm text-gray-700">What customers see in the shop and in emails. A detail that is not set is not shown.</p>
            <dl data-testid="store-details">
              <Detail label="Store name" value={storeName} note={installed(settings?.storeName, storeName)} />
              <Detail label="Short description (English)" value={identity.storeLine.en} note={installed(settings?.lineEn, identity.storeLine.en)} />
              <Detail label="Short description (Bangla)" value={identity.storeLine.bn} lang="bn" note={installed(settings?.lineBn, identity.storeLine.bn)} />
              <Detail label="Phone" value={identity.contact.phone} note={installed(settings?.contactPhone, identity.contact.phone)} />
              <Detail label="Email" value={identity.contact.email} note={installed(settings?.contactEmail, identity.contact.email)} />
              <Detail label="WhatsApp number" value={settings?.contactWhatsapp} />
              <Detail label="Messenger link" value={settings?.contactMessenger} />
            </dl>
            {settings?.updatedAt ? <p className="text-xs text-gray-600">Last changed {formatTime(settings.updatedAt)}</p> : null}
          </div>
        }
      >
        <ActionForm action={updateStoreIdentityAction} idempotencyKey={randomUUID()} hidden={{ version }} submitLabel="Save changes">
          <p className="text-sm text-gray-700">Leave a field empty to show nothing, or the installation&apos;s default where it has one.</p>
          <Field name="storeName" label="Store name" maxLength={60} defaultValue={settings?.storeName ?? ""} hint="Shown in the shop's header, in emails and in Admin." />
          <Field name="lineEn" label="Short description (English)" maxLength={200} defaultValue={settings?.lineEn ?? ""} />
          <Field name="lineBn" label="Short description (Bangla)" maxLength={200} lang="bn" defaultValue={settings?.lineBn ?? ""} />
          <Field name="contactPhone" label="Phone" maxLength={30} defaultValue={settings?.contactPhone ?? ""} />
          <Field name="contactEmail" label="Email" maxLength={120} defaultValue={settings?.contactEmail ?? ""} />
          <Field name="contactWhatsapp" label="WhatsApp number" maxLength={30} defaultValue={settings?.contactWhatsapp ?? ""} />
          <Field name="contactMessenger" label="Messenger link" maxLength={200} defaultValue={settings?.contactMessenger ?? ""} hint="For example https://m.me/yourpage" />
        </ActionForm>
      </EditableSection>

      <LogoSection
        key={`logo-${version}`}
        logo={<BrandLogo name={identity.storeName} logo={identity.logo} height={56} textClassName="text-[1.75rem]" />}
        source={uploaded ? `Uploaded here${settings?.updatedAt ? `; settings last changed ${formatTime(settings.updatedAt)}` : ""}.` : `No logo uploaded here: the shop shows ${fallback}.`}
        uploaded={uploaded}
        fallback={fallback}
        version={version}
        uploadKey={randomUUID()}
        removeKey={randomUUID()}
        error={typeof error === "string" && error in LOGO_ERRORS ? LOGO_ERRORS[error] : undefined}
        disabled={!schemaReady}
      />

      <Section title="Customer account emails">
        <div className="space-y-3 text-sm text-gray-800">
          <p>When a customer makes an account with an email address, the shop emails them:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              a <strong>verification email</strong>, with a link that confirms the address is theirs;
            </li>
            <li>
              a <strong>password reset email</strong>, when they forget their password.
            </li>
          </ul>
          <p className="text-gray-700">Ordering never needs an email account: guests can order without one.</p>
        </div>
        <dl className="rounded-xl border border-gray-200" data-testid="email-state">
          <div className="grid gap-1 border-b border-gray-200 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4">
            <dt className="text-sm text-gray-600">Email service</dt>
            <dd className="space-y-1">
              <span className="of-pill" data-tone={email.state === "ready" ? "ok" : email.state === "broken" ? "bad" : "quiet"}>
                {email.state === "ready" ? "Set up" : email.state === "broken" ? "Settings incomplete" : "Not set up"}
              </span>
              <p className="text-sm text-gray-700">
                {email.state === "ready"
                  ? "The site has the settings it needs to send these emails."
                  : email.state === "broken"
                    ? "Some email settings are missing or not valid, so no email can be sent. Customers cannot make email accounts or reset passwords until this is fixed."
                    : "No email can be sent, so customers cannot make email accounts or reset passwords."}
              </p>
            </dd>
          </div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4">
            <dt className="text-sm text-gray-600">Delivery</dt>
            <dd className="space-y-1">
              <span className="of-pill" data-tone="quiet">
                Not checked
              </span>
              <p className="text-sm text-gray-700">
                Admin keeps no record of emails reaching customers, so it cannot tell you whether they arrive.
                {email.state === "ready" ? " To check, make a customer account in the shop with an email address you own, and see that the verification email arrives (look in the spam folder too)." : ""}
              </p>
            </dd>
          </div>
        </dl>
        {email.state !== "ready" ? (
          <details className="text-sm text-gray-700">
            <summary className="py-3 font-semibold lg:py-1">For the person who sets up the website</summary>
            <p className="mt-2">
              Emails are sent through Resend. The site needs the settings <code translate="no">RESEND_API_KEY</code> and <code translate="no">EMAIL_FROM</code> (a sender address on a domain
              verified in Resend).
              {email.detail ? ` Problem found: ${email.detail}` : ""}
            </p>
          </details>
        ) : null}
      </Section>
    </AdminShell>
  );
}
