import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Database schema. Changes go through reviewed migrations in drizzle/ (README: Database migrations).
// Checks mirror the validation in src/modules so the database rejects bad data even if a caller skips it.

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
// Optimistic concurrency for editable rows: every update adds one, and an edit names the version it was
// based on, so a stale form or client cannot silently overwrite a newer change (migration 0007).
const version = () => integer("version").notNull().default(1);

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
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("products_version_positive", sql`${t.version} >= 1`),
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
    // Stored only in canonical form (ASCII uppercase letters, digits, hyphen, underscore; 1-64 characters),
    // so a plain unique constraint also rejects case and whitespace variants of an existing SKU.
    sku: text("sku").notNull().unique("variants_sku_key"),
    size: text("size"),
    colour: text("colour"),
    // Integer paisa. The upper bound is Number.MAX_SAFE_INTEGER, so every stored value is exact as a JS number.
    pricePaisa: bigint("price_paisa", { mode: "number" }).notNull(),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("variants_version_positive", sql`${t.version} >= 1`),
    index("variants_product_id_idx").on(t.productId),
    check("variants_sku_canonical", sql`${t.sku} ~ '^[A-Z0-9_-]{1,64}$'`),
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
    // Units held for orders that are not dispatched yet (migration 0008). Available = on_hand - reserved.
    // Changed only together with stock_reservations rows; never a physical movement.
    reserved: integer("reserved").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("inventory_balances_on_hand_nonnegative", sql`${t.onHand} >= 0`),
    check("inventory_balances_reserved_valid", sql`${t.reserved} >= 0 and ${t.reserved} <= ${t.onHand}`),
  ],
);

// Append-only ledger: UPDATE, DELETE and TRUNCATE are rejected by a trigger (migration 0001).
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "restrict" }),
    // dispatch: an order left the shop (negative, from its reservation). return_restock: an inspected
    // return or RTO unit passed and became sellable again (positive). Both name their order (migration 0008).
    movementType: text("movement_type", { enum: ["receipt", "adjustment", "dispatch", "return_restock"] }).notNull(),
    quantityDelta: integer("quantity_delta").notNull(),
    reason: text("reason"),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    // A named system source, or an authenticated user (requirement OF-9, ADR-0003). For a user, actor_ref
    // is the user's immutable id as text and actor_user_id the same id, so the row always names a user that
    // exists. Users referenced here cannot be deleted.
    actorType: text("actor_type", { enum: ["system", "user"] }).notNull(),
    actorRef: text("actor_ref").notNull(),
    actorUserId: uuid("actor_user_id").references(() => authUsers.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_movements_variant_id_id_idx").on(t.variantId, t.id),
    check("stock_movements_type_valid", sql`${t.movementType} in ('receipt', 'adjustment', 'dispatch', 'return_restock')`),
    check(
      "stock_movements_delta_valid",
      sql`${t.quantityDelta} <> 0 and (${t.movementType} not in ('receipt', 'return_restock') or ${t.quantityDelta} > 0) and (${t.movementType} <> 'dispatch' or ${t.quantityDelta} < 0)`,
    ),
    check("stock_movements_order_link", sql`(${t.movementType} in ('dispatch', 'return_restock')) = (${t.orderId} is not null)`),
    check(
      "stock_movements_reason_valid",
      sql`(${t.movementType} <> 'adjustment' or ${t.reason} is not null) and btrim(${t.reason}) <> '' and length(${t.reason}) <= 500`,
    ),
    check("stock_movements_actor_type_valid", sql`${t.actorType} in ('system', 'user')`),
    check("stock_movements_actor_ref_format", sql`${t.actorRef} ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'`),
    check(
      "stock_movements_actor_user_consistent",
      sql`(${t.actorType} = 'system' and ${t.actorUserId} is null) or (${t.actorType} = 'user' and ${t.actorUserId} is not null and ${t.actorRef} = ${t.actorUserId}::text)`,
    ),
  ],
);

// Authentication tables used by Better Auth (ADR-0003). Columns follow the official Drizzle schema that
// @better-auth/drizzle-adapter 1.7.25 generates for this configuration (email and password, UUID ids,
// database rate limiting), with project naming and timestamptz. The adapter maps Better Auth's model names
// (user, session, ...) to these tables in src/modules/auth/auth.ts. Never add a role or permission here:
// authorisation state lives in user_access, which no Better Auth endpoint can write.

export const authUsers = pgTable(
  "auth_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Better Auth lowercases emails before writing and looking them up; the check keeps direct writes in line.
    email: text("email").notNull().unique("auth_users_email_key"),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("auth_users_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique("auth_sessions_token_key"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_sessions_user_id_idx").on(t.userId)],
);

// Credential and (unused) provider accounts. For email and password, provider_id is 'credential' and
// password holds Better Auth's scrypt hash, never the password itself.
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("auth_accounts_user_id_idx").on(t.userId)],
);

// Part of Better Auth's core schema. Nothing in this gate writes it (email verification and password reset
// endpoints are disabled), but the library requires the table.
export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);

// Rate-limit counters shared by every application process. key is "<client ip>|<path>"; no credentials.
export const authRateLimits = pgTable("auth_rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique("auth_rate_limits_key_key"),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// Application authorisation state, owned by this project and not by Better Auth. A user without a row, or
// with disabled_at set, has no permissions and cannot start a session. Only the local Owner bootstrap
// (scripts/bootstrap-owner.mts) writes it today.
export const userAccess = pgTable(
  "user_access",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner"] }).notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("user_access_role_valid", sql`${t.role} in ('owner')`)],
);

// Operation-level idempotency (src/modules/idempotency). One row per user and client-generated key: the row
// is claimed by INSERT inside the business transaction, so it commits or rolls back with that operation,
// and a concurrent request with the same key waits on the primary key until the first one finishes.
// `result` is a reference to what was committed (for example a ledger row id), filled in before the same
// transaction commits; a committed row with a null result is a bug (tested). No request body, header,
// credential or personal data is stored: only a SHA-256 fingerprint of the canonical request. Rows are
// kept; there is no expiry or reuse of old keys until a retention policy is approved (docs/api/README.md).
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    result: jsonb("result"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "idempotency_records_pkey", columns: [t.userId, t.idempotencyKey] }),
    check("idempotency_records_key_format", sql`${t.idempotencyKey} ~ '^[A-Za-z0-9_.:-]{16,128}$'`),
    check("idempotency_records_operation_format", sql`${t.operation} ~ '^[a-z][a-z0-9.-]{0,63}$'`),
    check("idempotency_records_fingerprint_format", sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
    check("idempotency_records_result_object", sql`jsonb_typeof(${t.result}) = 'object'`),
  ],
);

// /api/v1 request counters: one fixed window per verified user and category (read or write). Only an
// authenticated request reaches the counter, so anonymous traffic cannot use up a user's quota. The limits
// themselves are configuration (src/modules/rate-limit), not stored here.
export const apiRateLimits = pgTable(
  "api_rate_limits",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    bucket: text("bucket", { enum: ["read", "write"] }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    primaryKey({ name: "api_rate_limits_pkey", columns: [t.userId, t.bucket] }),
    check("api_rate_limits_bucket_valid", sql`${t.bucket} in ('read', 'write')`),
    check("api_rate_limits_count_positive", sql`${t.count} >= 1`),
  ],
);

// ---------------------------------------------------------------------------------------------------------
// Orders (migration 0008). Business rules: docs/product/order-policy-decisions.md. Four lifecycle dimensions
// are separate columns (O-1); order source is an attribute (O-2). Money is integer paisa, times UTC.
// Orders and their audit rows are never deleted; every foreign key into them is ON DELETE RESTRICT.

const userRef = (name: string) => uuid(name).references(() => authUsers.id, { onDelete: "restrict" });

// One row per configured zone. A zone without a row, or inactive, cannot take orders (founder rule I). The
// amounts are the Owner's; none is hardcoded. updated_by names the Owner who last changed it.
export const deliveryZones = pgTable(
  "delivery_zones",
  {
    code: text("code", { enum: ["dhaka_city", "outside_dhaka"] }).primaryKey(),
    chargePaisa: bigint("charge_paisa", { mode: "number" }).notNull(),
    active: boolean("active").notNull(),
    version: version(),
    updatedAt: updatedAt(),
    updatedByUserId: userRef("updated_by_user_id").notNull(),
  },
  (t) => [
    check("delivery_zones_code_valid", sql`${t.code} in ('dhaka_city', 'outside_dhaka')`),
    check("delivery_zones_charge_range", sql`${t.chargePaisa} >= 0 and ${t.chargePaisa} <= 1000000`),
    check("delivery_zones_version_positive", sql`${t.version} >= 1`),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Short reference for people (shown as text, e.g. ORD-000042). Never a credential: tracking uses tokens.
    number: bigint("number", { mode: "number" }).notNull().unique("orders_number_key").generatedAlwaysAsIdentity(),
    source: text("source", { enum: ["website", "messenger", "whatsapp", "other"] }).notNull(),
    customerName: text("customer_name").notNull(),
    // Normalised Bangladesh mobile number, 01XXXXXXXXX, kept as text (O-7).
    customerPhone: text("customer_phone").notNull(),
    deliveryAddress: text("delivery_address").notNull(),
    deliveryZone: text("delivery_zone", { enum: ["dhaka_city", "outside_dhaka"] })
      .notNull()
      .references(() => deliveryZones.code, { onDelete: "restrict" }),
    note: text("note"),
    // Price snapshot at submission; later catalogue or rate changes never alter it (O-15, rule I).
    subtotalPaisa: bigint("subtotal_paisa", { mode: "number" }).notNull(),
    deliveryChargePaisa: bigint("delivery_charge_paisa", { mode: "number" }).notNull(),
    totalPaisa: bigint("total_paisa", { mode: "number" }).notNull(),
    orderStatus: text("order_status", { enum: ["pending_verification", "verification_expired", "confirmed", "cancelled", "closed"] }).notNull(),
    fulfilmentStatus: text("fulfilment_status", { enum: ["unfulfilled", "packed", "dispatched", "delivered", "rto", "rto_received"] }).notNull(),
    paymentStatus: text("payment_status", { enum: ["unpaid", "partially_collected", "collected", "settled"] }).notNull(),
    returnStatus: text("return_status", { enum: ["none", "requested", "in_progress", "resolved"] }).notNull(),
    // Running totals of payment_entries, updated in the same transaction as each entry.
    codCollectedPaisa: bigint("cod_collected_paisa", { mode: "number" }).notNull().default(0),
    codSettledPaisa: bigint("cod_settled_paisa", { mode: "number" }).notNull().default(0),
    refundedPaisa: bigint("refunded_paisa", { mode: "number" }).notNull().default(0),
    rtoChargePaisa: bigint("rto_charge_paisa", { mode: "number" }),
    verificationExpiresAt: timestamp("verification_expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    version: version(),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_status_expiry_idx").on(t.orderStatus, t.verificationExpiresAt),
    index("orders_created_at_idx").on(t.createdAt, t.id),
    check("orders_source_valid", sql`${t.source} in ('website', 'messenger', 'whatsapp', 'other')`),
    check("orders_customer_name_valid", sql`btrim(${t.customerName}) <> '' and length(${t.customerName}) <= 100`),
    check("orders_customer_phone_format", sql`${t.customerPhone} ~ '^01[3-9][0-9]{8}$'`),
    check("orders_address_valid", sql`btrim(${t.deliveryAddress}) <> '' and length(${t.deliveryAddress}) <= 500`),
    check("orders_note_valid", sql`btrim(${t.note}) <> '' and length(${t.note}) <= 1000`),
    check(
      "orders_amounts_valid",
      sql`${t.subtotalPaisa} > 0 and ${t.deliveryChargePaisa} >= 0 and ${t.totalPaisa} = ${t.subtotalPaisa} + ${t.deliveryChargePaisa} and ${t.totalPaisa} <= 9007199254740991`,
    ),
    check(
      "orders_status_valid",
      sql`${t.orderStatus} in ('pending_verification', 'verification_expired', 'confirmed', 'cancelled', 'closed')`,
    ),
    check(
      "orders_fulfilment_status_valid",
      sql`${t.fulfilmentStatus} in ('unfulfilled', 'packed', 'dispatched', 'delivered', 'rto', 'rto_received')`,
    ),
    check("orders_return_status_valid", sql`${t.returnStatus} in ('none', 'requested', 'in_progress', 'resolved')`),
    // Money actually handled: never more settled than collected, never more collected than expected, never
    // more refunded than collected (founder rules J and M).
    check(
      "orders_cod_amounts_valid",
      sql`${t.codSettledPaisa} >= 0 and ${t.codSettledPaisa} <= ${t.codCollectedPaisa} and ${t.codCollectedPaisa} <= ${t.totalPaisa} and ${t.refundedPaisa} >= 0 and ${t.refundedPaisa} <= ${t.codCollectedPaisa}`,
    ),
    // Payment status is a function of the amounts, so it can never disagree with them.
    check(
      "orders_payment_status_derived",
      sql`${t.paymentStatus} = case when ${t.codCollectedPaisa} = 0 then 'unpaid' when ${t.codCollectedPaisa} < ${t.totalPaisa} then 'partially_collected' when ${t.codSettledPaisa} < ${t.codCollectedPaisa} then 'collected' else 'settled' end`,
    ),
    check("orders_rto_charge_valid", sql`${t.rtoChargePaisa} >= 0 and ${t.rtoChargePaisa} <= 1000000`),
    // Cross-dimension consistency: only confirmed orders move physically; cancellation happens before dispatch.
    check(
      "orders_fulfilment_consistent",
      sql`(${t.orderStatus} in ('pending_verification', 'verification_expired') and ${t.fulfilmentStatus} = 'unfulfilled')
        or (${t.orderStatus} = 'cancelled' and ${t.fulfilmentStatus} in ('unfulfilled', 'packed'))
        or (${t.orderStatus} = 'confirmed')
        or (${t.orderStatus} = 'closed' and ${t.fulfilmentStatus} in ('delivered', 'rto_received'))`,
    ),
    check("orders_closed_at_consistent", sql`(${t.closedAt} is not null) = (${t.orderStatus} in ('cancelled', 'closed'))`),
    check("orders_delivered_at_consistent", sql`${t.deliveredAt} is null or ${t.fulfilmentStatus} = 'delivered' or ${t.orderStatus} = 'closed'`),
    check("orders_version_positive", sql`${t.version} >= 1`),
  ],
);

// One line per SKU (lines for the same SKU are merged at submission), with the catalogue snapshot.
export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "restrict" }),
    sku: text("sku").notNull(),
    productNameEn: text("product_name_en"),
    productNameBn: text("product_name_bn"),
    size: text("size"),
    colour: text("colour"),
    unitPricePaisa: bigint("unit_price_paisa", { mode: "number" }).notNull(),
    quantity: integer("quantity").notNull(),
    lineTotalPaisa: bigint("line_total_paisa", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("order_items_order_variant_key").on(t.orderId, t.variantId),
    check("order_items_name_present", sql`${t.productNameEn} is not null or ${t.productNameBn} is not null`),
    check("order_items_quantity_range", sql`${t.quantity} between 1 and 1000`),
    check(
      "order_items_amounts_valid",
      sql`${t.unitPricePaisa} > 0 and ${t.lineTotalPaisa} = ${t.unitPricePaisa} * ${t.quantity} and ${t.lineTotalPaisa} <= 9007199254740991`,
    ),
  ],
);

// Per-order, per-SKU stock holds. While active, the quantity is counted in inventory_balances.reserved;
// a hold ends exactly once: released (cancellation or verification expiry) or consumed (dispatch).
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    status: text("status", { enum: ["active", "released", "consumed"] }).notNull(),
    releaseReason: text("release_reason", { enum: ["cancelled", "expired"] }),
    createdAt: createdAt(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("stock_reservations_active_key").on(t.orderId, t.variantId).where(sql`${t.status} = 'active'`),
    index("stock_reservations_order_id_idx").on(t.orderId),
    check("stock_reservations_quantity_positive", sql`${t.quantity} > 0`),
    check("stock_reservations_status_valid", sql`${t.status} in ('active', 'released', 'consumed')`),
    check(
      "stock_reservations_end_consistent",
      sql`(${t.status} = 'active' and ${t.endedAt} is null and ${t.releaseReason} is null)
        or (${t.status} = 'released' and ${t.endedAt} is not null and ${t.releaseReason} in ('cancelled', 'expired'))
        or (${t.status} = 'consumed' and ${t.endedAt} is not null and ${t.releaseReason} is null)`,
    ),
  ],
);

// Append-only order history (trigger, migration 0008): what happened, when and by whom. Customers act only
// through a tracking link (actor_type 'customer', no identity). detail holds amounts and ids, never contact data.
export const orderEvents = pgTable(
  "order_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    event: text("event").notNull(),
    actorType: text("actor_type", { enum: ["system", "user", "customer"] }).notNull(),
    actorRef: text("actor_ref").notNull(),
    actorUserId: userRef("actor_user_id"),
    detail: jsonb("detail"),
    createdAt: createdAt(),
  },
  (t) => [
    index("order_events_order_id_id_idx").on(t.orderId, t.id),
    check("order_events_event_format", sql`${t.event} ~ '^[a-z][a-z_]{1,49}$'`),
    check("order_events_actor_type_valid", sql`${t.actorType} in ('system', 'user', 'customer')`),
    check("order_events_actor_ref_format", sql`${t.actorRef} ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'`),
    check(
      "order_events_actor_user_consistent",
      sql`(${t.actorType} in ('system', 'customer') and ${t.actorUserId} is null) or (${t.actorType} = 'user' and ${t.actorUserId} is not null and ${t.actorRef} = ${t.actorUserId}::text)`,
    ),
    check("order_events_detail_object", sql`jsonb_typeof(${t.detail}) = 'object'`),
  ],
);

// A customer's request to cancel a confirmed, undispatched order (founder rule C). At most one open per order.
export const cancellationRequests = pgTable(
  "cancellation_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["open", "approved", "rejected"] }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: userRef("reviewed_by_user_id"),
  },
  (t) => [
    uniqueIndex("cancellation_requests_open_key").on(t.orderId).where(sql`${t.status} = 'open'`),
    check("cancellation_requests_status_valid", sql`${t.status} in ('open', 'approved', 'rejected')`),
    check("cancellation_requests_reason_valid", sql`btrim(${t.reason}) <> '' and length(${t.reason}) <= 500`),
    check(
      "cancellation_requests_review_consistent",
      sql`(${t.status} = 'open') = (${t.reviewedAt} is null) and (${t.reviewedAt} is null) = (${t.reviewedByUserId} is null)`,
    ),
  ],
);

// A return or exchange request (founder rules E, F, M). At most one open per order.
export const returns = pgTable(
  "returns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: ["return", "exchange"] }).notNull(),
    reason: text("reason", { enum: ["size_or_preference", "wrong_or_defective"] }).notNull(),
    // Who bears return shipping follows from the reason (rule F); the actual cost is recorded separately.
    shippingPaidBy: text("shipping_paid_by", { enum: ["customer", "business"] }).notNull(),
    returnShippingCostPaisa: bigint("return_shipping_cost_paisa", { mode: "number" }),
    status: text("status", { enum: ["requested", "received", "approved", "rejected", "completed"] }).notNull(),
    note: text("note"),
    createdAt: createdAt(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdByUserId: userRef("created_by_user_id").notNull(),
  },
  (t) => [
    uniqueIndex("returns_open_key").on(t.orderId).where(sql`${t.status} in ('requested', 'received', 'approved')`),
    check("returns_kind_valid", sql`${t.kind} in ('return', 'exchange')`),
    check("returns_reason_valid", sql`${t.reason} in ('size_or_preference', 'wrong_or_defective')`),
    check(
      "returns_shipping_responsibility",
      sql`${t.shippingPaidBy} = case when ${t.reason} = 'wrong_or_defective' then 'business' else 'customer' end`,
    ),
    check("returns_shipping_cost_valid", sql`${t.returnShippingCostPaisa} >= 0 and ${t.returnShippingCostPaisa} <= 1000000`),
    check("returns_status_valid", sql`${t.status} in ('requested', 'received', 'approved', 'rejected', 'completed')`),
    check("returns_note_valid", sql`btrim(${t.note}) <> '' and length(${t.note}) <= 500`),
    check(
      "returns_dates_consistent",
      sql`(${t.status} = 'requested') = (${t.receivedAt} is null) and (${t.status} in ('requested', 'received')) = (${t.decidedAt} is null) and (${t.status} = 'completed') = (${t.completedAt} is not null)`,
    ),
  ],
);

export const returnItems = pgTable(
  "return_items",
  {
    returnId: uuid("return_id")
      .notNull()
      .references(() => returns.id, { onDelete: "restrict" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
  },
  (t) => [
    primaryKey({ name: "return_items_pkey", columns: [t.returnId, t.orderItemId] }),
    check("return_items_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

// Returned or RTO units awaiting inspection: never part of on_hand until a passed inspection restocks them
// through exactly one return_restock ledger row (founder rule G). A failed inspection stays out of stock.
export const quarantineItems = pgTable(
  "quarantine_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "restrict" }),
    source: text("source", { enum: ["rto", "return"] }).notNull(),
    returnId: uuid("return_id").references(() => returns.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    status: text("status", { enum: ["awaiting_inspection", "restocked", "rejected"] }).notNull(),
    note: text("note"),
    restockMovementId: bigint("restock_movement_id", { mode: "number" })
      .unique("quarantine_items_restock_movement_key")
      .references(() => stockMovements.id, { onDelete: "restrict" }),
    receivedAt: createdAt(),
    inspectedAt: timestamp("inspected_at", { withTimezone: true }),
    inspectedByUserId: userRef("inspected_by_user_id"),
  },
  (t) => [
    index("quarantine_items_order_id_idx").on(t.orderId),
    check("quarantine_items_source_valid", sql`${t.source} in ('rto', 'return')`),
    check("quarantine_items_return_link", sql`(${t.source} = 'return') = (${t.returnId} is not null)`),
    check("quarantine_items_quantity_positive", sql`${t.quantity} > 0`),
    check("quarantine_items_status_valid", sql`${t.status} in ('awaiting_inspection', 'restocked', 'rejected')`),
    check("quarantine_items_note_valid", sql`btrim(${t.note}) <> '' and length(${t.note}) <= 500`),
    check(
      "quarantine_items_inspection_consistent",
      sql`(${t.status} = 'awaiting_inspection') = (${t.inspectedAt} is null) and (${t.inspectedAt} is null) = (${t.inspectedByUserId} is null) and (${t.status} = 'restocked') = (${t.restockMovementId} is not null)`,
    ),
  ],
);

// Append-only COD money record (trigger, migration 0008): courier collection, settlement to the Owner, and
// manual refunds (founder rules J and M). orders keeps the running totals, updated in the same transaction.
export const paymentEntries = pgTable(
  "payment_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: ["collected", "settled", "refunded"] }).notNull(),
    amountPaisa: bigint("amount_paisa", { mode: "number" }).notNull(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    method: text("method", { enum: ["bkash", "nagad", "bank_transfer"] }),
    reference: text("reference"),
    returnId: uuid("return_id").references(() => returns.id, { onDelete: "restrict" }),
    actorUserId: userRef("actor_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("payment_entries_order_id_idx").on(t.orderId),
    check("payment_entries_kind_valid", sql`${t.kind} in ('collected', 'settled', 'refunded')`),
    check("payment_entries_amount_valid", sql`${t.amountPaisa} > 0 and ${t.amountPaisa} <= 9007199254740991`),
    check(
      "payment_entries_refund_consistent",
      sql`(${t.kind} = 'refunded') = (${t.method} is not null) and (${t.kind} = 'refunded') = (${t.returnId} is not null)`,
    ),
    check("payment_entries_method_valid", sql`${t.method} in ('bkash', 'nagad', 'bank_transfer')`),
    check("payment_entries_reference_valid", sql`btrim(${t.reference}) <> '' and length(${t.reference}) <= 100`),
  ],
);

// Guest tracking credentials (founder rule K, S-15). Only the SHA-256 digest of the random token is stored.
// One active link per order; a revoked link never works again. Lifetime: until 30 days after closed_at.
export const orderTrackingTokens = pgTable(
  "order_tracking_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique("order_tracking_tokens_token_hash_key"),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("order_tracking_tokens_active_key").on(t.orderId).where(sql`${t.revokedAt} is null`),
    check("order_tracking_tokens_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

// Public tracking request counters. No client address is trusted, so the keys are global buckets
// ('lookup', 'failure'); a per-client limit waits for the hosting and proxy decision.
export const trackingRateLimits = pgTable(
  "tracking_rate_limits",
  {
    bucket: text("bucket").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    check("tracking_rate_limits_bucket_valid", sql`${t.bucket} in ('lookup', 'failure')`),
    check("tracking_rate_limits_count_positive", sql`${t.count} >= 1`),
  ],
);

// ---------------------------------------------------------------------------------------------------------
// Owner operations (migration 0009): export audit and physical stock counts.

// Append-only record of every export the Owner requested (requirements D-6, OF-6; trigger, migration 0009):
// who, when, which dataset and format, and the filters as safe metadata (dates and status values only, never
// contact data or file contents). Written before the file is generated, so a failed export is audited too.
export const exportRequests = pgTable(
  "export_requests",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: userRef("actor_user_id").notNull(),
    dataset: text("dataset").notNull(),
    format: text("format", { enum: ["xlsx", "csv", "json"] }).notNull(),
    scope: text("scope", { enum: ["complete", "filtered"] }).notNull(),
    filters: jsonb("filters").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("export_requests_created_at_idx").on(t.createdAt),
    check("export_requests_dataset_valid", sql`${t.dataset} ~ '^[a-z][a-z_]{1,49}$'`),
    check("export_requests_format_valid", sql`${t.format} in ('xlsx', 'csv', 'json')`),
    check("export_requests_scope_valid", sql`${t.scope} in ('complete', 'filtered')`),
    check("export_requests_filters_object", sql`jsonb_typeof(${t.filters}) = 'object'`),
  ],
);

// A physical stock count (requirement I-8): a snapshot of the selected SKUs, counted quantities entered by the
// Owner, and, when applied, one reasoned `adjustment` ledger row per SKU whose count differs. Never a direct
// balance edit. A draft can be resumed; applied and discarded counts are closed for good.
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Short reference for people (COUNT-000001), like orders.number.
    number: bigint("number", { mode: "number" }).notNull().unique("stock_counts_number_key").generatedAlwaysAsIdentity(),
    status: text("status", { enum: ["draft", "applied", "discarded"] }).notNull(),
    scope: text("scope", { enum: ["all", "selected"] }).notNull(),
    reason: text("reason"),
    version: version(),
    createdByUserId: userRef("created_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: userRef("closed_by_user_id"),
  },
  (t) => [
    index("stock_counts_created_at_idx").on(t.createdAt),
    check("stock_counts_status_valid", sql`${t.status} in ('draft', 'applied', 'discarded')`),
    check("stock_counts_scope_valid", sql`${t.scope} in ('all', 'selected')`),
    check("stock_counts_reason_valid", sql`btrim(${t.reason}) <> '' and length(${t.reason}) <= 400`),
    check("stock_counts_version_positive", sql`${t.version} >= 1`),
    check(
      "stock_counts_close_consistent",
      sql`(${t.status} = 'draft') = (${t.closedAt} is null) and (${t.closedAt} is null) = (${t.closedByUserId} is null)`,
    ),
  ],
);

// One SKU in a count. snapshot_* is the system balance when the count started (printed on the count sheet).
// When the Owner enters a counted quantity, basis_on_hand and basis_movement_id record the balance and the
// SKU's latest ledger row at that moment: applying refuses a line whose SKU moved since (a stale count is
// never applied as counted - old snapshot). applied_delta and movement_id are set once, when applied.
export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    countId: uuid("count_id")
      .notNull()
      .references(() => stockCounts.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "restrict" }),
    snapshotOnHand: integer("snapshot_on_hand").notNull(),
    snapshotReserved: integer("snapshot_reserved").notNull(),
    counted: integer("counted"),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    basisOnHand: integer("basis_on_hand"),
    // 0 when the SKU had no ledger rows yet (identity ids start at 1).
    basisMovementId: bigint("basis_movement_id", { mode: "number" }),
    appliedDelta: integer("applied_delta"),
    movementId: bigint("movement_id", { mode: "number" })
      .unique("stock_count_lines_movement_key")
      .references(() => stockMovements.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ name: "stock_count_lines_pkey", columns: [t.countId, t.variantId] }),
    check("stock_count_lines_snapshot_valid", sql`${t.snapshotOnHand} >= 0 and ${t.snapshotReserved} >= 0 and ${t.snapshotReserved} <= ${t.snapshotOnHand}`),
    check(
      "stock_count_lines_count_consistent",
      sql`(${t.counted} is null) = (${t.countedAt} is null) and (${t.counted} is null) = (${t.basisOnHand} is null) and (${t.counted} is null) = (${t.basisMovementId} is null)`,
    ),
    check("stock_count_lines_counted_valid", sql`${t.counted} >= 0 and ${t.basisOnHand} >= 0 and ${t.basisMovementId} >= 0`),
    check("stock_count_lines_applied_consistent", sql`${t.movementId} is null or (${t.appliedDelta} is not null and ${t.appliedDelta} <> 0)`),
  ],
);
