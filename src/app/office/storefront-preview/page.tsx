import { OfficeShell, Section } from "../_components/shell";
import { requireOffice } from "../_lib/session";
import { chooseConceptAction } from "./actions";
import { type Concept, previewConcept } from "./_components/concept";

export const metadata = { title: "Storefront preview · Owner Office" };

// The entry to the private storefront preview: the two design concepts side by side in words, and a way to open
// either in English or Bangla (Gate H.27). Both are prototypes for the founder's review, not approved designs.

const CONCEPTS: { id: Concept; title: string; points: string[] }[] = [
  {
    id: "editorial",
    title: "Concept A · Editorial Boutique",
    points: [
      "Calm, spacious pages led by product photography; square edges.",
      "An installed book serif for English headings and the shop name; Bangla keeps its own script font.",
      "Home: the shop name set large with a fine amber rule; categories as a quiet index; the first featured product shown at double size.",
      "Product tiles: tall photo, name, price and stock in small text.",
    ],
  },
  {
    id: "family",
    title: "Concept B · Modern Family Shop",
    points: [
      "Faster browsing: search and category chips first, filters open on the product list.",
      "Cards with a square photo, a bold price, a stock badge and a visible \"See options\" cue; rounded controls.",
      "On a phone: search stays outside the menu, and Add to cart stays at the bottom of the screen until the buying panel is reached.",
      "Bold sans-serif headings throughout.",
    ],
  },
];

export default async function PreviewIndex() {
  await requireOffice("storefront:preview");
  const current = await previewConcept();
  return (
    <OfficeShell title="Storefront preview" current="preview">
      <p className="text-sm text-gray-700">
        Two design concepts for you to compare. Neither is an approved design (BR-6), and no customer can see either. Both show the same draft products, prices, stock, delivery charges, cart (kept in this
        browser) and checkout simulation, from the same services; only layout and styling differ. Colours are the approved logo colours used as a reference. The choice applies to this browser; switch at any
        time with the buttons in the preview&apos;s top banner.
      </p>
      <div className="grid gap-6 md:grid-cols-2">
        {CONCEPTS.map((c) => (
          <Section key={c.id} title={c.title}>
            {current === c.id ? <p className="text-sm font-semibold">Currently shown in this browser.</p> : null}
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {c.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              {(["en", "bn"] as const).map((lang) => (
                <form key={lang} action={chooseConceptAction}>
                  <input type="hidden" name="concept" value={c.id} />
                  <input type="hidden" name="returnTo" value={`/office/storefront-preview/${lang}`} />
                  <button type="submit" aria-describedby={`section-${c.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="rounded border border-gray-400 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900" data-testid={`open-${c.id}-${lang}`}>
                    {lang === "en" ? "Open in English" : <span lang="bn">বাংলায় খুলুন</span>}
                  </button>
                </form>
              ))}
            </div>
          </Section>
        ))}
      </div>
    </OfficeShell>
  );
}
