import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import { actorFor, getBearerPrincipal } from "../../src/modules/auth/principal";
import { receiveStock } from "../../src/modules/inventory/service";
import { BASE_URL, bearer, clearAuthState, createTestAuth, createTestUser, signIn, signInNative } from "../support/auth";
import { createTestVariant } from "../support/fixtures";
import { resetAndMigrate } from "../support/global-setup";
import { createTestDb } from "../support/test-database";

// /api/v1 through the real route handlers, against PostgreSQL, with every response checked against the
// published OpenAPI document (status documented for the operation, content type, body schema).

const state = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/modules/auth/server", () => ({ getAuth: () => state.auth }));

const productsRoute = await import("../../src/app/api/v1/products/route");
const productRoute = await import("../../src/app/api/v1/products/[productId]/route");
const stockRoute = await import("../../src/app/api/v1/skus/[sku]/stock/route");
const movementsRoute = await import("../../src/app/api/v1/skus/[sku]/movements/route");
const fallbackRoute = await import("../../src/app/api/v1/[...path]/route");
const openApiRoute = await import("../../src/app/api/v1/openapi.json/route");
const { apiGet } = await import("../../src/api/v1/http");

const OWNER = { email: "api-owner@example.test", password: "api owner long password", role: "owner" as const };

let db: Db;
let pool: Pool;
let auth: ReturnType<typeof createTestAuth>;
let ownerId: string;
let token: string;
type Documented = { content: Record<string, { schema: { $ref: string } }> };
type OpenApiDoc = { paths: Record<string, { get: { responses: Record<string, Documented> } }> };
let doc: OpenApiDoc;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);

beforeAll(async () => {
  await resetAndMigrate(process.env.TEST_DATABASE_URL);
  ({ db, pool } = await createTestDb(6));
  auth = createTestAuth(db);
  Object.assign(state, { db, auth });
  doc = await openApiRoute.GET().json();
  ajv.addSchema(doc, "openapi");
  await clearAuthState(pool);
  ownerId = await createTestUser(pool, { ...OWNER, name: "Api Owner" });
  token = (await signInNative(auth, OWNER.email, OWNER.password)).token!;
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from auth_rate_limits");
});

type Call = { path: string; template: string; params?: Record<string, string>; headers?: Headers };
const ROUTES: Record<string, { GET: (r: Request, c: { params: Promise<never> }) => Promise<Response> }> = {
  "/products": productsRoute as never,
  "/products/{productId}": productRoute as never,
  "/skus/{sku}/stock": stockRoute as never,
  "/skus/{sku}/movements": movementsRoute as never,
};

/** Calls the route for `template` and checks the response against the OpenAPI document. */
async function get({ path, template, params = {}, headers = bearer(token) }: Call) {
  const response = await ROUTES[template].GET(new Request(`${BASE_URL}/api/v1${path}`, { headers }), {
    params: Promise.resolve(params) as Promise<never>,
  });
  const body = await response.json();
  expectContract(template, response, body);
  return { status: response.status, body, response };
}

function expectContract(template: string, response: Response, body: unknown) {
  const documented = doc.paths[template].get.responses[String(response.status)];
  expect(documented, `${template} documents status ${response.status}`).toBeDefined();
  const [contentType] = Object.keys(documented.content);
  expect(response.headers.get("content-type")).toContain(contentType);
  const schemaId = documented.content[contentType].schema.$ref.split("/").at(-1);
  const validate = ajv.getSchema(`openapi#/components/schemas/${schemaId}`)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.headers.get("cache-control")).toBe("no-store");
}

async function product(slug: string, createdAt?: string) {
  const { rows } = await pool.query<{ id: string }>(
    "insert into products (slug, name_en, name_bn, created_at) values ($1, 'Test Romper', 'পরীক্ষা', coalesce($2::timestamptz, now())) returning id",
    [slug, createdAt ?? null],
  );
  return rows[0].id;
}

describe("authentication on /api/v1", () => {
  it("answers 401 with a Bearer challenge when no token is sent", async () => {
    const { status, body, response } = await get({ path: "/products", template: "/products", headers: new Headers() });
    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="api"');
  });

  it("refuses a valid browser session cookie: cookies are never an API credential", async () => {
    const { cookie } = await signIn(auth, OWNER.email, OWNER.password);
    const { status, body } = await get({ path: "/products", template: "/products", headers: new Headers({ cookie }) });
    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("refuses an invalid, unsigned or revoked token", async () => {
    const { rows } = await pool.query("select token from auth_sessions where user_id = $1 limit 1", [ownerId]);
    for (const bad of ["not-a-token", rows[0].token, `${token.split(".")[0]}.AAAA`]) {
      expect((await get({ path: "/products", template: "/products", headers: bearer(bad) })).status).toBe(401);
    }
    const revoked = (await signInNative(auth, OWNER.email, OWNER.password)).token!;
    await auth.handler(new Request(`${BASE_URL}/api/auth/sign-out`, { method: "POST", headers: bearer(revoked) }));
    expect((await get({ path: "/products", template: "/products", headers: bearer(revoked) })).status).toBe(401);
  });

  it("refuses a user without active access, and a disabled user", async () => {
    await createTestUser(pool, { email: "api-noaccess@example.test", password: "no access long password", role: null });
    // Such a user cannot even obtain a token.
    expect((await signInNative(auth, "api-noaccess@example.test", "no access long password")).token).toBeNull();
    const disabledId = await createTestUser(pool, { email: "api-disabled@example.test", password: "disabled long password", role: "owner" });
    const disabledToken = (await signInNative(auth, "api-disabled@example.test", "disabled long password")).token!;
    expect((await get({ path: "/products", template: "/products", headers: bearer(disabledToken) })).status).toBe(200);
    await pool.query("update user_access set disabled_at = now() where user_id = $1", [disabledId]);
    expect((await get({ path: "/products", template: "/products", headers: bearer(disabledToken) })).status).toBe(401);
  });

  it("ignores client-supplied identity: role, user id and actor headers or parameters", async () => {
    const spoof = new Headers({ "x-user-id": ownerId, "x-role": "owner", "x-actor": ownerId });
    expect((await get({ path: "/products", template: "/products", headers: spoof })).status).toBe(401);
    const { status, body } = await get({ path: "/products?role=owner", template: "/products" });
    expect(status).toBe(400);
    expect(body.errors).toEqual([{ location: "query", name: "role", message: "is not a recognised parameter" }]);
  });

  it("answers 403 when the role lacks the endpoint's permission", async () => {
    // Every role today (owner) holds every permission, so the wrapper is exercised with one no role has.
    const route = apiGet("orders:refund" as never, async () => ({ data: "never" }));
    const response = await route(new Request(`${BASE_URL}/api/v1/x`, { headers: bearer(token) }), { params: Promise.resolve({}) });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("FORBIDDEN");
  });

  it("uses the token's principal as an audit actor", async () => {
    const principal = (await getBearerPrincipal(auth, db, bearer(token)))!;
    const { variant } = await createTestVariant(db, "apiact");
    const { movement } = await receiveStock(db, { sku: variant.sku, quantity: 2, actor: actorFor(principal) });
    expect(movement).toMatchObject({ actorType: "user", actorRef: ownerId });
  });
});

describe("products", () => {
  it("lists products in a stable (created_at, id) order across pages, ties and microsecond steps included", async () => {
    await pool.query("delete from products where slug like 'page-%'");
    const same = "2026-01-01T00:00:00.000001Z";
    const ids = [
      await product("page-a", same),
      await product("page-b", same),
      await product("page-c", same),
      await product("page-d", "2026-01-01T00:00:00.000002Z"),
      await product("page-e", "2026-01-01T00:00:00.000003Z"),
    ];
    const expected = [...ids.slice(0, 3).sort(), ids[3], ids[4]];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `/products?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { status, body } = await get({ path: query, template: "/products" });
      expect(status).toBe(200);
      expect(body.page.limit).toBe(2);
      expect(body.data.length).toBeLessThanOrEqual(2);
      seen.push(...body.data.map((p: { id: string }) => p.id).filter((id: string) => ids.includes(id)));
      cursor = body.page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(expected);
  });

  it("filters by status and returns only the documented fields", async () => {
    const id = await product("api-archived");
    await pool.query("update products set status = 'archived' where id = $1", [id]);
    const { body } = await get({ path: "/products?status=archived&limit=100", template: "/products" });
    expect(body.data.every((p: { status: string }) => p.status === "archived")).toBe(true);
    const item = body.data.find((p: { id: string }) => p.id === id);
    expect(Object.keys(item).sort()).toEqual(["createdAt", "id", "name", "slug", "status", "updatedAt"]);
    expect(item.name).toEqual({ en: "Test Romper", bn: "পরীক্ষা" });
  });

  it("returns one product with its variants", async () => {
    const { product: p, variant } = await createTestVariant(db, "apiprod");
    const { status, body } = await get({ path: `/products/${p.id}`, template: "/products/{productId}", params: { productId: p.id } });
    expect(status).toBe(200);
    expect(body.data.id).toBe(p.id);
    expect(body.data.variants).toEqual([
      expect.objectContaining({ id: variant.id, sku: variant.sku, pricePaisa: 85_000, status: "active" }),
    ]);
  });

  it("answers 404 for an unknown product and 400 for a malformed id", async () => {
    const unknown = "3f8a6c1e-2b4d-4e6f-8a1b-2c3d4e5f6a7b";
    const missing = await get({ path: `/products/${unknown}`, template: "/products/{productId}", params: { productId: unknown } });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("PRODUCT_NOT_FOUND");
    const malformed = await get({ path: "/products/not-a-uuid", template: "/products/{productId}", params: { productId: "not-a-uuid" } });
    expect(malformed.status).toBe(400);
    expect(malformed.body.errors).toEqual([{ location: "path", name: "productId", message: "has an invalid format" }]);
  });
});

describe("input validation", () => {
  it.each([
    ["limit=0", "limit", "is below the minimum"],
    ["limit=101", "limit", "is above the maximum"],
    ["limit=abc", "limit", "has an invalid format"],
    ["limit=1.5", "limit", "has an invalid format"],
    ["status=published", "status", "is not an allowed value"],
    ["cursor=", "cursor", "is below the minimum"],
    ["cursor=%7B%7D", "cursor", "is not valid"],
    ["cursor=eyJjIjoiMjAyNi0wMS0wMVQwMDowMDowMFoiLCJpIjoieCJ9", "cursor", "is not valid"],
    ["limit=1&limit=2", "limit", "must not be repeated"],
    ["unknown=1", "unknown", "is not a recognised parameter"],
  ])("rejects %s", async (query, name, message) => {
    const { status, body } = await get({ path: `/products?${query}`, template: "/products" });
    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.errors).toEqual([{ location: "query", name, message }]);
  });

  it("never echoes the offending values, and masks odd parameter names", async () => {
    const { body } = await get({ path: "/products?%3Cscript%3E=1&limit=private-value-99", template: "/products" });
    const text = JSON.stringify(body);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("private-value-99");
    expect(body.errors).toContainEqual({ location: "query", name: "(parameter)", message: "is not a recognised parameter" });
  });

  it("does not validate input for an anonymous caller (401 first)", async () => {
    expect((await get({ path: "/products?limit=999", template: "/products", headers: new Headers() })).status).toBe(401);
  });
});

describe("stock", () => {
  it("reads current stock by SKU, case-insensitively", async () => {
    const { variant } = await createTestVariant(db, "apistk");
    await receiveStock(db, { sku: variant.sku, quantity: 7, actor: { type: "system", ref: "integration-test" } });
    const { status, body } = await get({ path: `/skus/${variant.sku.toLowerCase()}/stock`, template: "/skus/{sku}/stock", params: { sku: variant.sku.toLowerCase() } });
    expect(status).toBe(200);
    expect(body.data).toEqual({ sku: variant.sku, variantId: variant.id, onHand: 7 });
  });

  it("answers 404 for an unknown SKU and 400 for an invalid one", async () => {
    expect((await get({ path: "/skus/NOPE-NOPE/stock", template: "/skus/{sku}/stock", params: { sku: "NOPE-NOPE" } })).body.code).toBe(
      "VARIANT_NOT_FOUND",
    );
    const invalid = await get({ path: "/skus/bad%20sku/stock", template: "/skus/{sku}/stock", params: { sku: "bad sku" } });
    expect(invalid.status).toBe(400);
  });

  it("pages through a SKU's movement history in ledger order with bounded pages", async () => {
    const { variant } = await createTestVariant(db, "apimov");
    for (let i = 1; i <= 5; i++) await receiveStock(db, { sku: variant.sku, quantity: i, actor: { type: "system", ref: "integration-test" } });
    const deltas: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string = `/skus/${variant.sku}/movements?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const { status, body } = await get({ path, template: "/skus/{sku}/movements", params: { sku: variant.sku } });
      expect(status).toBe(200);
      deltas.push(...body.data.map((m: { quantityDelta: number }) => m.quantityDelta));
      cursor = body.page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(deltas).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
    const { body } = await get({ path: `/skus/${variant.sku}/movements`, template: "/skus/{sku}/movements", params: { sku: variant.sku } });
    expect(Object.keys(body.data[0]).sort()).toEqual(["actor", "createdAt", "id", "quantityDelta", "reason", "type"]);
    expect(body.data[0].actor).toEqual({ type: "system", ref: "integration-test" });
  });
});

describe("failures and safety", () => {
  it("turns an unexpected database error into a generic 500 and logs no internals", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    await pool.query("alter table products rename column slug to slug_moved");
    try {
      const { status, body } = await get({ path: "/products", template: "/products" });
      expect(status).toBe(500);
      expect(body).toEqual({ type: "about:blank", title: "Internal error", status: 500, code: "INTERNAL_ERROR", requestId: body.requestId });
    } finally {
      await pool.query("alter table products rename column slug_moved to slug");
      spy.mockRestore();
    }
    expect(logged.join("\n")).toContain('"sqlState":"42703"');
    expect(logged.join("\n")).not.toMatch(/slug|select|does not exist|api-owner/i);
  });

  it("returns problem responses for unknown paths and unsupported methods", async () => {
    const unknown = await fallbackRoute.GET();
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("ROUTE_NOT_FOUND");
    const post = await productsRoute.POST();
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    expect((await post.json()).code).toBe("METHOD_NOT_ALLOWED");
  });

  it("exposes no personal or credential data in any response", async () => {
    const { body } = await get({ path: "/products?limit=100", template: "/products" });
    const text = JSON.stringify(body);
    for (const secret of [OWNER.email, "Api Owner", token, token.split(".")[0]]) expect(text).not.toContain(secret);
  });
});

describe("OpenAPI document", () => {
  it("is served publicly and matches the routes that exist", async () => {
    const response = openApiRoute.GET();
    expect(response.status).toBe(200);
    expect(Object.keys(doc.paths).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const template of Object.keys(ROUTES)) {
      expect(Object.keys(doc.paths[template]), template).toEqual(["get"]);
      expect(doc.paths[template].get.responses["401"]).toBeDefined();
    }
  });
});
