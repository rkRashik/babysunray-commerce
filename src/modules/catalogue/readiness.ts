import { languages } from "./content";

// Publishing readiness: a read-only, advisory checklist for the Owner. It never publishes anything and is not
// an approval to publish: the publication rule (requirement I-6) is proposed, not approved, and no publish
// action exists. Each item says what it rests on:
//   approved    - a founder-stated or founder-approved requirement (cited);
//   pending     - a proposed requirement still waiting for the founder's decision (cited);
//   recommended - an engineering suggestion for quality; never a rule.

export type ReadinessBasis = "approved" | "pending" | "recommended";
export type ReadinessItem = { id: string; basis: ReadinessBasis; met: boolean; source: string; label: string; detail: string };

export type ReadinessInput = {
  nameEn: string | null;
  nameBn: string | null;
  descriptionEn: string | null;
  descriptionBn: string | null;
  fabricEn: string | null;
  fabricBn: string | null;
  fabricConfirmedAt: Date | null;
  careEn: string | null;
  careBn: string | null;
  categoryId: string | null;
  variants: { size: string | null; status: "active" | "inactive" }[];
  measurements: { size: string }[];
  media: { altEn: string | null; altBn: string | null }[];
};

const missingLanguages = (en: string | null, bn: string | null) => {
  const has = languages(en, bn);
  return [has.en ? null : "English", has.bn ? null : "Bangla"].filter(Boolean).join(" and ");
};

function bilingual(id: string, basis: ReadinessBasis, source: string, label: string, en: string | null, bn: string | null): ReadinessItem {
  const missing = missingLanguages(en, bn);
  return { id, basis, source, label, met: missing === "", detail: missing ? `Missing: ${missing}.` : "Both languages present." };
}

export function evaluateReadiness(p: ReadinessInput): ReadinessItem[] {
  const active = p.variants.filter((v) => v.status === "active");
  const sizes = [...new Set(active.map((v) => v.size).filter((s): s is string => s !== null))];
  const measured = new Set(p.measurements.map((m) => m.size));
  const unmeasured = sizes.filter((s) => !measured.has(s));
  const fabricMissing = missingLanguages(p.fabricEn, p.fabricBn);
  const unsized = active.filter((v) => v.size === null).length;
  const altMissing = p.media.filter((m) => missingLanguages(m.altEn, m.altBn) !== "").length;

  return [
    bilingual("name", "approved", "S-1", "Product name in English and Bangla", p.nameEn, p.nameBn),
    bilingual("description", "approved", "S-1", "Description in English and Bangla", p.descriptionEn, p.descriptionBn),
    {
      id: "variant",
      basis: "approved",
      source: "I-9, I-10",
      label: "At least one active SKU with a price",
      met: active.length > 0,
      detail: active.length > 0 ? `${active.length} active SKU(s), each with its own price.` : "No active SKU.",
    },
    {
      id: "measurements",
      basis: "pending",
      source: "I-6, S-6",
      label: "Measurements in cm for every size on sale",
      met: sizes.length > 0 && unmeasured.length === 0,
      detail:
        sizes.length === 0 ? "No active SKU has a size yet." : unmeasured.length ? `No measurements for: ${unmeasured.join(", ")}.` : `All ${sizes.length} size(s) measured.`,
    },
    {
      id: "fabric",
      basis: "pending",
      source: "I-6, S-6, S-11",
      label: "Fabric statement in English and Bangla, confirmed by you",
      met: fabricMissing === "" && p.fabricConfirmedAt !== null,
      detail: fabricMissing ? `Missing: ${fabricMissing}.` : p.fabricConfirmedAt ? "Entered and confirmed." : "Entered but not confirmed: confirm it only with evidence (label, supplier).",
    },
    bilingual("care", "pending", "S-6", "Care instructions in English and Bangla", p.careEn, p.careBn),
    {
      id: "policies",
      basis: "pending",
      source: "S-6, S-17, G-7",
      label: "Delivery and return explanation",
      met: false,
      detail: "Needs the founder-approved, published delivery and return/exchange policies, which do not exist yet.",
    },
    {
      id: "sizes",
      basis: "recommended",
      source: "engineering",
      label: "Every active SKU has a size",
      met: active.length > 0 && unsized === 0,
      detail: unsized ? `${unsized} active SKU(s) without a size.` : active.length ? "All have a size." : "No active SKU.",
    },
    { id: "category", basis: "recommended", source: "engineering", label: "Category chosen", met: p.categoryId !== null, detail: p.categoryId ? "Chosen." : "No category." },
    {
      id: "photo",
      basis: "recommended",
      source: "engineering (I-5 open)",
      label: "At least one photo",
      met: p.media.length > 0,
      detail: p.media.length ? `${p.media.length} photo(s).` : "No photo. How many photos a product needs is not decided.",
    },
    {
      id: "alt",
      basis: "recommended",
      source: "engineering (S-13)",
      label: "Every photo described in English and Bangla (alt text)",
      met: p.media.length > 0 && altMissing === 0,
      detail: p.media.length === 0 ? "No photo." : altMissing ? `${altMissing} photo(s) without both descriptions.` : "All described.",
    },
  ];
}
