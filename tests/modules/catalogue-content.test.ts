import { describe, expect, it } from "vitest";
import { productMeasurements } from "../../src/db/schema";
import { formatCentimetres, languages, MEASUREMENT_POINTS, parseCentimetres, validateMeasurements } from "../../src/modules/catalogue/content";
import { evaluateReadiness, type ReadinessInput } from "../../src/modules/catalogue/readiness";
import { sniffImage } from "../../src/modules/media/images";

describe("measurements in centimetres, stored as whole millimetres", () => {
  it("parses one decimal at most, with a comma or Bangla digits, exactly", () => {
    expect(parseCentimetres("42")).toBe(420);
    expect(parseCentimetres(" 42.5 ")).toBe(425);
    expect(parseCentimetres("42,5")).toBe(425);
    expect(parseCentimetres("৪২.৫")).toBe(425);
    expect(parseCentimetres("0.1")).toBe(1);
    expect(parseCentimetres("300")).toBe(3000);
    for (const bad of ["", "0", "0.0", "42.55", "-3", "1e2", "300.1", "abc", "42 cm", "4 2"]) expect(() => parseCentimetres(bad), bad).toThrow();
  });

  it("formats exactly, without rounding, in English or Bangla digits", () => {
    expect(formatCentimetres(420)).toBe("42");
    expect(formatCentimetres(425)).toBe("42.5");
    expect(formatCentimetres(1)).toBe("0.1");
    expect(formatCentimetres(425, "bn")).toBe("৪২.৫");
    for (const mm of [1, 9, 10, 425, 999, 3000]) expect(parseCentimetres(formatCentimetres(mm))).toBe(mm);
  });

  it("keeps the measuring points equal to the database check", () => {
    expect(productMeasurements.point.enumValues).toEqual([...MEASUREMENT_POINTS]);
  });

  it("validates a size chart: known points, one value per size and point, sensible bounds", () => {
    expect(validateMeasurements([{ size: " 0-3M ", point: "chest", valueMm: 420 }])).toEqual([{ size: "0-3M", point: "chest", valueMm: 420 }]);
    expect(validateMeasurements([])).toEqual([]);
    expect(() => validateMeasurements([{ size: "0-3M", point: "neck", valueMm: 300 }])).toThrow(/point/);
    expect(() => validateMeasurements([{ size: "", point: "chest", valueMm: 300 }])).toThrow(/size/);
    expect(() => validateMeasurements([{ size: "0-3M", point: "chest", valueMm: 0 }])).toThrow(/valueMm/);
    expect(() => validateMeasurements([{ size: "0-3M", point: "chest", valueMm: 1.5 }])).toThrow(/valueMm/);
    expect(() => validateMeasurements([{ size: "0-3M", point: "chest", valueMm: 300 }, { size: "0-3M", point: "chest", valueMm: 310 }])).toThrow(/twice/);
    const many = Array.from({ length: 31 }, (_, i) => ({ size: `S${i}`, point: "chest", valueMm: 300 }));
    expect(() => validateMeasurements(many)).toThrow(/30 sizes/);
  });

  it("reports which languages a field has", () => {
    expect(languages("Soft", null)).toEqual({ en: true, bn: false });
    expect(languages("  ", "নরম")).toEqual({ en: false, bn: true });
  });
});

describe("publishing readiness (advisory, never a publish action)", () => {
  const complete: ReadinessInput = {
    nameEn: "Soft Romper",
    nameBn: "নরম রম্পার",
    descriptionEn: "A fictional romper.",
    descriptionBn: "একটি কাল্পনিক রম্পার।",
    fabricEn: "Fictional fabric statement",
    fabricBn: "কাল্পনিক কাপড়ের বিবরণ",
    fabricConfirmedAt: new Date("2026-11-15T00:00:00Z"),
    careEn: "Fictional care text",
    careBn: "কাল্পনিক যত্নের নির্দেশনা",
    categoryId: "3f8a6c1e-2b4d-4e6f-8a1b-2c3d4e5f6a7b",
    variants: [{ size: "0-3M", status: "active" }, { size: "3-6M", status: "active" }, { size: null, status: "inactive" }],
    measurements: [{ size: "0-3M" }, { size: "3-6M" }],
    media: [{ altEn: "Front view", altBn: "সামনের দিক" }],
  };
  const state = (input: ReadinessInput) => Object.fromEntries(evaluateReadiness(input).map((i) => [i.id, i.met]));

  it("separates approved rules, pending founder decisions and recommendations, and cites each", () => {
    const items = evaluateReadiness(complete);
    expect(items.filter((i) => i.basis === "approved").map((i) => i.id)).toEqual(["name", "description", "variant"]);
    expect(items.filter((i) => i.basis === "pending").map((i) => i.id)).toEqual(["measurements", "fabric", "care", "policies"]);
    expect(items.filter((i) => i.basis === "recommended").map((i) => i.id)).toEqual(["sizes", "category", "photo", "alt"]);
    for (const item of items) expect(item.source.length).toBeGreaterThan(0);
    // Everything entered: only the store-wide policies remain, because they are not approved and published.
    expect(items.filter((i) => !i.met).map((i) => i.id)).toEqual(["policies"]);
  });

  it("flags a missing language, an unmeasured size, an unconfirmed fabric statement and undescribed photos", () => {
    expect(state({ ...complete, nameBn: null })).toMatchObject({ name: false });
    expect(evaluateReadiness({ ...complete, descriptionEn: " " }).find((i) => i.id === "description")?.detail).toBe("Missing: English.");
    expect(evaluateReadiness({ ...complete, measurements: [{ size: "0-3M" }] }).find((i) => i.id === "measurements")?.detail).toBe("No measurements for: 3-6M.");
    expect(state({ ...complete, fabricConfirmedAt: null })).toMatchObject({ fabric: false });
    expect(state({ ...complete, media: [{ altEn: "Front", altBn: null }] })).toMatchObject({ alt: false, photo: true });
    // No photo is a recommendation only: the number of photos a product needs is not decided (I-5).
    const noPhoto = evaluateReadiness({ ...complete, media: [] }).find((i) => i.id === "photo");
    expect(noPhoto).toMatchObject({ met: false, basis: "recommended" });
    expect(state({ ...complete, variants: [{ size: "0-3M", status: "inactive" }] })).toMatchObject({ variant: false, measurements: false });
  });
});

describe("image type from content", () => {
  it("recognises JPEG, PNG and WebP by their bytes only", () => {
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImage(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("webp");
    for (const other of ["<svg xmlns='http://www.w3.org/2000/svg'/>", "<!doctype html><script>", "GIF89a", "MZ\u0090\u0000", "%PDF-1.7", ""]) {
      expect(sniffImage(Buffer.from(other)), other).toBeNull();
    }
  });
});
