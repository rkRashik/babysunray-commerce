import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { formatPaisa } from "@/modules/money";
import { listDeliveryZones } from "@/modules/orders/delivery";
import { DELIVERY_ZONES, ZONE_LABELS } from "@/modules/orders/rules";
import { ActionForm, Checkbox, Field } from "../../_components/action-form";
import { EditableSection } from "../../_components/editable-section";
import { AdminShell, formatTime, noticeFor } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { setDeliveryZoneAction } from "../../orders/actions";
import { bdt } from "../../orders/_components/labels";

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
        The delivery charge added to each new order, by zone. Changing it never changes orders already placed. A zone without an active charge cannot take orders.
      </p>
      <div className="grid gap-6 md:grid-cols-2">
        {DELIVERY_ZONES.map((code) => {
          const zone = zones.get(code);
          return (
            <EditableSection
              key={`${code}-${zone?.version ?? 0}`}
              title={ZONE_LABELS[code]}
              editLabel={zone ? "Change charge" : "Set charge"}
              view={
                zone ? (
                  <div className="space-y-2" data-testid={`zone-${code}`}>
                    <p className="text-[1.75rem] leading-none font-bold tabular-nums">{bdt(zone.chargePaisa)}</p>
                    <p className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
                      <span className="of-pill" data-tone={zone.active ? "ok" : "bad"}>
                        {zone.active ? "Taking orders" : "Not taking orders"}
                      </span>
                      Last changed {formatTime(zone.updatedAt)}
                    </p>
                  </div>
                ) : (
                  <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950" data-testid={`zone-${code}`}>
                    Not set yet: orders to this zone are refused until you set a charge.
                  </p>
                )
              }
            >
              <ActionForm action={setDeliveryZoneAction} idempotencyKey={randomUUID()} hidden={{ code, version: zone ? String(zone.version) : "" }} submitLabel="Save charge">
                <Field name="chargeTaka" label="Charge (BDT)" required inputMode="decimal" defaultValue={zone ? formatPaisa(zone.chargePaisa) : ""} hint="0 to 10000, up to two decimals." />
                <Checkbox name="active" label="Take orders for this zone" defaultChecked={zone?.active ?? true} />
              </ActionForm>
            </EditableSection>
          );
        })}
      </div>
    </AdminShell>
  );
}
