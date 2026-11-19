import Link from "next/link";
import { AdminShell, Section } from "../_components/shell";
import { requireAdmin } from "../_lib/session";

export const metadata = { title: "Storefront preview · Admin" };

// The entry to the private storefront preview: the one storefront design (docs/design/storefront-design-system.md) and a
// way to open it in English or Bangla. It is not an approved final design (BR-6) and no customer can see it; the public shop
// stays closed by the launch gate.

const POINTS = [
  "First Light, the design chosen for implementation: an ivory ground, cocoa text and one amber action per screen; product photos in the arch (the logo's sunrise); the installation's own logo from public/brand/, or its name as text.",
  "Mobile first, designed at 360 to 430 px: a tab bar (Home, Shop, Search, Bag, My order) under the thumb on browsing pages, a buying bar on a product, a checkout bar in the bag; a desktop layout from 1024 px.",
  "Type: Fraunces and Figtree for English, Tiro Bangla and Hind Siliguri for Bangla (open licence, self-hosted; the Bangla files load only where Bangla appears). English and Bangla are always one tap apart.",
  "Components: Base UI sheets for search, filters and the size guide (swipe to close), an Embla photo gallery with swipe, Lucide icons, always with a word.",
  "Checkout: three steps (contact, delivery, review) and a confirmation, with the same checks an order would get; a simulation that records nothing.",
];

export default async function PreviewIndex() {
  await requireAdmin("storefront:preview");
  return (
    <AdminShell title="Storefront preview" current="preview">
      <p className="text-sm text-gray-700">
        A private preview of the storefront in the First Light design. No customer can see it, and it shows the same draft products, prices, stock, delivery charges, cart (kept in this browser) and checkout simulation as the services behind it.
      </p>
      <Section title="Storefront design">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {POINTS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/storefront-preview/en" className="of-btn of-btn-line" data-testid="open-en">
            Open in English
          </Link>
          <Link href="/admin/storefront-preview/bn" className="of-btn of-btn-line" data-testid="open-bn">
            <span lang="bn">বাংলায় খুলুন</span>
          </Link>
        </div>
      </Section>
    </AdminShell>
  );
}
