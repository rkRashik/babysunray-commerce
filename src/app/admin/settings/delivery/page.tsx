import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { formatPaisa } from "@/modules/money";
import { listDeliveryZones } from "@/modules/orders/delivery";
import { DELIVERY_ZONES, ZONE_LABELS } from "@/modules/orders/rules";
import { ActionForm, Checkbox, Field } from "../../_components/action-form";
import { AdminShell, Section, formatTime, noticeFor } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { setDeliveryZoneAction } from "../../orders/actions";

export const metadata = { title: "Delivery charges · Admin" };

// The two approved zones. No amount is built in: a zone takes orders only once you set a charge and mark it
// active. A change applies to new orders; existing orders keep the charge they were placed with.
export default async function DeliverySettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin("orders:read", "settings:write");
  const { done } = await searchParams;
  const zones = new Map((await listDeliveryZones(getDb())).map((z) => [z.code, z]));
  return (
    <AdminShell title="Delivery charges" current="delivery" notice={noticeFor(done)}>
      <p className="text-sm text-gray-700">
        Set the charge for each zone in Taka. New orders snapshot the charge; existing orders never change. A zone without an active charge cannot take orders.
      </p>
      <div className="grid gap-6 md:grid-cols-2">
        {DELIVERY_ZONES.map((code) => {
          const zone = zones.get(code);
          return (
            <Section key={code} title={ZONE_LABELS[code]}>
              <p className="text-sm text-gray-700" data-testid={`zone-${code}`}>
                {zone ? `${zone.active ? "Active" : "Not taking orders"} · ৳ ${formatPaisa(zone.chargePaisa)} · last changed ${formatTime(zone.updatedAt)}` : "Not configured yet: orders to this zone are refused."}
              </p>
              <ActionForm action={setDeliveryZoneAction} idempotencyKey={randomUUID()} hidden={{ code, version: zone ? String(zone.version) : "" }} submitLabel="Save">
                <Field name="chargeTaka" label="Charge (BDT)" required inputMode="decimal" defaultValue={zone ? formatPaisa(zone.chargePaisa) : ""} hint="0 to 10000, up to two decimals." />
                <Checkbox name="active" label="Take orders for this zone" defaultChecked={zone?.active ?? true} />
              </ActionForm>
            </Section>
          );
        })}
      </div>
    </AdminShell>
  );
}
