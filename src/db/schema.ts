import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Database schema. Changes go through reviewed migrations in drizzle/ (README: Database migrations).
// Checks mirror the validation in src/modules so the database rejects bad data even if a caller skips it.

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// A product is never published by this schema: publication rules (requirement I-6) are not approved yet.
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique("products_slug_key"),
    nameEn: text("name_en"),
    nameBn: text("name_bn"),
    descriptionEn: text("description_en"),
    descriptionBn: text("description_bn"),
    status: text("status", { enum: ["draft", "archived"] }).notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("products_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 100`),
    check("products_status_valid", sql`${t.status} in ('draft', 'archived')`),
    check("products_name_present", sql`${t.nameEn} is not null or ${t.nameBn} is not null`),
    check(
      "products_names_valid",
      sql`btrim(${t.nameEn}) <> '' and length(${t.nameEn}) <= 200 and btrim(${t.nameBn}) <> '' and length(${t.nameBn}) <= 200`,
    ),
    check(
      "products_descriptions_valid",
      sql`btrim(${t.descriptionEn}) <> '' and length(${t.descriptionEn}) <= 5000 and btrim(${t.descriptionBn}) <> '' and length(${t.descriptionBn}) <= 5000`,
    ),
  ],
);

export const variants = pgTable(
  "variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    // Stored only in canonical form (trimmed, uppercase, NFC), so a plain unique constraint
    // also rejects case and whitespace variants of an existing SKU.
    sku: text("sku").notNull().unique("variants_sku_key"),
    size: text("size"),
    colour: text("colour"),
    // Integer paisa. The upper bound is Number.MAX_SAFE_INTEGER, so every stored value is exact as a JS number.
    pricePaisa: bigint("price_paisa", { mode: "number" }).notNull(),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("variants_product_id_idx").on(t.productId),
    check(
      "variants_sku_canonical",
      sql`${t.sku} = upper(btrim(${t.sku})) and ${t.sku} is nfc normalized and ${t.sku} !~ '[[:cntrl:]]' and length(${t.sku}) between 1 and 64`,
    ),
    check(
      "variants_labels_valid",
      sql`btrim(${t.size}) <> '' and length(${t.size}) <= 64 and btrim(${t.colour}) <> '' and length(${t.colour}) <= 64`,
    ),
    check("variants_price_range", sql`${t.pricePaisa} > 0 and ${t.pricePaisa} <= 9007199254740991`),
    check("variants_status_valid", sql`${t.status} in ('active', 'inactive')`),
  ],
);

// One physical on-hand balance per SKU, created with the variant. Changed only together with a stock movement.
export const inventoryBalances = pgTable(
  "inventory_balances",
  {
    variantId: uuid("variant_id")
      .primaryKey()
      .references(() => variants.id, { onDelete: "restrict" }),
    onHand: integer("on_hand").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [check("inventory_balances_on_hand_nonnegative", sql`${t.onHand} >= 0`)],
);

// Append-only ledger: UPDATE, DELETE and TRUNCATE are rejected by a trigger (migration 0001).
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "restrict" }),
    movementType: text("movement_type", { enum: ["receipt", "adjustment"] }).notNull(),
    quantityDelta: integer("quantity_delta").notNull(),
    reason: text("reason"),
    // Only non-user system actors exist until authentication is approved (requirement OF-9).
    actorType: text("actor_type", { enum: ["system"] }).notNull(),
    actorRef: text("actor_ref").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_movements_variant_id_id_idx").on(t.variantId, t.id),
    check("stock_movements_type_valid", sql`${t.movementType} in ('receipt', 'adjustment')`),
    check(
      "stock_movements_delta_valid",
      sql`${t.quantityDelta} <> 0 and (${t.movementType} <> 'receipt' or ${t.quantityDelta} > 0)`,
    ),
    check(
      "stock_movements_reason_valid",
      sql`(${t.movementType} <> 'adjustment' or ${t.reason} is not null) and btrim(${t.reason}) <> '' and length(${t.reason}) <= 500`,
    ),
    check("stock_movements_actor_type_valid", sql`${t.actorType} in ('system')`),
    check("stock_movements_actor_ref_format", sql`${t.actorRef} ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'`),
  ],
);
