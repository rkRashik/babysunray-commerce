import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Database schema. Changes go through reviewed migrations in drizzle/ (docs/getting-started.md, section 4).
// Checks mirror the validation in src/modules so the database rejects bad data even if a caller skips it.

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
// Optimistic concurrency for editable rows: every update adds one, and an edit names the version it was
// based on, so a stale form or client cannot silently overwrite a newer change (migration 0007).
const version = () => integer("version").notNull().default(1);

// Owner-defined product categories (migration 0011), bilingual like products. No category is built in.
export const productCategories = pgTable(
  "product_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique("product_categories_slug_key"),
    nameEn: text("name_en"),
    nameBn: text("name_bn"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("product_categories_version_positive", sql`${t.version} >= 1`),
    check("product_categories_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 100`),
    check("product_categories_name_present", sql`${t.nameEn} is not null or ${t.nameBn} is not null`),
    check(
      "product_categories_names_valid",
      sql`btrim(${t.nameEn}) <> '' and length(${t.nameEn}) <= 100 and btrim(${t.nameBn}) <> '' and length(${t.nameBn}) <= 100`,
    ),
  ],
);

// Status: draft (editable, never shown to customers), published (shown by the published-only public reads; its
// content cannot be edited, migration 0014) or archived (never undone). No code path can publish while no
// publication rule (requirement I-6) is approved: src/modules/catalogue/publication.ts.
const PRODUCT_STATUSES = ["draft", "published", "archived"] as const;
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique("products_slug_key"),
    nameEn: text("name_en"),
    nameBn: text("name_bn"),
    descriptionEn: text("description_en"),
    descriptionBn: text("description_bn"),
    status: text("status", { enum: PRODUCT_STATUSES }).notNull().default("draft"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Structured content (migration 0011). Everything here is entered by the Owner; nothing is generated, and a
    // fabric statement counts as confirmed only after the Owner confirms it (requirement S-11). Changing the
    // fabric text clears the confirmation.
    categoryId: uuid("category_id").references(() => productCategories.id, { onDelete: "restrict" }),
    fabricEn: text("fabric_en"),
    fabricBn: text("fabric_bn"),
    fabricConfirmedAt: timestamp("fabric_confirmed_at", { withTimezone: true }),
    fabricConfirmedByUserId: uuid("fabric_confirmed_by_user_id").references(() => authUsers.id, { onDelete: "restrict" }),
    careEn: text("care_en"),
    careBn: text("care_bn"),
    sizeGuidanceEn: text("size_guidance_en"),
    sizeGuidanceBn: text("size_guidance_bn"),
    featured: boolean("featured").notNull().default(false),
  },
  (t) => [
    check("products_version_positive", sql`${t.version} >= 1`),
    check("products_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 100`),
    check("products_status_valid", sql`${t.status} in ('draft', 'published', 'archived')`),
    check("products_name_present", sql`${t.nameEn} is not null or ${t.nameBn} is not null`),
    check(
      "products_names_valid",
      sql`btrim(${t.nameEn}) <> '' and length(${t.nameEn}) <= 200 and btrim(${t.nameBn}) <> '' and length(${t.nameBn}) <= 200`,
    ),
    check(
      "products_descriptions_valid",
      sql`btrim(${t.descriptionEn}) <> '' and length(${t.descriptionEn}) <= 5000 and btrim(${t.descriptionBn}) <> '' and length(${t.descriptionBn}) <= 5000`,
    ),
    check(
      "products_content_valid",
      sql`btrim(${t.fabricEn}) <> '' and length(${t.fabricEn}) <= 1000 and btrim(${t.fabricBn}) <> '' and length(${t.fabricBn}) <= 1000
        and btrim(${t.careEn}) <> '' and length(${t.careEn}) <= 1000 and btrim(${t.careBn}) <> '' and length(${t.careBn}) <= 1000
        and btrim(${t.sizeGuidanceEn}) <> '' and length(${t.sizeGuidanceEn}) <= 1000 and btrim(${t.sizeGuidanceBn}) <> '' and length(${t.sizeGuidanceBn}) <= 1000`,
    ),
    // Migration 0012: Admin list pages by (created_at, id) and filters by category; measured on 5,000
    // fictional products (first page 2.5 ms → 0.05 ms, category filter 0.96 ms → 0.26 ms).
    index("products_created_at_id_idx").on(t.createdAt, t.id),
    index("products_category_id_idx").on(t.categoryId),
    check(
      "products_fabric_confirmation_consistent",
      sql`(${t.fabricConfirmedAt} is null) = (${t.fabricConfirmedByUserId} is null) and (${t.fabricConfirmedAt} is null or ${t.fabricEn} is not null or ${t.fabricBn} is not null)`,
    ),
  ],
);

// Garment measurements in whole millimetres, entered and shown in centimetres with at most one decimal
// (migration 0011). One row per product, size label (as on its variants) and measuring point. The same list of
// points is MEASUREMENT_POINTS in src/modules/catalogue/content.ts (a unit test keeps them equal).
const MEASUREMENT_POINTS = ["chest", "waist", "hip", "length", "shoulder", "sleeve", "inseam", "foot"] as const;
export const productMeasurements = pgTable(
  "product_measurements",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    size: text("size").notNull(),
    point: text("point", { enum: MEASUREMENT_POINTS }).notNull(),
    valueMm: integer("value_mm").notNull(),
  },
  (t) => [
    primaryKey({ name: "product_measurements_pkey", columns: [t.productId, t.size, t.point] }),
    check("product_measurements_size_valid", sql`btrim(${t.size}) <> '' and length(${t.size}) <= 64`),
    check("product_measurements_point_valid", sql`${t.point} in ('chest', 'waist', 'hip', 'length', 'shoulder', 'sleeve', 'inseam', 'foot')`),
    check("product_measurements_value_range", sql`${t.valueMm} between 1 and 3000`),
  ],
);

// Product photos (migration 0011). The file lives in the configured media storage under a random key, never
// in the database or the repository (src/modules/media). This row is the manifest entry for it: the product,
// the key, the type, size and SHA-256 of the stored (re-encoded, metadata-free) file. Positions are kept
// 0..n-1 per product under the product's row lock.
export const productMedia = pgTable(
  "product_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull().unique("product_media_storage_key_key"),
    contentType: text("content_type", { enum: ["image/jpeg", "image/png", "image/webp"] }).notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: text("sha256").notNull(),
    altEn: text("alt_en"),
    altBn: text("alt_bn"),
    position: integer("position").notNull(),
    // The public Cloudinary copy of a PUBLISHED product's photo (src/modules/media/cdn.ts), null for every other photo. Set
    // after upload, cleared after the copy is deleted; a photo with a copy cannot be replaced or removed until then.
    cdnPublicId: text("cdn_public_id"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("product_media_product_position_idx").on(t.productId, t.position),
    check("product_media_storage_key_format", sql`${t.storageKey} ~ '^[0-9a-f]{32}[.](jpg|png|webp)$'`),
    check("product_media_content_type_valid", sql`${t.contentType} in ('image/jpeg', 'image/png', 'image/webp')`),
    check("product_media_byte_size_range", sql`${t.byteSize} between 1 and 20971520`),
    check("product_media_dimensions_range", sql`${t.width} between 1 and 10000 and ${t.height} between 1 and 10000`),
    check("product_media_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("product_media_alt_valid", sql`btrim(${t.altEn}) <> '' and length(${t.altEn}) <= 300 and btrim(${t.altBn}) <> '' and length(${t.altBn}) <= 300`),
    check("product_media_position_nonnegative", sql`${t.position} >= 0`),
    check("product_media_cdn_public_id_format", sql`${t.cdnPublicId} is null or ${t.cdnPublicId} ~ '^[A-Za-z0-9_/-]{1,200}$'`),
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
// with disabled_at set, has no permissions and cannot start a session. Written by the Owner set-up and bootstrap (the
// Owner role) and, since migration 0024, by Staff & access (src/modules/auth/staff.ts; staff roles only, ADR-0013).
export const userAccess = pgTable(
  "user_access",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "manager", "orders", "catalogue", "inventory"] }).notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("user_access_role_valid", sql`${t.role} in ('owner', 'manager', 'orders', 'catalogue', 'inventory')`)],
);

// Staff invitations and set-password links (migration 0024; src/modules/auth/staff.ts, ADR-0013). The Owner invites an
// email address with a staff role (kind 'invite'), or sends an existing staff account a link to set a new password
// (kind 'password'). Only the SHA-256 digest of the random one-time token is stored; a link works once, until it expires
// or is revoked. At most one open link per address. Who created, revoked or used a link is in auth_events.
export const staffInvitations = pgTable(
  "staff_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["invite", "password"] }).notNull(),
    email: text("email").notNull(),
    role: text("role", { enum: ["manager", "orders", "catalogue", "inventory"] }),
    // The account the link belongs to: set at creation for a password link, on acceptance for an invitation.
    userId: uuid("user_id").references(() => authUsers.id, { onDelete: "cascade" }),
    tokenSha256: text("token_sha256").notNull().unique("staff_invitations_token_sha256_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("staff_invitations_open_email_key").on(t.email).where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    index("staff_invitations_created_at_idx").on(t.createdAt),
    check("staff_invitations_kind_valid", sql`${t.kind} in ('invite', 'password')`),
    check("staff_invitations_role_valid", sql`${t.role} in ('manager', 'orders', 'catalogue', 'inventory')`),
    check("staff_invitations_kind_consistent", sql`(${t.kind} = 'invite') = (${t.role} is not null) and (${t.kind} = 'invite' or ${t.userId} is not null)`),
    check("staff_invitations_email_valid", sql`${t.email} = lower(${t.email}) and length(${t.email}) between 3 and 254`),
    check("staff_invitations_token_format", sql`${t.tokenSha256} ~ '^[0-9a-f]{64}$'`),
    check("staff_invitations_end_consistent", sql`not (${t.acceptedAt} is not null and ${t.revokedAt} is not null) and (${t.acceptedAt} is null or ${t.userId} is not null) and ${t.expiresAt} > ${t.createdAt}`),
  ],
);

// The audited events. Staff & access events (migration 0024) name the Owner who acted (or, for staff_joined and
// staff_password_set, the staff member) and carry ids and roles only, never an email address.
const AUTH_EVENTS = [
  "sign_in",
  "sign_in_failed",
  "session_ended",
  "password_changed",
  "owner_created",
  "owner_password_reset",
  "access_changed",
  "staff_invited",
  "staff_invitation_revoked",
  "staff_joined",
  "staff_role_changed",
  "staff_disabled",
  "staff_enabled",
  "staff_sessions_revoked",
  "staff_password_link",
  "staff_password_set",
] as const;

// Append-only security audit of authentication and access (migration 0017; src/modules/auth/audit.ts). Written by
// Better Auth hooks (sign-in, failed sign-in, every ended session, password change), the local Owner commands and a
// trigger on user_access (every grant, role change, disable, enable or removal). No password, token, cookie, email or
// address is stored: a failed sign-in keeps only an HMAC of the address it tried, keyed by the installation's secret,
// so attempts on the same address can be grouped but the address cannot be read back. User ids carry no foreign key,
// so the history outlives an account. At most one sign_in and one session_ended row per session (unique indexes).
export const authEvents = pgTable(
  "auth_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    event: text("event", { enum: AUTH_EVENTS }).notNull(),
    // user: an authenticated user acted; anonymous: an unauthenticated attempt; operator: a local command with
    // database access; system: the database itself (access trigger) or the library (an expired session).
    actorType: text("actor_type", { enum: ["user", "anonymous", "operator", "system"] }).notNull(),
    actorUserId: uuid("actor_user_id"),
    subjectUserId: uuid("subject_user_id"),
    sessionId: uuid("session_id"),
    transport: text("transport", { enum: ["browser", "native", "cli", "database"] }),
    subjectDigest: text("subject_digest"),
    detail: jsonb("detail").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("auth_events_created_at_idx").on(t.createdAt),
    index("auth_events_subject_user_id_id_idx").on(t.subjectUserId, t.id),
    uniqueIndex("auth_events_sign_in_session_key").on(t.sessionId).where(sql`${t.event} = 'sign_in'`),
    uniqueIndex("auth_events_session_ended_session_key").on(t.sessionId).where(sql`${t.event} = 'session_ended'`),
    check("auth_events_event_valid", sql`${t.event} in (${sql.raw(AUTH_EVENTS.map((e) => `'${e}'`).join(", "))})`),
    check("auth_events_actor_type_valid", sql`${t.actorType} in ('user', 'anonymous', 'operator', 'system')`),
    check("auth_events_actor_consistent", sql`(${t.actorType} = 'user') = (${t.actorUserId} is not null)`),
    check("auth_events_transport_valid", sql`${t.transport} in ('browser', 'native', 'cli', 'database')`),
    check(
      "auth_events_failed_sign_in_anonymous",
      sql`(${t.event} = 'sign_in_failed') = (${t.actorType} = 'anonymous') and (${t.event} <> 'sign_in_failed' or ${t.subjectUserId} is null)`,
    ),
    check("auth_events_subject_digest_valid", sql`(${t.subjectDigest} is null or ${t.event} = 'sign_in_failed') and (${t.subjectDigest} is null or ${t.subjectDigest} ~ '^[0-9a-f]{64}$')`),
    check("auth_events_session_required", sql`${t.event} not in ('sign_in', 'session_ended') or ${t.sessionId} is not null`),
    check("auth_events_detail_object", sql`jsonb_typeof(${t.detail}) = 'object' and length(${t.detail}::text) <= 1000`),
  ],
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
    // What the courier kept from the collected COD (its fees or other deductions), as the Owner recorded it from
    // the courier's statement (migration 0016). No amount is assumed. Collected money is accounted for once it is
    // either settled to the Owner or recorded as deducted.
    codDeductedPaisa: bigint("cod_deducted_paisa", { mode: "number" }).notNull().default(0),
    refundedPaisa: bigint("refunded_paisa", { mode: "number" }).notNull().default(0),
    // How the customer chose to pay (migration 0025): cash on delivery, or a manual advance transfer to the store's
    // bKash, Nagad or bank account. Chosen at submission, never changed by the customer.
    paymentMethod: text("payment_method", { enum: ["cod", "bkash", "nagad", "bank_transfer"] }).notNull().default("cod"),
    // Advance money the Owner verified as received (net of undone verifications) and paid back for a cancelled or
    // unfulfillable order (migration 0025; running totals of payment_entries, updated in the same transaction).
    advanceReceivedPaisa: bigint("advance_received_paisa", { mode: "number" }).notNull().default(0),
    advanceRefundedPaisa: bigint("advance_refunded_paisa", { mode: "number" }).notNull().default(0),
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
    // Admin order search by the normalized phone number, newest first (migration 0022).
    index("orders_customer_phone_idx").on(t.customerPhone, t.createdAt, t.id),
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
    // Money actually handled: never more settled and deducted than collected, never more received (COD collected plus
    // verified advance) than the order total, never more refunded than received (founder rules J and M; deductions
    // since migration 0016; advance payments since 0025).
    check(
      "orders_cod_amounts_valid",
      sql`${t.codSettledPaisa} >= 0 and ${t.codDeductedPaisa} >= 0 and ${t.codSettledPaisa} + ${t.codDeductedPaisa} <= ${t.codCollectedPaisa} and ${t.codCollectedPaisa} + ${t.advanceReceivedPaisa} <= ${t.totalPaisa} and ${t.refundedPaisa} >= 0 and ${t.refundedPaisa} + ${t.advanceRefundedPaisa} <= ${t.codCollectedPaisa} + ${t.advanceReceivedPaisa}`,
    ),
    // Advance money exists only on an order that chose a manual payment method, and is never refunded beyond what came in.
    check(
      "orders_advance_amounts_valid",
      sql`${t.paymentMethod} in ('cod', 'bkash', 'nagad', 'bank_transfer') and ${t.advanceReceivedPaisa} >= 0 and ${t.advanceRefundedPaisa} >= 0 and ${t.advanceRefundedPaisa} <= ${t.advanceReceivedPaisa} and (${t.paymentMethod} <> 'cod' or (${t.advanceReceivedPaisa} = 0 and ${t.advanceRefundedPaisa} = 0))`,
    ),
    // Payment status is a function of the amounts, so it can never disagree with them: money received from the customer
    // (COD collected plus verified advance) against the total. 'settled' means every COD taka the courier collected is
    // settled to the Owner or recorded as deducted (verified advance money is already the Owner's).
    check(
      "orders_payment_status_derived",
      sql`${t.paymentStatus} = case when ${t.codCollectedPaisa} + ${t.advanceReceivedPaisa} = 0 then 'unpaid' when ${t.codCollectedPaisa} + ${t.advanceReceivedPaisa} < ${t.totalPaisa} then 'partially_collected' when ${t.codSettledPaisa} + ${t.codDeductedPaisa} < ${t.codCollectedPaisa} then 'collected' else 'settled' end`,
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
    // A delivered order is closed only after its 7 × 24-hour return window (migration 0010), so closing never
    // ends the customer's right to ask for a return (founder rule E).
    check(
      "orders_closed_after_return_window",
      sql`${t.orderStatus} <> 'closed' or ${t.fulfilmentStatus} <> 'delivered' or (${t.deliveredAt} is not null and ${t.closedAt} > ${t.deliveredAt} + interval '7 days')`,
    ),
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

// Append-only money record (trigger, migration 0008): courier collection, settlement to the Owner, courier deductions
// from the collected money (migration 0016), manual refunds for returns (founder rules J and M) and, since migration
// 0025, manual advance payments: verified as received, a mistaken verification undone (reversed), and advance money
// paid back for a cancelled or unfulfillable order. orders keeps the running totals, updated in the same transaction.
export const paymentEntries = pgTable(
  "payment_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: ["collected", "settled", "deducted", "refunded", "advance_received", "advance_reversed", "advance_refunded"] }).notNull(),
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
    check("payment_entries_kind_valid", sql`${t.kind} in ('collected', 'settled', 'deducted', 'refunded', 'advance_received', 'advance_reversed', 'advance_refunded')`),
    check("payment_entries_amount_valid", sql`${t.amountPaisa} > 0 and ${t.amountPaisa} <= 9007199254740991`),
    check(
      "payment_entries_refund_consistent",
      sql`(${t.kind} in ('refunded', 'advance_received', 'advance_reversed', 'advance_refunded')) = (${t.method} is not null) and (${t.kind} = 'refunded') = (${t.returnId} is not null)`,
    ),
    check("payment_entries_method_valid", sql`${t.method} in ('bkash', 'nagad', 'bank_transfer')`),
    check("payment_entries_reference_valid", sql`btrim(${t.reference}) <> '' and length(${t.reference}) <= 100`),
  ],
);

// Append-only record of every courier statement check (migration 0018; src/modules/orders/statements.ts): who
// compared which file (its SHA-256, never its content) with the recorded COD money, the counts, and the report shown
// (order references, amounts and statuses only; no customer data). A check changes no order or payment: it is read-only
// matching, and settlement is still recorded by hand.
export const courierStatementChecks = pgTable(
  "courier_statement_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: userRef("actor_user_id").notNull(),
    fileSha256: text("file_sha256").notNull(),
    rowCount: integer("row_count").notNull(),
    matches: integer("matches").notNull(),
    differs: integer("differs").notNull(),
    notFound: integer("not_found").notNull(),
    duplicates: integer("duplicates").notNull(),
    invalid: integer("invalid").notNull(),
    report: jsonb("report").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("courier_statement_checks_created_at_idx").on(t.createdAt),
    check("courier_statement_checks_sha256_format", sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "courier_statement_checks_counts_valid",
      sql`${t.matches} >= 0 and ${t.differs} >= 0 and ${t.notFound} >= 0 and ${t.duplicates} >= 0 and ${t.invalid} >= 0 and ${t.rowCount} = ${t.matches} + ${t.differs} + ${t.notFound} + ${t.duplicates} + ${t.invalid}`,
    ),
    check("courier_statement_checks_report_object", sql`jsonb_typeof(${t.report}) = 'object'`),
  ],
);

// Manual advance payments (migration 0025; src/modules/orders/advance.ts, ADR-0013). Each row is one transfer reference:
// submitted by the customer through the order's private tracking link, or recorded by the Owner. A reference proves
// nothing by itself: only the Owner's verification against the real receiving account (status 'verified', with the
// amount actually received) writes money, as an advance_received ledger row. A mistaken verification is undone by an
// advance_reversed row ('reversed'), never by editing history. One reference counts at most once across all orders.
export const advancePayments = pgTable(
  "advance_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    method: text("method", { enum: ["bkash", "nagad", "bank_transfer"] }).notNull(),
    // The transaction id the sender's app or bank shows, upper case, no spaces.
    reference: text("reference").notNull(),
    source: text("source", { enum: ["customer", "owner"] }).notNull(),
    status: text("status", { enum: ["submitted", "verified", "rejected", "reversed"] }).notNull(),
    amountPaisa: bigint("amount_paisa", { mode: "number" }),
    receivedOn: date("received_on", { mode: "string" }),
    // Why the Owner rejected or undid it (shown to the Owner only).
    note: text("note"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: userRef("decided_by_user_id"),
    paymentEntryId: bigint("payment_entry_id", { mode: "number" }).references(() => paymentEntries.id, { onDelete: "restrict" }),
    reversalEntryId: bigint("reversal_entry_id", { mode: "number" }).references(() => paymentEntries.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("advance_payments_order_id_idx").on(t.orderId, t.createdAt),
    index("advance_payments_submitted_idx").on(t.createdAt).where(sql`${t.status} = 'submitted'`),
    uniqueIndex("advance_payments_verified_reference_key").on(t.method, t.reference).where(sql`${t.status} = 'verified'`),
    uniqueIndex("advance_payments_open_reference_key").on(t.orderId, t.method, t.reference).where(sql`${t.status} = 'submitted'`),
    check("advance_payments_method_valid", sql`${t.method} in ('bkash', 'nagad', 'bank_transfer')`),
    check("advance_payments_reference_format", sql`${t.reference} ~ '^[A-Z0-9][A-Z0-9/-]{3,39}$'`),
    check("advance_payments_source_valid", sql`${t.source} in ('customer', 'owner')`),
    check("advance_payments_status_valid", sql`${t.status} in ('submitted', 'verified', 'rejected', 'reversed')`),
    check("advance_payments_note_valid", sql`btrim(${t.note}) <> '' and length(${t.note}) <= 300`),
    check(
      "advance_payments_decision_consistent",
      sql`(${t.status} = 'submitted') = (${t.decidedAt} is null) and (${t.decidedAt} is null) = (${t.decidedByUserId} is null)
        and (${t.status} in ('verified', 'reversed')) = (${t.paymentEntryId} is not null)
        and (${t.status} in ('verified', 'reversed')) = (${t.amountPaisa} is not null and ${t.receivedOn} is not null)
        and (${t.status} = 'reversed') = (${t.reversalEntryId} is not null)
        and (${t.source} = 'customer' or ${t.status} <> 'submitted')`,
    ),
    check("advance_payments_amount_valid", sql`${t.amountPaisa} > 0 and ${t.amountPaisa} <= 9007199254740991`),
  ],
);

// The store's manual payment methods (migration 0025; src/modules/settings/payments.ts). One row per method, written only
// by the Owner. A method is offered to customers only while enabled, which needs its receiving details and the Owner's
// explicit confirmation that the account may receive the store's payments. Nothing is prefilled; no gateway credential,
// PIN or customer banking detail is stored.
export const paymentMethods = pgTable(
  "payment_methods",
  {
    method: text("method", { enum: ["bkash", "nagad", "bank_transfer"] }).primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    accountName: text("account_name"),
    // bKash or Nagad: the receiving mobile number (01XXXXXXXXX). Bank: the account number.
    accountNumber: text("account_number"),
    // bKash or Nagad: merchant (customers use Payment) or personal (customers use Send Money).
    accountKind: text("account_kind", { enum: ["merchant", "personal"] }),
    bankName: text("bank_name"),
    branchName: text("branch_name"),
    routingNumber: text("routing_number"),
    instructionsEn: text("instructions_en"),
    instructionsBn: text("instructions_bn"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: userRef("approved_by_user_id"),
    version: version(),
    updatedAt: updatedAt(),
    updatedByUserId: userRef("updated_by_user_id").notNull(),
  },
  (t) => [
    check("payment_methods_method_valid", sql`${t.method} in ('bkash', 'nagad', 'bank_transfer')`),
    check("payment_methods_kind_valid", sql`${t.accountKind} in ('merchant', 'personal')`),
    check(
      "payment_methods_texts_valid",
      sql`coalesce(length(${t.accountName}), 1) between 1 and 80 and coalesce(length(${t.accountNumber}), 6) between 6 and 34 and coalesce(length(${t.bankName}), 1) between 1 and 80 and coalesce(length(${t.branchName}), 1) between 1 and 80 and (${t.routingNumber} is null or ${t.routingNumber} ~ '^[0-9]{9}$') and coalesce(length(${t.instructionsEn}), 0) <= 300 and coalesce(length(${t.instructionsBn}), 0) <= 300`,
    ),
    check(
      "payment_methods_enabled_complete",
      sql`not ${t.enabled} or (${t.accountName} is not null and ${t.accountNumber} is not null and ${t.approvedAt} is not null and ${t.approvedByUserId} is not null
        and (${t.method} = 'bank_transfer') = (${t.bankName} is not null)
        and (${t.method} = 'bank_transfer') = (${t.accountKind} is null))`,
    ),
    check("payment_methods_wallet_number", sql`${t.method} = 'bank_transfer' or ${t.accountNumber} is null or ${t.accountNumber} ~ '^01[3-9][0-9]{8}$'`),
    check("payment_methods_version_positive", sql`${t.version} >= 1`),
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

// Anonymous request counters (src/modules/rate-limit/service.ts, consumePublicLimit). The keys are 'failure' (unknown,
// revoked or expired tracking tokens, all clients), 'link:<link id>' (one per live tracking link, migration 0010),
// 'checkout' (guest checkout submissions, all clients, migration 0015), 'checkout-client:<HMAC of the client
// address>' (per client and hour, only behind a trusted proxy, migration 0020; the address itself is never stored),
// 'admin-setup' and 'admin-recovery' (migration 0021) and 'staff-invite' (staff link redemptions, migration 0024).
export const trackingRateLimits = pgTable(
  "tracking_rate_limits",
  {
    bucket: text("bucket").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    check(
      "tracking_rate_limits_bucket_valid",
      sql`${t.bucket} in ('failure', 'checkout', 'admin-setup', 'admin-recovery', 'staff-invite') or ${t.bucket} ~ '^link:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or ${t.bucket} ~ '^checkout-client:[0-9a-f]{64}$'`,
    ),
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

// Append-only record of every bulk catalogue import (migration 0012; trigger as for export_requests): who,
// when, which file (its SHA-256, never its content) and what it created. Imports only create draft products
// and SKUs with zero stock; the products themselves are ordinary catalogue rows afterwards.
export const catalogueImports = pgTable(
  "catalogue_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: userRef("actor_user_id").notNull(),
    format: text("format", { enum: ["csv", "xlsx"] }).notNull(),
    fileSha256: text("file_sha256").notNull(),
    productsCreated: integer("products_created").notNull(),
    variantsCreated: integer("variants_created").notNull(),
    productIds: jsonb("product_ids").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("catalogue_imports_created_at_idx").on(t.createdAt),
    check("catalogue_imports_format_valid", sql`${t.format} in ('csv', 'xlsx')`),
    check("catalogue_imports_sha256_format", sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
    check("catalogue_imports_counts_valid", sql`${t.productsCreated} >= 1 and ${t.variantsCreated} >= ${t.productsCreated}`),
    check("catalogue_imports_product_ids_array", sql`jsonb_typeof(${t.productIds}) = 'array' and jsonb_array_length(${t.productIds}) = ${t.productsCreated}`),
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

// ---------------------------------------------------------------------------------------------------------
// Gate H.25-H.28 (migration 0013): anonymous checkout idempotency, internal product reviews and private policy
// drafts. None of these publishes anything or opens checkout (docs/operations/launch-readiness.md).

// One row per anonymous checkout submission (src/modules/orders/guest-checkout.ts). The client's key is never
// stored: only its SHA-256 (the primary key) and an HMAC of the canonical request keyed by the key itself, so
// the row holds nothing a reader could turn back into the customer's name, phone or address without the key.
// The row is claimed by INSERT in the same transaction that creates the order and then names that order; a
// trigger refuses any other change and every delete, so a committed submission always points at its order.
export const guestCheckoutSubmissions = pgTable(
  "guest_checkout_submissions",
  {
    keyHash: text("key_hash").primaryKey(),
    requestMac: text("request_mac").notNull(),
    orderId: uuid("order_id")
      .unique("guest_checkout_submissions_order_id_key")
      .references(() => orders.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("guest_checkout_submissions_key_hash_format", sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`),
    check("guest_checkout_submissions_request_mac_format", sql`${t.requestMac} ~ '^[0-9a-f]{64}$'`),
  ],
);

// Append-only record of the Owner's internal reviews of a draft product (src/modules/catalogue/review.ts). A
// review names the SHA-256 of the product's reviewable content at that moment; it counts as current only while
// the content still has that digest, so any later change to text, claims, measurements, photos or SKUs makes it
// outdated without touching this table. A review never publishes a product and grants no public visibility.
// open_items lists the readiness items (src/modules/catalogue/readiness.ts) that were not met when reviewed.
export const productReviews = pgTable(
  "product_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    contentSha256: text("content_sha256").notNull(),
    openItems: jsonb("open_items").notNull(),
    reviewedByUserId: userRef("reviewed_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("product_reviews_product_id_created_at_idx").on(t.productId, t.createdAt),
    check("product_reviews_content_sha256_format", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check("product_reviews_open_items_array", sql`jsonb_typeof(${t.openItems}) = 'array'`),
  ],
);

// Append-only record of every publication decision (migration 0014; trigger as for export_requests): who published
// or withdrew which product, when, the SHA-256 of its reviewed content at that moment (contentDigest in
// src/modules/catalogue/review.ts) and, for a publication, the id of the founder-approved rule it met. The product's
// status is the current state; this table is its history. Nothing writes it while no publication rule is approved.
export const productPublicationEvents = pgTable(
  "product_publication_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    event: text("event", { enum: ["published", "withdrawn"] }).notNull(),
    contentSha256: text("content_sha256").notNull(),
    ruleId: text("rule_id"),
    actorUserId: userRef("actor_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("product_publication_events_product_id_id_idx").on(t.productId, t.id),
    check("product_publication_events_event_valid", sql`${t.event} in ('published', 'withdrawn')`),
    check("product_publication_events_content_sha256_format", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check("product_publication_events_rule_consistent", sql`(${t.event} = 'published') = (${t.ruleId} is not null) and (${t.ruleId} is null or ${t.ruleId} ~ '^[a-z0-9][a-z0-9.-]{0,63}$')`),
  ],
);

// Private drafts of the customer policies public checkout depends on (S-17, G-7), one row per kind once the
// Owner first saves it. Text is the Owner's own, shown as plain text only. "Reviewed" means the Owner marked
// this exact version as reviewed; any edit clears it. There is no published state: nothing here is shown to a
// customer, and a reviewed draft is not founder approval or publication.
// The same list is POLICY_KINDS in src/modules/policies/drafts.ts (a unit test keeps them equal).
const POLICY_KINDS = ["delivery", "returns", "privacy", "checkout_notices"] as const;
export const policyDrafts = pgTable(
  "policy_drafts",
  {
    kind: text("kind", { enum: POLICY_KINDS }).primaryKey(),
    bodyEn: text("body_en"),
    bodyBn: text("body_bn"),
    version: version(),
    updatedAt: updatedAt(),
    updatedByUserId: userRef("updated_by_user_id").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: userRef("reviewed_by_user_id"),
  },
  (t) => [
    check("policy_drafts_kind_valid", sql`${t.kind} in ('delivery', 'returns', 'privacy', 'checkout_notices')`),
    check("policy_drafts_version_positive", sql`${t.version} >= 1`),
    check("policy_drafts_bodies_valid", sql`btrim(${t.bodyEn}) <> '' and length(${t.bodyEn}) <= 20000 and btrim(${t.bodyBn}) <> '' and length(${t.bodyBn}) <= 20000`),
    check(
      "policy_drafts_review_consistent",
      sql`(${t.reviewedAt} is null) = (${t.reviewedByUserId} is null) and (${t.reviewedAt} is null or (${t.bodyEn} is not null and ${t.bodyBn} is not null))`,
    ),
  ],
);

// Append-only audit of policy draft changes (trigger as for export_requests): who saved or marked which version,
// when, and the SHA-256 of each language's text at that moment (never a second copy of the text).
export const policyDraftEvents = pgTable(
  "policy_draft_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: POLICY_KINDS }).notNull(),
    event: text("event", { enum: ["saved", "marked_reviewed"] }).notNull(),
    version: integer("version").notNull(),
    bodyEnSha256: text("body_en_sha256"),
    bodyBnSha256: text("body_bn_sha256"),
    actorUserId: userRef("actor_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("policy_draft_events_kind_id_idx").on(t.kind, t.id),
    check("policy_draft_events_kind_valid", sql`${t.kind} in ('delivery', 'returns', 'privacy', 'checkout_notices')`),
    check("policy_draft_events_event_valid", sql`${t.event} in ('saved', 'marked_reviewed')`),
    check("policy_draft_events_version_positive", sql`${t.version} >= 1`),
    check("policy_draft_events_sha256_format", sql`${t.bodyEnSha256} ~ '^[0-9a-f]{64}$' and ${t.bodyBnSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

// Founder-approved, published versions of the customer policies (migration 0020; src/modules/policies/publication.ts).
// Append-only (trigger as for export_requests): publishing copies the exact reviewed draft text with its digests, the
// draft version and who approved it; withdrawing adds a row without text. A kind's newest row decides what customers
// see: its text when it is a publication, nothing when it is a withdrawal or when the kind has no row.
export const policyPublications = pgTable(
  "policy_publications",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: POLICY_KINDS }).notNull(),
    event: text("event", { enum: ["published", "withdrawn"] }).notNull(),
    draftVersion: integer("draft_version"),
    bodyEn: text("body_en"),
    bodyBn: text("body_bn"),
    bodyEnSha256: text("body_en_sha256"),
    bodyBnSha256: text("body_bn_sha256"),
    actorUserId: userRef("actor_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("policy_publications_kind_id_idx").on(t.kind, t.id),
    check("policy_publications_kind_valid", sql`${t.kind} in ('delivery', 'returns', 'privacy', 'checkout_notices')`),
    check("policy_publications_event_valid", sql`${t.event} in ('published', 'withdrawn')`),
    check(
      "policy_publications_content_consistent",
      sql`case when ${t.event} = 'published' then ${t.draftVersion} >= 1 and btrim(${t.bodyEn}) <> '' and btrim(${t.bodyBn}) <> '' and length(${t.bodyEn}) <= 20000 and length(${t.bodyBn}) <= 20000 and ${t.bodyEnSha256} ~ '^[0-9a-f]{64}$' and ${t.bodyBnSha256} ~ '^[0-9a-f]{64}$' else ${t.draftVersion} is null and ${t.bodyEn} is null and ${t.bodyBn} is null and ${t.bodyEnSha256} is null and ${t.bodyBnSha256} is null end`,
    ),
  ],
);

// Customer accounts (migration 0020; ADR-0011): a SECOND Better Auth instance (src/modules/customers/auth.ts) with its
// own tables, cookies and path, Google sign-in only. Nothing here can reach the Owner's tables: user_access references
// auth_users only, and Admin and /api/v1 verify only the Owner instance, so a customer can never become a principal.
// OAuth tokens from Google are never stored (the instance clears them before every write).
export const customerUsers = pgTable(
  "customer_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull().unique("customer_users_email_key"),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("customer_users_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

export const customerSessions = pgTable(
  "customer_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique("customer_sessions_token_key"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => customerUsers.id, { onDelete: "cascade" }),
  },
  (t) => [index("customer_sessions_user_id_idx").on(t.userId)],
);

export const customerAccounts = pgTable(
  "customer_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => customerUsers.id, { onDelete: "cascade" }),
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
  (t) => [
    index("customer_accounts_user_id_idx").on(t.userId),
    uniqueIndex("customer_accounts_provider_account_key").on(t.providerId, t.accountId),
    // Google or email and password (migration 0021). No OAuth token is ever kept; a password hash only for the email account.
    check("customer_accounts_provider_valid", sql`${t.providerId} in ('google', 'credential')`),
    check("customer_accounts_no_secrets", sql`${t.accessToken} is null and ${t.refreshToken} is null and ${t.idToken} is null and (${t.password} is null or ${t.providerId} = 'credential')`),
  ],
);

export const customerVerifications = pgTable(
  "customer_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("customer_verifications_identifier_idx").on(t.identifier)],
);

export const customerRateLimits = pgTable("customer_rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique("customer_rate_limits_key_key"),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// Which website orders a signed-in customer placed (migration 0020). Written only by the checkout, in the order's own
// transaction, from the server-verified customer session (never from the request body). An order without a row was a
// guest order. Deleting a customer removes the link, never the order.
export const customerOrders = pgTable(
  "customer_orders",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "restrict" }),
    customerUserId: uuid("customer_user_id")
      .notNull()
      .references(() => customerUsers.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("customer_orders_customer_user_id_idx").on(t.customerUserId, t.createdAt)],
);

// The store's own settings, edited by the Owner in Admin (migration 0021; src/modules/settings/store.ts). One row (id 1).
// Empty fields fall back to the STORE_* environment defaults (src/config/installation.ts), so a fresh installation shows
// neutral defaults and no other business's details. The logo is kept here, re-encoded and size-capped (base64), and served
// by /brand/logo. The publication rule is the Owner's approval of what a product needs before it is published (I-6).
export const storeSettings = pgTable(
  "store_settings",
  {
    id: integer("id").primaryKey(),
    storeName: text("store_name"),
    lineEn: text("line_en"),
    lineBn: text("line_bn"),
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    contactWhatsapp: text("contact_whatsapp"),
    contactMessenger: text("contact_messenger"),
    logoBase64: text("logo_base64"),
    logoContentType: text("logo_content_type"),
    logoWidth: integer("logo_width"),
    logoHeight: integer("logo_height"),
    logoSha256: text("logo_sha256"),
    publicationRuleItems: jsonb("rule_items"),
    publicationRuleApprovedAt: timestamp("rule_approved_at", { withTimezone: true }),
    publicationRuleApprovedByUserId: userRef("rule_approved_by_user_id"),
    version: version(),
    updatedAt: updatedAt(),
    updatedByUserId: userRef("updated_by_user_id"),
    // Migration 0023: optional public profiles. Read only after a column check, so an older database keeps working.
    socialFacebook: text("social_facebook"),
    socialInstagram: text("social_instagram"),
  },
  (t) => [
    check("store_settings_single_row", sql`${t.id} = 1`),
    check("store_settings_social_valid", sql`coalesce(length(${t.socialFacebook}), 0) <= 200 and coalesce(length(${t.socialInstagram}), 0) <= 200`),
    check("store_settings_version_positive", sql`${t.version} >= 1`),
    check(
      "store_settings_texts_valid",
      sql`coalesce(length(${t.storeName}), 1) between 1 and 60 and coalesce(length(${t.lineEn}), 0) <= 200 and coalesce(length(${t.lineBn}), 0) <= 200 and coalesce(length(${t.contactPhone}), 0) <= 30 and coalesce(length(${t.contactEmail}), 0) <= 120 and coalesce(length(${t.contactWhatsapp}), 0) <= 30 and coalesce(length(${t.contactMessenger}), 0) <= 200`,
    ),
    check(
      "store_settings_logo_consistent",
      sql`(${t.logoBase64} is null) = (${t.logoSha256} is null) and (${t.logoBase64} is null) = (${t.logoWidth} is null) and (${t.logoBase64} is null) = (${t.logoContentType} is null) and coalesce(length(${t.logoBase64}), 0) <= 700000 and (${t.logoContentType} is null or ${t.logoContentType} in ('image/png', 'image/jpeg', 'image/webp'))`,
    ),
    check("store_settings_rule_consistent", sql`(${t.publicationRuleApprovedAt} is null) = (${t.publicationRuleApprovedByUserId} is null) and (${t.publicationRuleApprovedAt} is null or ${t.publicationRuleItems} is not null)`),
  ],
);

// One-time Owner recovery codes (migration 0021; src/modules/auth/recovery.ts): shown once at setup (or when regenerated),
// stored only as SHA-256 digests. Redeeming one sets a new password and ends every session of that Owner.
export const ownerRecoveryCodes = pgTable(
  "owner_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    codeSha256: text("code_sha256").notNull().unique("owner_recovery_codes_code_sha256_key"),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("owner_recovery_codes_user_id_idx").on(t.userId), check("owner_recovery_codes_sha256_format", sql`${t.codeSha256} ~ '^[0-9a-f]{64}$'`)],
);
