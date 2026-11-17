import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type LaunchFacts, type PolicyState, publicCheckoutGate } from "../../src/modules/launch/gate";

// The storewide activation barrier and the structural guarantees around the inactive guest checkout (Gate H.26).

const STATES: PolicyState[] = ["empty", "drafted", "reviewed"];
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
          expect(gate.blockers.map((b) => b.id)).toEqual(expect.arrayContaining(["policies_not_published", "publication_rule", "abuse_protection", "hosting", "recovery_objectives", "transport"]));
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
  });

  it("has no switch: the module reads no environment, setting or database", () => {
    const source = readFileSync(path.join(ROOT, "src/modules/launch/gate.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|import\s/);
  });
});

describe("guest checkout is not reachable", () => {
  it("no page, layout, route or Server Action imports the guest checkout service or its transport", () => {
    const app = files("src/app").filter((f) => /\.(ts|tsx)$/.test(f));
    expect(app.length).toBeGreaterThan(50);
    const offenders = app.filter((f) => /(from|import)\s*\(?\s*"[^"]*guest-checkout"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
    // Only the transport (itself unrouted) may import the service.
    const importers = files("src").filter((f) => f !== "src/modules/orders/guest-checkout.ts" && /from "[^"]*orders\/guest-checkout"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(importers).toEqual(["src/api/guest-checkout.ts"]);
  });

  it("no page, layout, route or Server Action imports the public catalogue service or its transport", () => {
    const app = files("src/app").filter((f) => /\.(ts|tsx)$/.test(f));
    const offenders = app.filter((f) => /from "[^"]*(api\/public-catalogue|storefront\/public-catalogue)"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
    // Only the transport (itself unrouted) uses the service.
    const importers = files("src").filter((f) => f !== "src/modules/storefront/public-catalogue.ts" && /from "[^"]*storefront\/public-catalogue"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(importers).toEqual(["src/api/public-catalogue.ts"]);
  });

  it("only the closed photo route imports the public photo transport, and nothing outside the transport imports the lookup", () => {
    const app = files("src/app").filter((f) => /\.(ts|tsx)$/.test(f));
    const offenders = app.filter((f) => /from "[^"]*(api\/public-media|media\/public)"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual(["src/app/api/public/media/[mediaId]/route.ts"]);
    const importers = files("src").filter((f) => f !== "src/modules/media/public.ts" && /from "[^"]*media\/public"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(importers).toEqual(["src/api/public-media.ts"]);
  });

  it("the guest service cannot reach the authentication module or the Owner operations", () => {
    const source = readFileSync(path.join(ROOT, "src/modules/orders/guest-checkout.ts"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((i) => /auth|principal|operations|actor/.test(i))).toEqual([]);
  });

  it("the only anonymous endpoints are guest tracking, the two status probes, the secret-protected maintenance call and the closed photo route; the only public pages are the status page and tracking", () => {
    const app = files("src/app");
    const routes = app.filter((f) => /\/route\.ts$/.test(f) && !f.startsWith("src/app/office/") && !f.startsWith("src/app/api/v1/") && !f.startsWith("src/app/api/auth/"));
    // Gate H.44 added the probes (a status word only) and the maintenance call (404 unless MAINTENANCE_SECRET is set, then Bearer-only). Gate H.49 added the photo route, closed. No catalogue or checkout route.
    expect(routes.sort()).toEqual(["src/app/api/health/live/route.ts", "src/app/api/health/ready/route.ts", "src/app/api/internal/maintenance/route.ts", "src/app/api/public/media/[mediaId]/route.ts", "src/app/api/track/cancel/route.ts", "src/app/api/track/route.ts"]);
    const pages = app.filter((f) => /\/page\.tsx$/.test(f) && !f.startsWith("src/app/office/"));
    expect(pages.sort()).toEqual(["src/app/page.tsx", "src/app/track/page.tsx"]);
    // No Server Action module outside the Office (each Office action checks the Owner session itself).
    const actions = app.filter((f) => !f.startsWith("src/app/office/") && /^\s*["']use server["']/m.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(actions).toEqual([]);
  });
});
