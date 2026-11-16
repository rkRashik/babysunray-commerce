# Storefront preview

**Status:** Draft — Founder Review
**Purpose:** The private, bilingual prototype of the customer shop: what it shows, how it is protected, and what was tested.

A prototype of the customer shop at `/office/storefront-preview` (`src/app/office/storefront-preview`, `src/modules/storefront`). It shows **draft** products as customers might see them, so it is admin-only: every page, Server Action and photo checks the session and the `storefront:preview` permission on the server, and as an `/office` route it is never indexed, framed or cached. Labelled "Storefront Preview — Not Live" on every page. **It is not deployed and no customer can see it.** The visual design is not decided.

**Two design concepts:** the preview's start page describes Concept A (Editorial Boutique) and Concept B (Modern Family Shop) and opens either in English or Bangla; the banner switches between them on the same page (a cookie holding one word). Same products, prices, stock, cart and checkout simulation from the same services; only layout and styling differ. Details: [storefront-concepts.md](../design/storefront-concepts.md).

| Screen | Does |
|---|---|
| Home | The installation's name and optional description (`STORE_*` settings, [installation.md](../operations/installation.md), section 3), categories, featured and newest products. No slogan, review or stock photo. |
| Products | Search (English or Bangla name), category, size, colour and in-stock filters in the URL, 24 per page. |
| Product | Photo gallery (mouse, touch or arrow keys; a missing file shows "photo unavailable"), size choice with the product's own measurements in cm, colour (a colour missing in the chosen size is disabled and says so), quantity, per-SKU availability, description, a fabric statement only once confirmed, care, the size chart, configured delivery charges, other products of the same category, and "Back to results" with the same search and filters. |
| Cart | SKUs and quantities only, kept in this browser (localStorage), the same in both languages and after a reload. Every change re-reads prices, names, stock and the delivery charge from the database (`quoteCart`, integer paisa): a price change shows at once, a sold-out, deactivated, archived or unknown SKU is named and blocks checkout. Changes are announced to screen readers; a failed check offers "Check again". The cart is not a reservation. |
| Checkout | Three steps: guest details (name, Bangladesh mobile number in English or Bangla digits, address, delivery area), review, simulated summary ("received, waiting for verification"), with the cash-on-delivery total. **Simulation only** (`simulateCheckout`): the same validation an order gets, then nothing: no order, reservation, tracking link, payment, idempotency record, stock movement, message or log of the details. Browser tests count all of those tables before and after. A failure at the last step says the order was not placed. |

**Performance as built:** a product list page is four queries in one read-only snapshot whatever the number of products; a cart check is one query for its lines plus one for photos and one for zones. Pages use offset paging at 24 (keyset paging if the catalogue grows). Photos are served at 320, 640 or 1,280 pixels from `srcset` and revalidated with the ETag. Only the size picker, cart and checkout are client components; lists, product text and the menu are server-rendered (the phone menu is a native `<details>`). Measurements: [performance.md](../operations/performance.md).

**Accessibility as tested:** axe with the WCAG 2.0, 2.1 and 2.2 A and AA rules on home, list, product, cart and checkout in both languages and both concepts; keyboard choice of size and colour (radio buttons), a skip link and a visible 2 px focus ring; touch targets of at least 44 pixels on a phone; no transitions when reduced motion is asked; `lang="bn"` on Bangla content. No test with real people has been done.

Interface text is in `src/modules/storefront/i18n.ts` (English and Bangla, Bangla digits and BDT formatting without floating point). Product text is never translated or generated: a missing language shows the other language, marked with its `lang`. Public checkout stays disabled; there is no anonymous catalogue, order endpoint or publish action. A future public shop needs its own reads of published products only.
