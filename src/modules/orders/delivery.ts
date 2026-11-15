import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { deliveryZones } from "@/db/schema";
import type { Actor } from "../actor";
import { DomainError, invalidInput } from "../domain-error";
import { DELIVERY_ZONES, type DeliveryZone, MAX_DELIVERY_CHARGE_PAISA, validateAmountPaisa } from "./rules";

// Owner-configured delivery charges for the two approved zones (founder rule I). No amount is built in: a
// zone that was never configured has no row and takes no orders. Orders snapshot the charge, so a later
// edit never changes an existing order.

export type DeliveryZoneRow = typeof deliveryZones.$inferSelect;

export const listDeliveryZones = (db: Db) => db.select().from(deliveryZones).orderBy(asc(deliveryZones.code));

/**
 * Creates the zone's rate (expectedVersion null) or changes it (the version the Owner last saw; a stale one
 * gets VERSION_CONFLICT). Records who changed it.
 */
export async function setDeliveryZone(
  tx: Db,
  code: DeliveryZone,
  input: { chargePaisa: number; active: boolean; expectedVersion: number | null },
  actor: Actor,
): Promise<DeliveryZoneRow> {
  if (!DELIVERY_ZONES.includes(code)) throw invalidInput("zone", "must be dhaka_city or outside_dhaka");
  const chargePaisa = validateAmountPaisa(input.chargePaisa, "chargePaisa", { allowZero: true, max: MAX_DELIVERY_CHARGE_PAISA });
  if (typeof input.active !== "boolean") throw invalidInput("active", "must be true or false");
  const [current] = await tx.select().from(deliveryZones).where(eq(deliveryZones.code, code)).for("update");
  const conflict = new DomainError("VERSION_CONFLICT", "This delivery charge was changed after you loaded it. Reload it and try again.");
  if (!current) {
    if (input.expectedVersion !== null) throw conflict;
    const inserted = await tx
      .insert(deliveryZones)
      .values({ code, chargePaisa, active: input.active, updatedByUserId: actor.ref })
      .onConflictDoNothing()
      .returning();
    // Another request configured it at the same moment.
    if (inserted.length === 0) throw conflict;
    return inserted[0];
  }
  if (input.expectedVersion !== current.version) throw conflict;
  const [updated] = await tx
    .update(deliveryZones)
    .set({ chargePaisa, active: input.active, version: sql`${deliveryZones.version} + 1`, updatedAt: sql`now()`, updatedByUserId: actor.ref })
    .where(eq(deliveryZones.code, code))
    .returning();
  return updated;
}
