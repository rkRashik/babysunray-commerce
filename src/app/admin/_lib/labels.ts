import type { MeasurementPoint } from "@/modules/catalogue/content";

// Admin (English) names of the measuring points. The storefront preview has its own bilingual names.
export const MEASUREMENT_LABELS: Record<MeasurementPoint, string> = {
  chest: "Chest",
  waist: "Waist",
  hip: "Hip",
  length: "Length",
  shoulder: "Shoulder",
  sleeve: "Sleeve",
  inseam: "Inseam",
  foot: "Foot length",
};
