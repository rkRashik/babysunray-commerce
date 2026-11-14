import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
    // Stored only in canonical form (ASCII uppercase letters, digits, hyphen, underscore; 1-64 characters),
    // so a plain unique constraint also rejects case and whitespace variants of an existing SKU.
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
    check("stock_movements_type_valid", sql`${t.movementType} in ('receipt', 'adjustment')`),
    check(
      "stock_movements_delta_valid",
      sql`${t.quantityDelta} <> 0 and (${t.movementType} <> 'receipt' or ${t.quantityDelta} > 0)`,
    ),
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
