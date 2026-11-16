import "server-only";
import { cookies } from "next/headers";

// The two private design concepts of the storefront preview (Gate H.27), for the founder to compare. Neither is an
// approved design (BR-6, decision 4). Both render the same products, prices, stock, cart and checkout simulation
// from the same services; only layout and styling differ. The choice is a cookie on the preview's path holding
// one of two words, nothing else.

export const CONCEPTS = ["editorial", "family"] as const;
export type Concept = (typeof CONCEPTS)[number];
export const CONCEPT_COOKIE = "sf-concept";
export const isConcept = (value: unknown): value is Concept => value === "editorial" || value === "family";

/** The concept chosen in this browser; Concept A (editorial) until one is chosen. */
export async function previewConcept(): Promise<Concept> {
  const value = (await cookies()).get(CONCEPT_COOKIE)?.value;
  return isConcept(value) ? value : "editorial";
}
