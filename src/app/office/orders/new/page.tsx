import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getDb } from "@/db/client";
import { listDeliveryZones } from "@/modules/orders/delivery";
import { ZONE_LABELS } from "@/modules/orders/rules";
import { ActionForm, Choice, Field } from "../../_components/action-form";
import { OfficeShell, Section } from "../../_components/shell";
import { requireOffice } from "../../_lib/session";
import { createOrderAction } from "../actions";
import { bdt } from "../_components/labels";

export const metadata = { title: "New order · Owner Office" };

const LINES = 5;

// An order taken on Messenger, WhatsApp or another channel, entered by the Owner. The server checks stock,
// prices and the delivery charge; nothing typed here is trusted as an amount.
export default async function NewOrderPage() {
  await requireOffice("orders:write");
  const zones = (await listDeliveryZones(getDb())).filter((z) => z.active);
  return (
    <OfficeShell title="New assisted order" current="orders" breadcrumbs={[{ href: "/office/orders", label: "Orders" }]}>
      {zones.length === 0 ? (
        <p role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
          No delivery charge is configured yet, so no order can be taken. <Link href="/office/settings/delivery" className="underline">Set the delivery charges</Link> first.
        </p>
      ) : (
        <Section title="Order details">
          <p className="text-sm text-gray-700">
            The order starts as Pending Verification and its stock is reserved at once. Verify it with the customer within 24 hours; after that the stock is released and the
            order waits for your review.
          </p>
          <ActionForm action={createOrderAction} idempotencyKey={randomUUID()} submitLabel="Create order">
            <Choice
              name="source"
              legend="Taken on"
              options={[
                { value: "messenger", label: "Messenger" },
                { value: "whatsapp", label: "WhatsApp" },
                { value: "other", label: "Other" },
              ]}
            />
            <Field name="customerName" label="Customer name" required maxLength={100} />
            <Field name="customerPhone" label="Phone" required maxLength={20} inputMode="numeric" hint="Bangladesh mobile number, for example 01712345678." />
            <Field name="deliveryAddress" label="Delivery address" required multiline maxLength={500} />
            <Choice
              name="deliveryZone"
              legend="Delivery zone"
              options={zones.map((z) => ({ value: z.code, label: `${ZONE_LABELS[z.code]} (${bdt(z.chargePaisa)})` }))}
            />
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Items (SKU and quantity; empty lines are ignored)</legend>
              {Array.from({ length: LINES }, (_, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-end gap-2">
                  <Field name={`sku${i}`} label={`SKU, line ${i + 1}`} maxLength={64} />
                  <Field name={`qty${i}`} label={`Quantity, line ${i + 1}`} inputMode="numeric" maxLength={4} />
                </div>
              ))}
            </fieldset>
            <Field name="note" label="Note for yourself" multiline maxLength={1000} hint="Optional. Not shown to the customer." />
          </ActionForm>
        </Section>
      )}
    </OfficeShell>
  );
}
