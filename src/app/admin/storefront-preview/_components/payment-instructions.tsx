"use client";

import { Copy, ShieldAlert, Wallet } from "lucide-react";
import { useState } from "react";
import type { PaymentDetails } from "@/modules/settings/payments";
import { dictionary, formatTaka, type Lang } from "@/modules/storefront/i18n";

// Where to send a manual advance payment (ADR-0013): the store's receiving details as the Owner entered them, the exact
// amount, and the reminder that this is not an online payment. Shown after an order and on the order's private page.

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="sf-btn sf-btn-ghost sf-btn-sm gap-1.5"
      onClick={() =>
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      <Copy aria-hidden="true" size={15} strokeWidth={2} />
      <span>{copied ? (label === "Copy" ? "Copied" : "কপি হয়েছে") : label}</span>
    </button>
  );
}

export function PaymentInstructions({ lang, details, amountPaisa, method }: { lang: Lang; details: PaymentDetails | null; amountPaisa: number; method: string }) {
  const t = dictionary(lang);
  const name = t.methodNames[method] ?? method;
  const copy = lang === "bn" ? "কপি" : "Copy";
  return (
    <section aria-labelledby="sf-pay-title" className="space-y-4 rounded-[1.25rem] border border-sf-line bg-sf-card p-5" data-testid="payment-instructions">
      <h2 id="sf-pay-title" className="sf-plain flex items-center gap-2 text-lg">
        <Wallet aria-hidden="true" size={20} strokeWidth={1.75} />
        {t.payTitle}: {name}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-[0.9375rem]">
        <dt className="text-sf-ink-2">{t.payAmount}</dt>
        <dd className="sf-price text-[1.375rem]" data-testid="payment-amount">
          {formatTaka(amountPaisa, lang)}
        </dd>
        {details ? (
          <>
            {details.bankName ? (
              <>
                <dt className="text-sf-ink-2">{t.payBank}</dt>
                <dd>{details.bankName}</dd>
              </>
            ) : null}
            <dt className="text-sf-ink-2">{t.payAccountName}</dt>
            <dd>{details.accountName}</dd>
            <dt className="text-sf-ink-2">{details.method === "bank_transfer" ? t.payAccountNumber : t.payNumber(name)}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span className="sf-num text-[1.125rem] font-bold tracking-wide" lang="en" data-testid="payment-number">
                {details.accountNumber}
              </span>
              <CopyValue value={details.accountNumber} label={copy} />
            </dd>
            {details.branchName ? (
              <>
                <dt className="text-sf-ink-2">{t.payBranch}</dt>
                <dd>{details.branchName}</dd>
              </>
            ) : null}
            {details.routingNumber ? (
              <>
                <dt className="text-sf-ink-2">{t.payRouting}</dt>
                <dd className="sf-num" lang="en">
                  {details.routingNumber}
                </dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {details ? (
        <>
          {details.accountKind ? <p className="text-[0.9375rem]">{details.accountKind === "merchant" ? t.payMerchant : t.payPersonal}</p> : null}
          {(lang === "bn" ? (details.instructions.bn ?? details.instructions.en) : (details.instructions.en ?? details.instructions.bn)) ? (
            <p className="text-[0.9375rem] whitespace-pre-line" data-testid="payment-owner-note">
              {lang === "bn" ? (details.instructions.bn ?? details.instructions.en) : (details.instructions.en ?? details.instructions.bn)}
            </p>
          ) : null}
        </>
      ) : (
        <p className="sf-note font-semibold" data-tone="warn">
          {t.payDetailsMissing}
        </p>
      )}
      <p className="sf-note" data-tone="warn">
        <ShieldAlert aria-hidden="true" size={18} strokeWidth={1.75} />
        <span>{t.payNotGateway}</span>
      </p>
    </section>
  );
}
