import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVED_PUBLICATION_RULE, publicationBlockers } from "../../src/modules/catalogue/publication";
import { evaluateReadiness, type ReadinessInput } from "../../src/modules/catalogue/readiness";

const ROOT = path.resolve(import.meta.dirname, "../..");
const files = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(path.join(ROOT, rel)).isDirectory() ? files(rel) : [rel];
  });

const complete: ReadinessInput = {
  nameEn: "Romper",
  nameBn: "রম্পার",
  descriptionEn: "Fictional.",
  descriptionBn: "কাল্পনিক।",
  fabricEn: "Cotton (fictional).",
  fabricBn: "সুতি (কাল্পনিক)।",
  fabricConfirmedAt: new Date(),
  careEn: "Wash cold.",
  careBn: "ঠান্ডা পানিতে ধুন।",
  categoryId: "00000000-0000-4000-8000-000000000000",
  variants: [{ size: "0-3M", status: "active" }],
  measurements: [{ size: "0-3M" }],
  media: [{ altEn: "Front", altBn: "সামনে" }],
};
const rule = { id: "unit-test-rule", items: ["fabric", "photo"] } as const;

describe("publication rules", () => {
  it("no publication rule is approved (requirement I-6), so every product is blocked", () => {
    expect(APPROVED_PUBLICATION_RULE).toBeNull();
    expect(publicationBlockers({ status: "draft", items: evaluateReadiness(complete), reviewCurrent: true }, APPROVED_PUBLICATION_RULE)).toEqual(["no_approved_rule"]);
  });

  it("under a rule: a current review, a draft, the rule's items and always the founder-stated items", () => {
    expect(publicationBlockers({ status: "draft", items: evaluateReadiness(complete), reviewCurrent: true }, rule)).toEqual([]);
    expect(publicationBlockers({ status: "published", items: evaluateReadiness(complete), reviewCurrent: true }, rule)).toEqual(["not_draft"]);
    expect(publicationBlockers({ status: "archived", items: evaluateReadiness(complete), reviewCurrent: false }, rule)).toEqual(["not_draft", "review_not_current"]);
    const incomplete = evaluateReadiness({ ...complete, nameBn: null, fabricConfirmedAt: null, media: [] });
    expect(publicationBlockers({ status: "draft", items: incomplete, reviewCurrent: true }, rule)).toEqual(["item:name", "item:fabric", "item:photo"]);
    // An empty rule still requires the founder-stated items (names, descriptions, an active priced SKU).
    expect(publicationBlockers({ status: "draft", items: evaluateReadiness({ ...complete, variants: [] }), reviewCurrent: true }, { id: "empty", items: [] })).toEqual(["item:variant"]);
  });

  it("no page, route, Server Action or transport imports the publication services", () => {
    const reachable = [...files("src/app"), ...files("src/api")].filter((f) => /\.(ts|tsx)$/.test(f));
    expect(reachable.length).toBeGreaterThan(50);
    const offenders = reachable.filter((f) => /from "[^"]*catalogue\/publication"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
    // Only the launch overview reads it (for the approved rule, to flag an unexpected publication).
    const importers = files("src").filter((f) => f !== "src/modules/catalogue/publication.ts" && /from "[^"]*catalogue\/publication"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(importers).toEqual(["src/modules/launch/readiness.ts"]);
  });
});
