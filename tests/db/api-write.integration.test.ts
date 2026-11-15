import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import { consumeRateLimit } from "../../src/modules/rate-limit/service";
import { BASE_URL, bearer, clearAuthState, count, createTestAuth, createTestUser, signIn, signInNative } from "../support/auth";
import { createTestVariant, withFailingInserts } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// The /api/v1 write endpoints and the hardened transport (origin policy, rate limits, body handling),
// through the real route handlers against PostgreSQL. Every response is checked against the published
// OpenAPI document: the status is documented for that operation, and the content type and body match.

const state = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/modules/auth/server", () => ({ getAuth: () => state.auth }));

type RouteModule = Partial<Record<string, (r: Request, c: { params: Promise<never> }) => Promise<Response>>>;
const ROUTES: Record<string, RouteModule> = {
  "/products": (await import("../../src/app/api/v1/products/route")) as unknown as RouteModule,
  "/products/{productId}": (await import("../../src/app/api/v1/products/[productId]/route")) as unknown as RouteModule,
  "/products/{productId}/variants": (await import("../../src/app/api/v1/products/[productId]/variants/route")) as unknown as RouteModule,
  "/products/{productId}/archive": (await import("../../src/app/api/v1/products/[productId]/archive/route")) as unknown as RouteModule,
  "/variants/{variantId}": (await import("../../src/app/api/v1/variants/[variantId]/route")) as unknown as RouteModule,
  "/variants/{variantId}/deactivate": (await import("../../src/app/api/v1/variants/[variantId]/deactivate/route")) as unknown as RouteModule,
  "/stock-receipts": (await import("../../src/app/api/v1/stock-receipts/route")) as unknown as RouteModule,
  "/stock-adjustments": (await import("../../src/app/api/v1/stock-adjustments/route")) as unknown as RouteModule,
  "/skus/{sku}/stock": (await import("../../src/app/api/v1/skus/[sku]/stock/route")) as unknown as RouteModule,
  "/skus/{sku}/movements": (await import("../../src/app/api/v1/skus/[sku]/movements/route")) as unknown as RouteModule,
  "/orders": (await import("../../src/app/api/v1/orders/route")) as unknown as RouteModule,
  "/orders/{orderId}": (await import("../../src/app/api/v1/orders/[orderId]/route")) as unknown as RouteModule,
  "/orders/{orderId}/transitions": (await import("../../src/app/api/v1/orders/[orderId]/transitions/route")) as unknown as RouteModule,
  "/orders/{orderId}/cancellation-review": (await import("../../src/app/api/v1/orders/[orderId]/cancellation-review/route")) as unknown as RouteModule,
  "/orders/{orderId}/payments": (await import("../../src/app/api/v1/orders/[orderId]/payments/route")) as unknown as RouteModule,
  "/orders/{orderId}/rto-charge": (await import("../../src/app/api/v1/orders/[orderId]/rto-charge/route")) as unknown as RouteModule,
  "/orders/{orderId}/returns": (await import("../../src/app/api/v1/orders/[orderId]/returns/route")) as unknown as RouteModule,
  "/orders/{orderId}/returns/{returnId}/steps": (await import("../../src/app/api/v1/orders/[orderId]/returns/[returnId]/steps/route")) as unknown as RouteModule,
  "/orders/{orderId}/inspections/{quarantineItemId}": (await import("../../src/app/api/v1/orders/[orderId]/inspections/[quarantineItemId]/route")) as unknown as RouteModule,
  "/orders/{orderId}/tracking-link": (await import("../../src/app/api/v1/orders/[orderId]/tracking-link/route")) as unknown as RouteModule,
  "/orders/{orderId}/tracking-link/revoke": (await import("../../src/app/api/v1/orders/[orderId]/tracking-link/revoke/route")) as unknown as RouteModule,
  "/delivery-zones": (await import("../../src/app/api/v1/delivery-zones/route")) as unknown as RouteModule,
  "/delivery-zones/{code}": (await import("../../src/app/api/v1/delivery-zones/[code]/route")) as unknown as RouteModule,
};
const openApiRoute = await import("../../src/app/api/v1/openapi.json/route");
const { apiPost } = await import("../../src/api/v1/http");
const { emptyRequest } = await import("../../src/api/v1/schemas");

const A = { email: "write-owner-a@example.test", password: "write owner a long password" };
const B = { email: "write-owner-b@example.test", password: "write owner b long password" };

let db: Db;
let pool: Pool;
let auth: ReturnType<typeof createTestAuth>;
let aId: string;
let bId: string;
let tokenA: string;
let tokenB: string;
type Documented = { content: Record<string, { schema: { $ref: string } }>; headers?: Record<string, unknown> };
let doc: { paths: Record<string, Record<string, { responses: Record<string, Documented> }>> };
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  auth = createTestAuth(db);
  Object.assign(state, { db, auth });
  doc = await openApiRoute.GET().json();
  ajv.addSchema(doc, "openapi");
  await clearAuthState(pool);
  aId = await createTestUser(pool, { ...A, role: "owner" });
  bId = await createTestUser(pool, { ...B, role: "owner" });
  tokenA = (await signInNative(auth, A.email, A.password)).token!;
  tokenB = (await signInNative(auth, B.email, B.password)).token!;
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from auth_rate_limits");
  await pool.query("delete from api_rate_limits");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type Call = {
  method?: string;
  path: string;
  template: string;
  params?: Record<string, string>;
  token?: string | null;
  key?: string | null;
  body?: unknown;
  raw?: BodyInit;
  headers?: Record<string, string>;
};

/** Calls the route for `template` and checks the response against the OpenAPI document. */
async function call({ method = "POST", path, template, params = {}, token = tokenA, key = randomUUID(), body, raw, headers = {} }: Call) {
  const h = new Headers(headers);
  if (token) h.set("authorization", `Bearer ${token}`);
  if (key && method !== "GET") h.set("idempotency-key", key);
  if (body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
  const request = new Request(`${BASE_URL}/api/v1${path}`, {
    method,
    headers: h,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    ...(raw instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  const handler = ROUTES[template][method]!;
  const response = await handler(request, { params: Promise.resolve(params) as Promise<never> });
  const json = await response.json();
  expectContract(template, method, response, json);
  return { status: response.status, body: json, response };
}

function expectContract(template: string, method: string, response: Response, body: unknown) {
  expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.headers.get("cache-control")).toBe("no-store");
  for (const [name] of response.headers) expect(name, "no CORS header is ever sent").not.toMatch(/^access-control-/);
  if (response.status === 405) return; // Unsupported methods are not operations in the document.
  const documented = doc.paths[template][method.toLowerCase()].responses[String(response.status)];
  expect(documented, `${method} ${template} documents status ${response.status}`).toBeDefined();
  const [contentType] = Object.keys(documented.content);
  expect(response.headers.get("content-type")).toContain(contentType);
  const schemaId = documented.content[contentType].schema.$ref.split("/").at(-1);
  const validate = ajv.getSchema(`openapi#/components/schemas/${schemaId}`)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

const receipt = (sku: string, quantity = 1, extra: object = {}) => ({ path: "/stock-receipts", template: "/stock-receipts", body: { sku, quantity, ...extra } });
const adjustment = (sku: string, quantityDelta: number, reason = "Recount") => ({
  path: "/stock-adjustments",
  template: "/stock-adjustments",
  body: { sku, quantityDelta, reason },
});
const movementsOf = (variantId: string) => count(pool, "select count(*) from stock_movements where variant_id = $1", [variantId]);

describe("authentication and authorisation on writes", () => {
  it("answers 401 without a token, before looking at the key or the body", async () => {
    const { variant } = await createTestVariant(db, "wauth");
    const { status, body, response } = await call({ ...receipt(variant.sku), token: null, key: null, raw: "{not json", headers: { "content-type": "text/plain" } });
    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="api"');
    expect(await movementsOf(variant.id)).toBe(0);
  });

  it("refuses a valid browser session cookie: cookie-only requests never authenticate a write", async () => {
    const { variant } = await createTestVariant(db, "wauth");
    const { cookie } = await signIn(auth, A.email, A.password);
    const { status } = await call({ ...receipt(variant.sku), token: null, headers: { cookie } });
    expect(status).toBe(401);
    expect(await movementsOf(variant.id)).toBe(0);
  });

  it("refuses invalid, unsigned, expired and revoked tokens, and a disabled user", async () => {
    const { variant } = await createTestVariant(db, "wauth");
    const { rows } = await pool.query("select token from auth_sessions where user_id = $1 limit 1", [aId]);
    for (const bad of ["not-a-token", rows[0].token, `${tokenA.split(".")[0]}.AAAA`]) {
      expect((await call({ ...receipt(variant.sku), token: bad })).status).toBe(401);
    }
    const expiring = (await signInNative(auth, A.email, A.password)).token!;
    await pool.query("update auth_sessions set expires_at = now() - interval '1 minute' where token = $1", [expiring.split(".")[0]]);
    expect((await call({ ...receipt(variant.sku), token: expiring })).status).toBe(401);

    const disabledEmail = "write-disabled@example.test";
    const disabledId = await createTestUser(pool, { email: disabledEmail, password: "write disabled long password", role: "owner" });
    const disabledToken = (await signInNative(auth, disabledEmail, "write disabled long password")).token!;
    await pool.query("update user_access set disabled_at = now() where user_id = $1", [disabledId]);
    expect((await call({ ...receipt(variant.sku), token: disabledToken })).status).toBe(401);
    expect(await movementsOf(variant.id)).toBe(0);
  });

  it("checks authentication before replaying: a revoked token cannot fetch a stored result", async () => {
    const { variant } = await createTestVariant(db, "wauth");
    const token = (await signInNative(auth, A.email, A.password)).token!;
    const key = randomUUID();
    expect((await call({ ...receipt(variant.sku), token, key })).status).toBe(201);
    await auth.handler(new Request(`${BASE_URL}/api/auth/sign-out`, { method: "POST", headers: bearer(token) }));
    const replay = await call({ ...receipt(variant.sku), token, key });
    expect(replay.status).toBe(401);
    expect(JSON.stringify(replay.body)).not.toContain(variant.id);
  });

  it("answers 403 when the role lacks the endpoint's permission, before running anything", async () => {
    const route = apiPost("orders:refund" as never, { body: emptyRequest, status: 200 }, async () => {
      throw new Error("must not run");
    });
    const response = await route(new Request(`${BASE_URL}/api/v1/x`, { method: "POST", headers: bearer(tokenA) }), { params: Promise.resolve({}) });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("FORBIDDEN");
  });

  it("never accepts an actor, user id or role from the client", async () => {
    const { variant } = await createTestVariant(db, "wauth");
    const { status, body } = await call(receipt(variant.sku, 1, { actor_type: "user", actorRef: bId, userId: bId, role: "owner" }));
    expect(status).toBe(400);
    expect(body.errors.map((e: { name: string }) => e.name).sort()).toEqual(["actorRef", "actor_type", "role", "userId"]);
    const spoofed = await call({ ...receipt(variant.sku), headers: { "x-user-id": bId, "x-role": "owner" } });
    expect(spoofed.body.data.movement.actor).toEqual({ type: "user", ref: aId });
    expect(await movementsOf(variant.id)).toBe(1);
  });
});

describe("POST /stock-receipts and /stock-adjustments", () => {
  it("records a receipt for the token's user and returns only the documented fields", async () => {
    const { variant } = await createTestVariant(db, "wstk");
    const { status, body, response } = await call(receipt(variant.sku.toLowerCase(), 4, { reason: "Supplier delivery" }));
    expect(status).toBe(201);
    expect(response.headers.get("idempotent-replayed")).toBeNull();
    expect(Object.keys(body.data).sort()).toEqual(["movement", "onHand", "sku", "variantId"]);
    expect(body.data).toMatchObject({ sku: variant.sku, variantId: variant.id, onHand: 4 });
    expect(Object.keys(body.data.movement).sort()).toEqual(["actor", "createdAt", "id", "quantityDelta", "reason", "type"]);
    expect(body.data.movement).toMatchObject({ type: "receipt", quantityDelta: 4, reason: "Supplier delivery", actor: { type: "user", ref: aId } });
    expect(body.data.movement.createdAt).toMatch(/Z$/);
    const text = JSON.stringify(body);
    for (const secret of [A.email, tokenA, tokenA.split(".")[0]]) expect(text).not.toContain(secret);
  });

  it("replays a retried request with the same key, refuses a changed one, and keeps users apart", async () => {
    const { variant } = await createTestVariant(db, "wstk");
    const key = randomUUID();
    const first = await call({ ...receipt(variant.sku, 2), key });
    const retry = await call({ ...receipt(variant.sku, 2), key });
    expect(retry.status).toBe(201);
    expect(retry.response.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.body.data).toEqual(first.body.data);
    expect((await call({ ...receipt(variant.sku, 3), key })).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await call({ ...adjustment(variant.sku, -1), key })).status).toBe(422);
    const other = await call({ ...receipt(variant.sku, 2), key, token: tokenB });
    expect(other.response.headers.get("idempotent-replayed")).toBeNull();
    expect(other.body.data.movement.actor.ref).toBe(bId);
    expect(await movementsOf(variant.id)).toBe(2);
  });

  it("accepts the key as a quoted string and refuses a missing or malformed key", async () => {
    const { variant } = await createTestVariant(db, "wstk");
    const key = randomUUID();
    expect((await call({ ...receipt(variant.sku), key: `"${key}"` })).status).toBe(201);
    expect((await call({ ...receipt(variant.sku), key })).response.headers.get("idempotent-replayed")).toBe("true");
    for (const bad of [null, "short", "x".repeat(129), "bad key with spaces 123", `"${key}`]) {
      const { status, body } = await call({ ...receipt(variant.sku), key: bad });
      expect(status).toBe(400);
      expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
    expect(await movementsOf(variant.id)).toBe(1);
  });

  it("adjusts up and down with a reason, never below zero", async () => {
    const { variant } = await createTestVariant(db, "wstk");
    await call(receipt(variant.sku, 3));
    expect((await call(adjustment(variant.sku, -2))).body.data.onHand).toBe(1);
    const refused = await call(adjustment(variant.sku, -2));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("INSUFFICIENT_STOCK");
    expect((await call(adjustment(variant.sku, 5, "Found in recount"))).body.data.onHand).toBe(6);
    for (const body of [
      { sku: variant.sku, quantityDelta: 0, reason: "Recount" },
      { sku: variant.sku, quantityDelta: -1 },
      { sku: variant.sku, quantityDelta: -1, reason: "" },
      { sku: variant.sku, quantityDelta: 1.5, reason: "Recount" },
    ]) {
      const { status, body: problem } = await call({ path: "/stock-adjustments", template: "/stock-adjustments", body });
      expect(status).toBe(400);
      expect(problem.code).toBe("VALIDATION_FAILED");
    }
    expect((await call({ path: `/skus/${variant.sku}/stock`, template: "/skus/{sku}/stock", method: "GET", params: { sku: variant.sku } })).body.data.onHand).toBe(6);
  });

  it("answers 404 for an unknown SKU, 409 at the stock limit, and accepts stock for an inactive SKU", async () => {
    expect((await call(receipt("WSTK-NOPE"))).body.code).toBe("VARIANT_NOT_FOUND");
    const { variant } = await createTestVariant(db, "wstk");
    await call(receipt(variant.sku, 2_147_483_647));
    expect((await call(receipt(variant.sku, 1))).body.code).toBe("STOCK_LIMIT_EXCEEDED");
    const inactive = await createTestVariant(db, "wstk");
    expect((await call({ path: `/variants/${inactive.variant.id}/deactivate`, template: "/variants/{variantId}/deactivate", params: { variantId: inactive.variant.id } })).status).toBe(200);
    expect((await call(receipt(inactive.variant.sku, 3))).body.data.onHand).toBe(3);
  });
});

describe("request bodies", () => {
  it("refuses an oversized body by Content-Length without reading it", async () => {
    const { variant } = await createTestVariant(db, "wbody");
    const untouchable = new ReadableStream({
      pull() {
        throw new Error("the body must not be read");
      },
    });
    const { status, body } = await call({ ...receipt(variant.sku), raw: untouchable, headers: { "content-type": "application/json", "content-length": "70000" } });
    expect(status).toBe(413);
    expect(body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("counts bytes while reading: a streamed body over 64 KiB is refused without Content-Length", async () => {
    const { variant } = await createTestVariant(db, "wbody");
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 16_384;
        controller.enqueue(new Uint8Array(16_384).fill(32));
        if (sent > 1_000_000) controller.close();
      },
    });
    const { status } = await call({ ...receipt(variant.sku), raw: stream, headers: { "content-type": "application/json" } });
    expect(status).toBe(413);
    expect(sent).toBeLessThan(200_000);
    expect(await movementsOf(variant.id)).toBe(0);
  });

  it("accepts a large but allowed body (two 5,000-character Bangla descriptions)", async () => {
    const { status, body } = await call({
      path: "/products",
      template: "/products",
      body: { slug: "wbody-long", name: { bn: "লম্বা বিবরণ" }, description: { en: "a".repeat(5000), bn: "অ".repeat(5000) } },
    });
    expect(status).toBe(201);
    expect(body.data.description.bn).toHaveLength(5000);
  });

  it.each([
    ["text/plain", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["application/x-www-form-urlencoded", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["application/json; charset=latin1", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["application/jsonx", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["application/json; charset=utf-8", 201, undefined],
    ["Application/JSON", 201, undefined],
  ])("Content-Type %s → %i", async (contentType, expected, code) => {
    const { variant } = await createTestVariant(db, "wbody");
    const { status, body } = await call({ ...receipt(variant.sku), headers: { "content-type": contentType } });
    expect(status).toBe(expected);
    if (code) expect(body.code).toBe(code);
  });

  it("refuses a body without a Content-Type", async () => {
    const { variant } = await createTestVariant(db, "wbody");
    const request = new Request(`${BASE_URL}/api/v1/stock-receipts`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": randomUUID() },
      body: new Blob([JSON.stringify({ sku: variant.sku, quantity: 1 })]),
    });
    const response = await ROUTES["/stock-receipts"].POST!(request, { params: Promise.resolve({}) as Promise<never> });
    expect(response.status).toBe(415);
  });

  it("refuses malformed JSON and invalid UTF-8 without echoing them", async () => {
    const { variant } = await createTestVariant(db, "wbody");
    for (const raw of ['{"sku": "x", private-value-77', "   ", "{'single': 1}"]) {
      const { status, body } = await call({ ...receipt(variant.sku), raw, headers: { "content-type": "application/json" } });
      expect(status).toBe(400);
      expect(body.code).toBe("MALFORMED_JSON");
      expect(JSON.stringify(body)).not.toContain("private-value-77");
    }
    // An empty body is no JSON at all: the schema reports the missing request.
    expect((await call({ ...receipt(variant.sku), raw: "", headers: { "content-type": "application/json" } })).body.code).toBe("VALIDATION_FAILED");
    const invalidUtf8 = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    expect((await call({ ...receipt(variant.sku), raw: invalidUtf8, headers: { "content-type": "application/json" } })).body.code).toBe("MALFORMED_JSON");
  });

  it("rejects unknown fields (also nested), wrong types and non-object JSON, naming fields only", async () => {
    const { variant } = await createTestVariant(db, "wbody");
    const cases: [unknown, { name: string; message: string }[]][] = [
      [{ sku: variant.sku, quantity: 1, colour: "Red" }, [{ name: "colour", message: "is not a recognised parameter" }]],
      [{ sku: variant.sku, quantity: "1" }, [{ name: "quantity", message: "is required or has the wrong type" }]],
      [{ sku: variant.sku, quantity: 0 }, [{ name: "quantity", message: "is below the minimum" }]],
      [{ quantity: 1 }, [{ name: "sku", message: "is required or has the wrong type" }]],
      [[1, 2], [{ name: "(request)", message: "is required or has the wrong type" }]],
      [null, [{ name: "(request)", message: "is required or has the wrong type" }]],
    ];
    for (const [body, errors] of cases) {
      const response = await call({ path: "/stock-receipts", template: "/stock-receipts", body });
      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual(errors.map((e) => ({ location: "body", ...e })));
    }
    const nested = await call({ path: "/products", template: "/products", body: { slug: "wbody-nested", name: { en: "X", fr: "Y" } } });
    expect(nested.body.errors).toEqual([{ location: "body", name: "name.fr", message: "is not a recognised parameter" }]);
    expect(await movementsOf(variant.id)).toBe(0);
  });
});

describe("catalogue writes", () => {
  it("creates a draft product (201) once per key, refuses a taken slug (409) and invalid input (400)", async () => {
    const key = randomUUID();
    const body = { slug: "wcat-romper", name: { en: "Romper", bn: "রম্পার" } };
    const created = await call({ path: "/products", template: "/products", body, key });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ slug: "wcat-romper", status: "draft", name: { en: "Romper", bn: "রম্পার" }, description: { en: null, bn: null }, variants: [] });
    expect((await call({ path: "/products", template: "/products", body, key })).response.headers.get("idempotent-replayed")).toBe("true");
    expect((await call({ path: "/products", template: "/products", body })).body.code).toBe("SLUG_TAKEN");
    for (const bad of [{ slug: "Bad Slug", name: { en: "X" } }, { slug: "wcat-noname", name: {} }, { slug: "wcat-blank", name: { en: "  " } }]) {
      const { status, body: problem } = await call({ path: "/products", template: "/products", body: bad });
      expect(status).toBe(400);
      expect(problem.code).toBe("VALIDATION_FAILED");
    }
    expect(await count(pool, "select count(*) from products where slug like 'wcat-%'")).toBe(1);
  });

  it("adds a variant with an integer-paisa price, refusing duplicate SKUs, unknown products and bad prices", async () => {
    const { body: created } = await call({ path: "/products", template: "/products", body: { slug: "wcat-bib", name: { en: "Bib" } } });
    const productId = created.data.id;
    const variants = (body: object, id = productId) => call({ path: `/products/${id}/variants`, template: "/products/{productId}/variants", params: { productId: id }, body });
    const added = await variants({ sku: "wcat-bib-01", size: "0-3M", colour: "Ivory", pricePaisa: 45_050 });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ sku: "WCAT-BIB-01", pricePaisa: 45_050, status: "active", size: "0-3M" });
    expect((await variants({ sku: "WCAT-bib-01", pricePaisa: 100 })).body.code).toBe("SKU_TAKEN");
    expect((await variants({ sku: "WCAT-BIB-02", pricePaisa: 100 }, randomUUID())).body.code).toBe("PRODUCT_NOT_FOUND");
    expect((await variants({ sku: "WCAT-BIB-02", pricePaisa: 100 }, "not-a-uuid")).status).toBe(400);
    for (const pricePaisa of [0, -5, 10.5, "100", 9_007_199_254_740_992]) {
      expect((await variants({ sku: "WCAT-BIB-03", pricePaisa })).status).toBe(400);
    }
    expect((await variants({ sku: "bad sku!", pricePaisa: 100 })).status).toBe(400);
    expect(await count(pool, "select count(*) from variants where product_id = $1", [productId])).toBe(1);
  });

  it("archives a product and deactivates a variant with no body or an empty object; never deletes", async () => {
    const { product, variant } = await createTestVariant(db, "wcatarc");
    const archive = (extra: Partial<Call> = {}) =>
      call({ path: `/products/${product.id}/archive`, template: "/products/{productId}/archive", params: { productId: product.id }, ...extra });
    const archived = await archive();
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe("archived");
    expect(archived.body.data.variants).toHaveLength(1);
    expect((await archive({ body: {} })).status).toBe(200);
    expect((await archive({ body: { reason: "x" } })).status).toBe(400);
    const missing = randomUUID();
    expect((await call({ path: `/products/${missing}/archive`, template: "/products/{productId}/archive", params: { productId: missing } })).status).toBe(404);
    const deactivated = await call({ path: `/variants/${variant.id}/deactivate`, template: "/variants/{variantId}/deactivate", params: { variantId: variant.id } });
    expect(deactivated.body.data.status).toBe("inactive");
    expect((await call({ path: `/variants/${missing}/deactivate`, template: "/variants/{variantId}/deactivate", params: { variantId: missing } })).body.code).toBe(
      "VARIANT_NOT_FOUND",
    );
    expect(await count(pool, "select count(*) from products where id = $1", [product.id])).toBe(1);
  });
});

describe("origin policy (CORS)", () => {
  it("refuses requests announcing another origin, on reads and writes, and sends no CORS headers", async () => {
    const { variant } = await createTestVariant(db, "wcors");
    const evil = { origin: "https://attacker.example" };
    const write = await call({ ...receipt(variant.sku), headers: evil });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe("ORIGIN_NOT_ALLOWED");
    const read = await call({ method: "GET", path: "/products", template: "/products", headers: evil });
    expect(read.body.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(await movementsOf(variant.id)).toBe(0);
    // The site's own origin and native clients (no Origin) are unaffected.
    expect((await call({ ...receipt(variant.sku), headers: { origin: BASE_URL } })).status).toBe(201);
  });

  it("answers a CORS preflight with 405 and no Access-Control-* headers", async () => {
    for (const template of Object.keys(ROUTES)) {
      const response = await ROUTES[template].OPTIONS!(
        new Request(`${BASE_URL}/api/v1/x`, { method: "OPTIONS", headers: { origin: "https://attacker.example", "access-control-request-method": "POST" } }),
        { params: Promise.resolve({}) as Promise<never> },
      );
      expect(response.status, template).toBe(405);
      expect([...response.headers.keys()].filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("rate limits", () => {
  it("answers 429 with Retry-After once a user's write limit is used, per user and per category", async () => {
    vi.stubEnv("API_RATE_LIMIT_WRITES_PER_MINUTE", "2");
    const { variant } = await createTestVariant(db, "wrate");
    expect((await call(receipt(variant.sku))).status).toBe(201);
    expect((await call(receipt(variant.sku))).status).toBe(201);
    const limited = await call(receipt(variant.sku));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    const retryAfter = Number(limited.response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await movementsOf(variant.id)).toBe(2);
    // Another user, and reads by the same user, have their own counters.
    expect((await call({ ...receipt(variant.sku), token: tokenB })).status).toBe(201);
    expect((await call({ method: "GET", path: "/products", template: "/products" })).status).toBe(200);
  });

  it("starts counting again in a new window", async () => {
    vi.stubEnv("API_RATE_LIMIT_READS_PER_MINUTE", "1");
    const get = () => call({ method: "GET", path: "/products", template: "/products" });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429);
    await pool.query("update api_rate_limits set window_start = window_start - interval '60 seconds' where user_id = $1 and bucket = 'read'", [aId]);
    expect((await get()).status).toBe(200);
    expect(await count(pool, "select count from api_rate_limits where user_id = $1 and bucket = 'read'", [aId])).toBe(1);
  });

  it("does not let unauthenticated traffic touch any user's counter", async () => {
    vi.stubEnv("API_RATE_LIMIT_READS_PER_MINUTE", "1");
    for (let i = 0; i < 5; i++) {
      expect((await call({ method: "GET", path: "/products", template: "/products", token: null })).status).toBe(401);
      expect((await call({ method: "GET", path: "/products", template: "/products", token: "forged.token" })).status).toBe(401);
    }
    expect(await count(pool, "select count(*) from api_rate_limits")).toBe(0);
    expect((await call({ method: "GET", path: "/products", template: "/products" })).status).toBe(200);
  });

  it("lets exactly the limit through when requests arrive at the same moment", async () => {
    const { db: racingDb, pool: racingPool } = await createTestDb(6);
    await consumeRateLimit(db, aId, "write", 100); // Creates the counter row (count 1).
    const gate = await pool.connect();
    try {
      await gate.query("begin");
      await gate.query("select * from api_rate_limits where user_id = $1 and bucket = 'write' for update", [aId]);
      const attempts = Array.from({ length: 6 }, () => consumeRateLimit(racingDb, aId, "write", 4));
      const deadline = Date.now() + 5_000;
      while ((await count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like '%api_rate_limits%'")) < 6) {
        if (Date.now() > deadline) throw new Error("The attempts did not all reach the counter lock.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await gate.query("commit");
      const results = await Promise.all(attempts);
      expect(results.filter((r) => r.allowed)).toHaveLength(3);
      expect(await count(pool, "select count from api_rate_limits where user_id = $1 and bucket = 'write'", [aId])).toBe(7);
    } finally {
      gate.release();
      await racingPool.end();
    }
  });
});

describe("failures and contract", () => {
  it("turns an unexpected database error during a write into a generic 500 and commits nothing", async () => {
    const { variant } = await createTestVariant(db, "wfail");
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    try {
      const { status, body } = await withFailingInserts(pool, "stock_movements", () => call(receipt(variant.sku, 1, { reason: "private-note-55" })));
      expect(status).toBe(500);
      expect(body).toEqual({ type: "about:blank", title: "Internal error", status: 500, code: "INTERNAL_ERROR", requestId: body.requestId });
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("\n")).toContain('"sqlState":"P0001"');
    expect(logged.join("\n")).not.toMatch(/private-note-55|injected|insert|stock_movements/i);
    expect(await movementsOf(variant.id)).toBe(0);
    expect(await count(pool, "select count(*) from idempotency_records where user_id = $1 and result is null", [aId])).toBe(0);
  });

  it("documents every route and method that exists, and nothing else", async () => {
    const implemented = Object.entries(ROUTES).flatMap(([template, module]) =>
      ["GET", "POST", "PATCH", "PUT"].flatMap((m) => (module[m] ? [`${m.toLowerCase()} ${template}`] : [])),
    );
    // A route exports 405 handlers for the methods it does not support; ask each handler.
    const real: string[] = [];
    for (const entry of implemented) {
      const [method, template] = entry.split(" ");
      const response = await ROUTES[template][method.toUpperCase()]!(
        new Request(`${BASE_URL}/api/v1/x`, { method: method.toUpperCase() }),
        { params: Promise.resolve({}) as Promise<never> },
      );
      if (response.status !== 405) real.push(entry);
    }
    const documented = Object.entries(doc.paths).flatMap(([template, item]) => Object.keys(item).map((m) => `${m} ${template}`));
    expect(real.sort()).toEqual(documented.sort());
  });
});

describe("draft editing (PATCH)", () => {
  const editProduct = (id: string, body: unknown, extra: Partial<Call> = {}) => ({
    method: "PATCH",
    path: `/products/${id}`,
    template: "/products/{productId}",
    params: { productId: id },
    body,
    ...extra,
  });
  const editVariant = (id: string, body: unknown, extra: Partial<Call> = {}) => ({
    method: "PATCH",
    path: `/variants/${id}`,
    template: "/variants/{variantId}",
    params: { variantId: id },
    body,
    ...extra,
  });

  it("edits a draft product's text, keeps slug and id, and bumps the version", async () => {
    const { product } = await createTestVariant(db, "wedit");
    const { status, body } = await call(editProduct(product.id, { version: 1, name: { en: "Renamed Romper" }, description: { bn: "নতুন বিবরণ" } }));
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ id: product.id, slug: product.slug, version: 2, name: { en: "Renamed Romper", bn: "পরীক্ষামূলক রম্পার" } });
    expect(body.data.description).toEqual({ en: null, bn: "নতুন বিবরণ" });
  });

  it("refuses a stale version with 409 VERSION_CONFLICT and saves nothing", async () => {
    const { product } = await createTestVariant(db, "wstale");
    expect((await call(editProduct(product.id, { version: 1, name: { en: "First edit" } }))).status).toBe(200);
    const stale = await call(editProduct(product.id, { version: 1, name: { en: "Stale edit" } }));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const { rows } = await pool.query("select name_en, version from products where id = $1", [product.id]);
    expect(rows).toEqual([{ name_en: "First edit", version: 2 }]);
  });

  it("replays a retried edit with the same key instead of editing twice", async () => {
    const { product } = await createTestVariant(db, "wreplay");
    const key = randomUUID();
    const first = await call(editProduct(product.id, { version: 1, name: { en: "Once" } }, { key }));
    const again = await call(editProduct(product.id, { version: 1, name: { en: "Once" } }, { key }));
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.response.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body.data.version).toBe(2);
    const reused = await call(editProduct(product.id, { version: 1, name: { en: "Different" } }, { key }));
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("refuses archived products, removing every name, unknown fields, and a missing version", async () => {
    const { product } = await createTestVariant(db, "wbad");
    const cases: [unknown, number, string][] = [
      [{ version: 1, name: { en: null, bn: "" } }, 400, "VALIDATION_FAILED"],
      [{ version: 1 }, 400, "VALIDATION_FAILED"],
      [{ name: { en: "No version" } }, 400, "VALIDATION_FAILED"],
      [{ version: 1, slug: "new-slug" }, 400, "VALIDATION_FAILED"],
      [{ version: 1, status: "draft" }, 400, "VALIDATION_FAILED"],
      [{ version: 0, name: { en: "x" } }, 400, "VALIDATION_FAILED"],
      [{ version: 1, name: { en: "x".repeat(201) } }, 400, "VALIDATION_FAILED"],
    ];
    for (const [body, status, code] of cases) {
      const answer = await call(editProduct(product.id, body));
      expect([answer.status, answer.body.code], JSON.stringify(body)).toEqual([status, code]);
    }
    await call({ path: `/products/${product.id}/archive`, template: "/products/{productId}/archive", params: { productId: product.id } });
    const archived = await call(editProduct(product.id, { version: 2, name: { en: "Back to draft?" } }));
    expect([archived.status, archived.body.code]).toEqual([409, "PRODUCT_NOT_EDITABLE"]);
    expect((await pool.query("select status, name_en from products where id = $1", [product.id])).rows).toEqual([
      { status: "archived", name_en: "Test Romper" },
    ]);
  });

  it("needs a Bearer token, ignores cookies and refuses other origins", async () => {
    const { product } = await createTestVariant(db, "wpauth");
    const { cookie } = await signIn(auth, A.email, A.password);
    const cookieOnly = await call(editProduct(product.id, { version: 1, name: { en: "x" } }, { token: null, headers: { cookie } }));
    expect(cookieOnly.status).toBe(401);
    const otherOrigin = await call(editProduct(product.id, { version: 1, name: { en: "x" } }, { headers: { origin: "https://evil.example" } }));
    expect([otherOrigin.status, otherOrigin.body.code]).toEqual([403, "ORIGIN_NOT_ALLOWED"]);
    const noKey = await call(editProduct(product.id, { version: 1, name: { en: "x" } }, { key: null }));
    expect(noKey.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(await count(pool, "select count(*) from products where id = $1 and version = 1", [product.id])).toBe(1);
  });

  it("scopes keys per user: the same key from another Owner is its own request and meets the version check", async () => {
    const { product } = await createTestVariant(db, "wcross");
    const key = randomUUID();
    expect((await call(editProduct(product.id, { version: 1, name: { en: "By A" } }, { key }))).status).toBe(200);
    const fromB = await call(editProduct(product.id, { version: 1, name: { en: "By A" } }, { key, token: tokenB }));
    expect([fromB.status, fromB.body.code]).toEqual([409, "VERSION_CONFLICT"]);
  });

  it("edits a variant's price in exact paisa without touching its SKU or stock", async () => {
    const { variant } = await createTestVariant(db, "wvar");
    await call(receipt(variant.sku, 6));
    const { status, body } = await call(editVariant(variant.id, { version: 1, pricePaisa: 9_007_199_254_740_991, colour: null }));
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ id: variant.id, sku: variant.sku, pricePaisa: 9_007_199_254_740_991, colour: null, size: "0-3M", version: 2 });
    expect((await pool.query("select on_hand from inventory_balances where variant_id = $1", [variant.id])).rows).toEqual([{ on_hand: 6 }]);
    expect(await movementsOf(variant.id)).toBe(1);
    for (const bad of [{ version: 2, pricePaisa: 0 }, { version: 2, pricePaisa: 1.5 }, { version: 2, pricePaisa: "850" }, { version: 2, sku: "NEW-SKU" }, { version: 2, status: "active" }]) {
      expect((await call(editVariant(variant.id, bad))).status, JSON.stringify(bad)).toBe(400);
    }
    const unknown = await call(editVariant("3f8a6c1e-2b4d-4e6f-8a1b-2c3d4e5f6a7b", { version: 1, size: "1Y" }));
    expect([unknown.status, unknown.body.code]).toEqual([404, "VARIANT_NOT_FOUND"]);
  });

  it("refuses inactive variants and variants of archived products", async () => {
    const one = await createTestVariant(db, "wvoff");
    await call({ path: `/variants/${one.variant.id}/deactivate`, template: "/variants/{variantId}/deactivate", params: { variantId: one.variant.id } });
    const inactive = await call(editVariant(one.variant.id, { version: 2, size: "1Y" }));
    expect([inactive.status, inactive.body.code]).toEqual([409, "VARIANT_NOT_EDITABLE"]);
    const two = await createTestVariant(db, "wvarch");
    await call({ path: `/products/${two.product.id}/archive`, template: "/products/{productId}/archive", params: { productId: two.product.id } });
    const archived = await call(editVariant(two.variant.id, { version: 1, size: "1Y" }));
    expect([archived.status, archived.body.code]).toEqual([409, "VARIANT_NOT_EDITABLE"]);
  });
});

describe("product search (GET /products?q=)", () => {
  const search = (query: Record<string, string>) => call({ method: "GET", path: `/products?${new URLSearchParams(query)}`, template: "/products" });

  it("finds products by English or Bangla name, slug and SKU, case-insensitively", async () => {
    const { product, variant } = await createTestVariant(db, "wsearch");
    for (const q of ["test romper", "TEST ROMPER", "পরীক্ষামূলক", product.slug.toUpperCase(), variant.sku.toLowerCase()]) {
      const { status, body } = await search({ q, limit: "100" });
      expect(status, q).toBe(200);
      expect(body.data.map((p: { id: string }) => p.id), q).toContain(product.id);
    }
  });

  it("treats SQL and LIKE syntax as plain text and refuses unsafe input", async () => {
    const total = await count(pool, "select count(*) from products");
    expect(total).toBeGreaterThan(0);
    for (const q of ["' or 1=1 --", "%", "_", "\\", "'; drop table products; --"]) {
      const { status, body } = await search({ q, limit: "100" });
      expect(status, q).toBe(200);
      // Every hit really contains the characters typed (an underscore SKU may exist); nothing else comes back.
      for (const item of body.data as { id: string }[]) {
        const literal = await count(
          pool,
          `select count(*) from products p where p.id = $1 and (position($2 in p.slug) > 0 or position($2 in coalesce(p.name_en, '')) > 0
             or position($2 in coalesce(p.name_bn, '')) > 0 or exists (select 1 from variants v where v.product_id = p.id and position(upper($2) in v.sku) > 0))`,
          [item.id, q],
        );
        expect(literal, q).toBe(1);
      }
    }
    expect(await count(pool, "select count(*) from products")).toBe(total);
    const long = await search({ q: "x".repeat(101) });
    expect([long.status, long.body.errors]).toEqual([400, [{ location: "query", name: "q", message: "is above the maximum" }]]);
    const control = await search({ q: "romper\u0000" });
    expect([control.status, control.body.code]).toEqual([400, "VALIDATION_FAILED"]);
    const repeated = await call({ method: "GET", path: "/products?q=a&q=b", template: "/products" });
    expect(repeated.status).toBe(400);
  });
});
