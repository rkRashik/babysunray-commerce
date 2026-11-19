import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type LaunchFacts, type PolicyState, publicCheckoutGate } from "../../src/modules/launch/gate";

// The storewide activation barrier (Gate H.26) and the structural guarantees around the shop (ADR-0011): the real catalogue,
// checkout and customer sign-in are routed, but only behind the per-request access check (src/modules/launch/acceptance.ts).

const STATES: PolicyState[] = ["empty", "drafted", "reviewed", "published"];
const ALWAYS = ["publication_rule", "abuse_protection", "production_database", "recovery_objectives", "launch_approval"];
const ROOT = path.resolve(import.meta.dirname, "../..");
const files = (dir: string): string[] => readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)).replaceAll("\\", "/"));

describe("public checkout gate", () => {
  it("is closed for every combination of facts, including everything drafted, reviewed and configured", () => {
    for (const state of STATES) {
      for (const deliveryZonesConfigured of [false, true]) {
        for (const reviewedProducts of [0, 1, 500]) {
          const facts: LaunchFacts = { policies: { delivery: state, returns: state, privacy: state, checkout_notices: state }, deliveryZonesConfigured, reviewedProducts };
          const gate = publicCheckoutGate(facts);
          expect(gate.open).toBe(false);
          expect(gate.blockers.map((b) => b.id)).toEqual(expect.arrayContaining(ALWAYS));
          expect(gate.blockers.some((b) => b.id === "policies_not_published")).toBe(state !== "published");
          for (const b of gate.blockers) expect(b.reason.length * b.next.length * b.requirement.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("names what the data says is missing, and stops naming it once it is there", () => {
    const empty = publicCheckoutGate({ policies: { delivery: "empty", returns: "empty", privacy: "drafted", checkout_notices: "empty" }, deliveryZonesConfigured: false, reviewedProducts: 0 });
    expect(empty.blockers.map((b) => b.id)).toEqual(expect.arrayContaining(["policy_delivery_missing", "policy_returns_missing", "delivery_charges", "no_reviewed_products"]));
    expect(empty.blockers.map((b) => b.id)).not.toContain("policy_privacy_missing");
    const filled = publicCheckoutGate({ policies: { delivery: "reviewed", returns: "reviewed", privacy: "reviewed", checkout_notices: "reviewed" }, deliveryZonesConfigured: true, reviewedProducts: 3 });
    expect(filled.blockers.map((b) => b.id)).not.toEqual(expect.arrayContaining(["delivery_charges"]));
    expect(filled.blockers.some((b) => b.id.endsWith("_missing") || b.id === "no_reviewed_products")).toBe(false);
    // Everything the data can show is done: only the decisions this system cannot record remain, and the gate stays closed.
    const done = publicCheckoutGate({ policies: { delivery: "published", returns: "published", privacy: "published", checkout_notices: "empty" }, deliveryZonesConfigured: true, reviewedProducts: 3 });
    expect(done.open).toBe(false);
    expect(done.blockers.map((b) => b.id).sort()).toEqual([...ALWAYS].sort());
  });

  it("has no switch: the module reads no environment, setting or database", () => {
    const source = readFileSync(path.join(ROOT, "src/modules/launch/gate.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|import\s/);
  });
});

describe("the shop is reachable only through the access check", () => {
  const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

  it("only the shop checkout route imports the guest checkout transport, and it asks the access check first", () => {
    const app = files("src/app").filter((f) => /\.(ts|tsx)$/.test(f));
    expect(app.length).toBeGreaterThan(50);
    const importers = app.filter((f) => /(from|import)\s*\(?\s*"[^"]*guest-checkout"/.test(read(f)));
    expect(importers).toEqual(["src/app/api/shop/checkout/route.ts"]);
    expect(read("src/app/api/shop/checkout/route.ts")).toMatch(/await accessForRequest\(request\)\) === "closed"/);
    // Only the transport may import the service.
    const services = files("src").filter((f) => f !== "src/modules/orders/guest-checkout.ts" && /from "[^"]*orders\/guest-checkout"/.test(read(f)));
    expect(services).toEqual(["src/api/guest-checkout.ts"]);
  });

  it("every shop page and Server Action checks access itself, and the customer-auth door is allowlisted and checked", () => {
    const shop = files("src/app/[lang]").filter((f) => /\/(page|actions)\.tsx?$/.test(f));
    expect(shop.length).toBeGreaterThanOrEqual(8);
    for (const f of shop) expect(read(f), f).toMatch(/await requireShop\(\)/);
    expect(read("src/app/[lang]/layout.tsx")).toMatch(/await requireShop\(\)/);
    const door = read("src/app/_shop/customer-auth-handler.ts");
    expect(door).toMatch(/CUSTOMER_AUTH_ROUTES/);
    expect(door).toMatch(/await accessForRequest\(request\)\) === "closed"\) return notFound\(\)/);
    for (const f of ["src/app/api/customer-auth/[...all]/route.ts", "src/app/api/auth/callback/google/route.ts"]) expect(read(f), f).toMatch(/customerAuthResponse/);
  });

  it("founder acceptance has no switch: no environment variable, query parameter or header opens it", () => {
    const source = read("src/modules/launch/acceptance.ts");
    expect(source).not.toMatch(/process\.env|searchParams|headers\.get/);
  });

  it("the JSON public catalogue transport stays unrouted (the shop pages read the same scope directly)", () => {
    const app = files("src/app").filter((f) => /\.(ts|tsx)$/.test(f));
    const offenders = app.filter((f) => /from "[^"]*(api\/public-catalogue|storefront\/public-catalogue)"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
    // Only the transport (itself unrouted) uses the service.
    const importers = files("src").filter((f) => f !== "src/modules/storefront/public-catalogue.ts" && /from "[^"]*storefront\/public-catalogue"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(importers).toEqual(["src/api/public-catalogue.ts"]);
  });

  it("only the gated photo route imports the public photo transport, and nothing outside the transport imports the lookup", () => {
    const app = files("src/app").filter((f) => /\.(ts|tsx)$/.test(f));
    const offenders = app.filter((f) => /from "[^"]*(api\/public-media|media\/public)"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual(["src/app/api/public/media/[mediaId]/route.ts"]);
    const importers = files("src").filter((f) => f !== "src/modules/media/public.ts" && /from "[^"]*media\/public"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(importers).toEqual(["src/api/public-media.ts"]);
  });

  it("no secret can reach the browser: no NEXT_PUBLIC_ setting, no env block in the Next.js config, and a client component imports nothing at run time from server modules", () => {
    const sources = files("src").filter((f) => /\.(ts|tsx|mts)$/.test(f));
    expect(sources.filter((f) => /NEXT_PUBLIC_/.test(readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
    const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(config).not.toMatch(/NEXT_PUBLIC_|publicRuntimeConfig|\benv\s*:/);
    // Only `import type` (erased at build time) may reach a server module from a "use client" file.
    const clients = sources.filter((f) => /^\s*["']use client["']/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(clients.length).toBeGreaterThan(5);
    const runtimeImports = clients.flatMap((f) =>
      [...readFileSync(path.join(ROOT, f), "utf8").matchAll(/^import (?!type )[^;]*from "@\/(db|config|api|modules\/(?!storefront\/)[^"]*)"/gm)].map((m) => `${f}: ${m[0].slice(0, 80)}`),
    );
    expect(runtimeImports).toEqual([]);
  });

  it("no code trusts a client-supplied address header; only rate-limit/client.ts names Netlify's own, behind TRUSTED_PROXY", () => {
    const readers = files("src").filter((f) => /.(ts|tsx|mts)$/.test(f) && /x-forwarded|x-real-ip|cf-connecting-ip|true-client-ip|forwarded/i.test(read(f)));
    expect(readers).toEqual([]);
    const netlify = files("src").filter((f) => /.(ts|tsx|mts)$/.test(f) && /x-nf-client-connection-ip/i.test(read(f)));
    expect(netlify).toEqual(["src/modules/rate-limit/client.ts"]);
  });

  it("the guest service cannot reach the authentication module or the Owner operations", () => {
    const source = readFileSync(path.join(ROOT, "src/modules/orders/guest-checkout.ts"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((i) => /auth|principal|operations|actor/.test(i))).toEqual([]);
  });

  it("the anonymous endpoints are tracking, the probes, the maintenance call, and the shop's gated routes; public pages are the status page, tracking and the gated shop", () => {
    const app = files("src/app");
    const routes = app.filter((f) => /\/route\.ts$/.test(f) && !f.startsWith("src/app/office/") && !f.startsWith("src/app/api/v1/") && !(f.startsWith("src/app/api/auth/") && f !== "src/app/api/auth/callback/google/route.ts"));
    expect(routes.sort()).toEqual([
      "src/app/api/auth/callback/google/route.ts",
      "src/app/api/customer-auth/[...all]/route.ts",
      "src/app/api/health/live/route.ts",
      "src/app/api/health/ready/route.ts",
      "src/app/api/internal/maintenance/route.ts",
      "src/app/api/public/media/[mediaId]/route.ts",
      "src/app/api/shop/checkout/route.ts",
      "src/app/api/track/cancel/route.ts",
      "src/app/api/track/route.ts",
    ]);
    const pages = app.filter((f) => /\/page\.tsx$/.test(f) && !f.startsWith("src/app/office/") && !f.startsWith("src/app/[lang]/"));
    expect(pages.sort()).toEqual(["src/app/page.tsx", "src/app/track/page.tsx"]);
    // Server Actions outside the Office: the shop's, which only read and check shop access themselves.
    const actions = app.filter((f) => !f.startsWith("src/app/office/") && /^\s*["']use server["']/m.test(read(f)));
    expect(actions).toEqual(["src/app/[lang]/actions.ts"]);
  });
});
