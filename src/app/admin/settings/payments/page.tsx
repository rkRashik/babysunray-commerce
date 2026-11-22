import { randomUUID } from "node:crypto";
import { Banknote } from "lucide-react";
import { getDb } from "@/db/client";
import { MANUAL_METHODS, METHOD_LABELS, type ManualMethod, type PaymentMethodRow, paymentMethodsForAdmin } from "@/modules/settings/payments";
import { ActionForm, Checkbox, Field, SelectField } from "../../_components/action-form";
import { EditableSection } from "../../_components/editable-section";
import { AdminShell, formatTime, Section } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { savePaymentMethodAction } from "./actions";

export const metadata = { title: "Payment methods · Admin" };

const HOW: Record<ManualMethod, string> = {
  bkash: "Customers send money from their own bKash app to your number, then type the transaction ID on their order page.",
  nagad: "Customers send money from their own Nagad app to your number, then type the transaction ID on their order page.",
  bank_transfer: "Customers transfer from their own bank to your account, then type the transaction reference on their order page.",
};

/** The saved details as customers will see them (the preview), or what is still missing. */
function View({ method, row }: { method: ManualMethod; row: PaymentMethodRow | undefined }) {
  if (!row) {
    return (
      <p className="rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-700" data-testid={`method-${method}`}>
        Not set up. Customers do not see {METHOD_LABELS[method].en} until you add your receiving details and turn it on.
      </p>
    );
  }
  const lines: [string, string | null][] = [
    ["Bank", row.bankName],
    ["Account name", row.accountName],
    [method === "bank_transfer" ? "Account number" : `${METHOD_LABELS[method].en} number`, row.accountNumber],
    ["Branch", row.branchName],
    ["Routing number", row.routingNumber],
    ["Account type", row.accountKind === "merchant" ? "Merchant (customers use Payment)" : row.accountKind === "personal" ? "Personal (customers use Send Money)" : null],
    ["Instructions (English)", row.instructionsEn],
    ["Instructions (Bangla)", row.instructionsBn],
  ];
  return (
    <div className="space-y-3" data-testid={`method-${method}`}>
      <p className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
        <span className="of-pill" data-tone={row.enabled ? "ok" : "quiet"} data-testid={`method-${method}-state`}>
          {row.enabled ? "Offered to customers" : "Off"}
        </span>
        {row.enabled && row.approvedAt ? `Approved ${formatTime(row.approvedAt)}` : `Last changed ${formatTime(row.updatedAt)}`}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {lines
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-gray-600">{k}</dt>
              <dd className="break-words whitespace-pre-line">{v}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

// Manual payment methods (ADR-0013). Cash on delivery is always offered and needs nothing here. bKash, Nagad and bank
// transfer are offered only after the Owner enters the receiving details and approves them. No gateway is connected.
export default async function PaymentMethodsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requireAdmin("settings:write");
  const { done } = await searchParams;
  const saved = await paymentMethodsForAdmin(getDb(), principal);
  return (
    <AdminShell title="Payment methods" current="payments" notice={done === "payment-saved" ? "Payment method saved. New orders use it from now on." : undefined}>
      <p className="max-w-prose text-sm text-gray-700">
        Choose how customers may pay. Each advance payment is a transfer the customer makes themselves; nothing is connected to bKash, Nagad or a bank, so you check every payment in your own
        account before marking it verified on the order. Changes apply to new orders and to the payment details shown on open orders.
      </p>

      <Section title="Cash on delivery">
        <p className="flex items-start gap-3 text-sm">
          <Banknote aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
          <span>Always offered. The courier collects the order total when the parcel arrives; you record what was collected and settled on each order.</span>
        </p>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        {MANUAL_METHODS.map((method) => {
          const row = saved.get(method);
          const bank = method === "bank_transfer";
          return (
            <EditableSection key={`${method}-${row?.version ?? 0}`} title={METHOD_LABELS[method].en} editLabel={row ? "Change" : "Set up"} view={<View method={method} row={row} />}>
              <ActionForm action={savePaymentMethodAction} idempotencyKey={randomUUID()} hidden={{ method, version: String(row?.version ?? 0) }} submitLabel="Save payment method">
                <p className="text-sm text-gray-700">{HOW[method]}</p>
                {bank ? <Field name="bankName" label="Bank name" maxLength={80} defaultValue={row?.bankName ?? ""} /> : null}
                <Field name="accountName" label="Account name" maxLength={80} defaultValue={row?.accountName ?? ""} hint="The name customers see on the transfer, so they know it reaches you." />
                <Field
                  name="accountNumber"
                  label={bank ? "Account number" : `${METHOD_LABELS[method].en} receiving number`}
                  inputMode={bank ? "numeric" : "text"}
                  maxLength={40}
                  defaultValue={row?.accountNumber ?? ""}
                  hint={bank ? "Digits only; spaces and hyphens are removed." : "A Bangladesh mobile number, such as 01712345678."}
                />
                {bank ? (
                  <>
                    <Field name="branchName" label="Branch (optional)" maxLength={80} defaultValue={row?.branchName ?? ""} />
                    <Field name="routingNumber" label="Routing number (optional)" inputMode="numeric" maxLength={12} defaultValue={row?.routingNumber ?? ""} hint="9 digits, only if customers need it." />
                  </>
                ) : (
                  <SelectField
                    name="accountKind"
                    label="Account type"
                    defaultValue={row?.accountKind ?? ""}
                    options={[
                      { value: "", label: "Choose…" },
                      { value: "merchant", label: "Merchant account (customers use Payment)" },
                      { value: "personal", label: "Personal account (customers use Send Money)" },
                    ]}
                    hint={`Check with ${METHOD_LABELS[method].en} that the account may receive business payments before you offer it.`}
                  />
                )}
                <Field name="instructionsEn" label="Short instructions for customers (English, optional)" multiline maxLength={300} defaultValue={row?.instructionsEn ?? ""} />
                <Field name="instructionsBn" label="Short instructions for customers (Bangla, optional)" multiline maxLength={300} lang="bn" defaultValue={row?.instructionsBn ?? ""} />
                <Checkbox name="enabled" label={`Offer ${METHOD_LABELS[method].en} to customers`} defaultChecked={row?.enabled ?? false} />
                <Checkbox name="approved" label="I confirm this account is mine (the store's) and may receive the store's payments" />
                <p className="text-xs text-gray-600">Turning it on needs every detail above and your confirmation. Never enter a PIN, password or OTP here: none is needed.</p>
              </ActionForm>
            </EditableSection>
          );
        })}
      </div>
    </AdminShell>
  );
}
