import { randomUUID } from "node:crypto";
import { BrandLogo } from "@/app/_design/brand";
import { currentStoreIdentity } from "@/app/_design/identity";
import { getDb } from "@/db/client";
import { emailAvailable } from "@/modules/email/service";
import { storeSettingsForAdmin } from "@/modules/settings/store";
import { ActionForm, Field } from "../../_components/action-form";
import { AdminShell, Section, noticeFor } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { updateStoreIdentityAction } from "../actions";

export const metadata = { title: "Store settings · Admin" };

const ERRORS: Record<string, string> = {
  too_large: "The file is larger than 5 MB.",
  empty: "Choose an image file first.",
  image: "That file is not a usable image (PNG, JPEG or WebP, not too large after optimisation).",
  conflict: "The settings changed after you opened them. Reload and try again.",
  invalid: "The upload could not be read. Try again.",
  failed: "The logo could not be saved. Try again.",
};

// The store's identity, contact channels and logo (src/modules/settings/store.ts). An empty field uses the installation
// default. Only details you give are shown to customers: nothing is invented.
export default async function StoreSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requireAdmin("settings:write");
  const { done, error } = await searchParams;
  const { settings, schemaReady } = await storeSettingsForAdmin(getDb(), principal);
  const identity = await currentStoreIdentity();
  const version = String(settings?.version ?? 0);
  const message = typeof error === "string" ? ERRORS[error] : undefined;
  return (
    <AdminShell title="Store settings" current="store" notice={noticeFor(done)}>
      {!schemaReady ? (
        <p role="alert" className="rounded border border-amber-400 bg-amber-50 p-4 text-sm">
          This database needs its latest update (migration 0021) before the store settings can be saved.
        </p>
      ) : null}
      {message ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {message}
        </p>
      ) : null}
      <Section title="Name, description and contact · নাম ও যোগাযোগ">
        <p className="text-sm text-gray-700">What customers see in the shop and in emails. Leave a field empty to show nothing (or the installation default).</p>
        <ActionForm action={updateStoreIdentityAction} idempotencyKey={randomUUID()} hidden={{ version }} submitLabel="Save">
          <Field name="storeName" label="Store name" maxLength={60} defaultValue={settings?.storeName ?? ""} hint={`Shown now: ${identity.storeName}`} />
          <Field name="lineEn" label="Short description (English)" maxLength={200} defaultValue={settings?.lineEn ?? ""} />
          <Field name="lineBn" label="Short description (Bangla)" maxLength={200} lang="bn" defaultValue={settings?.lineBn ?? ""} />
          <Field name="contactPhone" label="Phone" maxLength={30} defaultValue={settings?.contactPhone ?? ""} />
          <Field name="contactEmail" label="Email" maxLength={120} defaultValue={settings?.contactEmail ?? ""} />
          <Field name="contactWhatsapp" label="WhatsApp number" maxLength={30} defaultValue={settings?.contactWhatsapp ?? ""} />
          <Field name="contactMessenger" label="Messenger link" maxLength={200} defaultValue={settings?.contactMessenger ?? ""} hint="For example https://m.me/yourpage" />
        </ActionForm>
      </Section>
      <Section title="Logo · লোগো">
        <div className="rounded-xl bg-gray-50 p-4">
          <BrandLogo name={identity.storeName} logo={identity.logo} height={48} textClassName="text-[1.75rem]" />
        </div>
        <form action="/admin/settings/store/logo" method="post" encType="multipart/form-data" className="space-y-3">
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <input type="hidden" name="version" value={version} />
          <label className="block text-sm font-semibold" htmlFor="logo-file">
            Upload your approved logo (PNG with a transparent background works best; at most 5 MB)
          </label>
          <input id="logo-file" name="logo" type="file" accept="image/png,image/jpeg,image/webp" required className="block text-sm" />
          <button type="submit" className="of-btn of-btn-primary">
            Save logo
          </button>
        </form>
        {settings?.logoSha256 ? (
          <form action="/admin/settings/store/logo" method="post" encType="multipart/form-data">
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <input type="hidden" name="version" value={version} />
            <input type="hidden" name="remove" value="1" />
            <button type="submit" className="of-btn of-btn-line">
              Remove uploaded logo
            </button>
          </form>
        ) : null}
      </Section>
      <Section title="Email · ইমেইল">
        <p className="text-sm" data-testid="email-state">
          {emailAvailable()
            ? "Email is set up: customers can create accounts with email and reset their passwords."
            : "Email is not set up. Customers can still order as guests and sign in with Google. To offer email accounts and password reset, set RESEND_API_KEY and EMAIL_FROM in the site's settings."}
        </p>
      </Section>
    </AdminShell>
  );
}
