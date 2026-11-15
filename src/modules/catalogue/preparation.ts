import "server-only";
import { inArray, type SQL, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { productMeasurements, productMedia, products, variants } from "@/db/schema";
import { assertPermission, type Principal } from "../auth/principal";
import { type PreparationItem, READINESS_ITEMS } from "./readiness";

// The readiness checklist (readiness.ts) as SQL, so the Office can count and filter products by what they still
// need without loading every product. Each expression is true when the item is MET for the product row; an
// integration test checks that they agree with evaluateReadiness for real rows. Like the checklist, this is
// advisory: it never makes a product eligible for publication (no publication rule is approved).

const activeVariant = (extra?: SQL) => sql`exists (select 1 from ${variants} v where v.product_id = ${products.id} and v.status = 'active'${extra ? sql` and ${extra}` : sql``})`;
const hasMedia = sql`exists (select 1 from ${productMedia} m where m.product_id = ${products.id})`;

export const MET: Record<PreparationItem, SQL> = {
  name: sql`(${products.nameEn} is not null and ${products.nameBn} is not null)`,
  description: sql`(${products.descriptionEn} is not null and ${products.descriptionBn} is not null)`,
  variant: activeVariant(),
  measurements: sql`(${activeVariant(sql`v.size is not null`)} and not ${activeVariant(sql`v.size is not null and not exists (select 1 from ${productMeasurements} pm where pm.product_id = ${products.id} and pm.size = v.size)`)})`,
  fabric: sql`(${products.fabricEn} is not null and ${products.fabricBn} is not null and ${products.fabricConfirmedAt} is not null)`,
  care: sql`(${products.careEn} is not null and ${products.careBn} is not null)`,
  sizes: sql`(${activeVariant()} and not ${activeVariant(sql`v.size is null`)})`,
  category: sql`(${products.categoryId} is not null)`,
  photo: hasMedia,
  alt: sql`(${hasMedia} and not exists (select 1 from ${productMedia} m where m.product_id = ${products.id} and (m.alt_en is null or m.alt_bn is null)))`,
};

export const isPreparationItem = (value: unknown): value is PreparationItem => typeof value === "string" && Object.hasOwn(MET, value);

/** Which items each of these products meets (for list indicators). One query, whatever the number of products. */
export async function readinessFlags(db: Db, productIds: string[]): Promise<Map<string, Record<PreparationItem, boolean>>> {
  if (productIds.length === 0) return new Map();
  const columns = Object.fromEntries(READINESS_ITEMS.map((i) => [i.id, sql<boolean>`${MET[i.id]}`.mapWith(Boolean)])) as Record<PreparationItem, SQL.Aliased<boolean> | SQL<boolean>>;
  const rows = await db
    .select({ id: products.id, ...(columns as Record<PreparationItem, SQL<boolean>>) })
    .from(products)
    .where(inArray(products.id, productIds));
  return new Map(rows.map(({ id, ...flags }) => [id, flags as Record<PreparationItem, boolean>]));
}

export type PreparationOverview = { drafts: number; unmet: Record<PreparationItem, number> };

/** How many draft products do not yet meet each item. One query, read-only. */
export async function preparationOverview(db: Db, principal: Principal): Promise<PreparationOverview> {
  assertPermission(principal, "catalog:read");
  const counts = Object.fromEntries(READINESS_ITEMS.map((i) => [i.id, sql<number>`count(*) filter (where not ${MET[i.id]})`.mapWith(Number)])) as Record<PreparationItem, SQL<number>>;
  const [row] = await db
    .select({ drafts: sql<number>`count(*)`.mapWith(Number), ...counts })
    .from(products)
    .where(sql`${products.status} = 'draft'`);
  const { drafts, ...unmet } = row;
  return { drafts, unmet: unmet as Record<PreparationItem, number> };
}
