# Storefront design concepts, wording review and customer sign-in options

**Status:** Draft — Founder Review
**Purpose:** What the private storefront concepts are, the recommended direction and its design system, which customer-facing words still need the founder's approval, and the options for customer accounts. Nothing here is an approved design or decision (BR-6, decision 4, S-14). The decisions themselves are collected in [storefront-launch-decisions.md](../product/storefront-launch-decisions.md).

## 1. The concepts

All live in the Owner-only preview (`/office/storefront-preview`, permission `storefront:preview`). Open the page, read the descriptions, and open any concept in English or Bangla; inside the preview, the buttons in the top banner switch concept on the same page (on a phone they show only the letter). The choice is a cookie in this browser holding one word; it changes layout only.

| | Concept A · Editorial Boutique | Concept B · Modern Family Shop | Concept C · Hybrid (proposed, Gate H.30) |
|---|---|---|---|
| Idea | Calm, spacious, photography first | Fast browsing, clear shopping cues | A's look with B's speed |
| Type | An installed book serif (Iowan Old Style, Palatino or Georgia, whichever the device has) for English headings and the shop name; Bangla uses the installed Bangla font | Bold system sans-serif throughout | As A |
| Home | Shop name set large with a fine amber rule; categories as a quiet index; the first featured product at double size | Search box and category chips first; product cards | A's name and rule, then a large search box and category chips, then products |
| Product tiles | Tall photo, name, price and stock in small text | Card with square photo, bold price, stock badge, "See options" cue | Tall photo, name in the display face, bold price, stock badge |
| Product list | Filters folded away | Category chips above; filters open | Category chips above; filters folded away |
| Phone | Search inside the menu | Search outside the menu; Add to cart and its answer in a bar fixed to the bottom of the screen | As B |
| Shape | Square edges | Rounded controls and cards, pill badges | Middle radius on controls and cards, pill badges |

In every concept since Gate H.30: the product page shows the configured delivery charges and "cash on delivery" beside the buying panel; the checkout steps are numbered markers; the simulated confirmation shows where the order reference would appear and what happens next; loading shows the shape of the page instead of a line of text; breadcrumb links and the filter disclosure are at least 44 pixels tall.

Shared, unchanged: the products, prices, stock, delivery charges, the cart (kept in this browser), the checkout simulation, the colour tokens (the approved logo colours as a reference, or the installation's own preview colours), contrast, focus ring, reduced-motion rules and every Owner-only check. No font, image or script is downloaded; product photos are the Owner's own, and products without a photo show a plain placeholder.

Tested (`npm run test:e2e`, storefront and mobile specs): both concepts show the same product, price and cart; switching keeps the page and query; Concept B's home, list, product, cart and checkout pass axe (WCAG 2.0 to 2.2 A and AA rules) in both languages; its phone layout has no sideways scrolling and keeps Add to cart and its answer on screen; its checkout simulation records nothing. Not tested: any test with real people (G-9), print, older browsers, a screen reader by a person.

What to judge: which direction suits the brand (S-2: premium, restrained, editorial, warm, not a template), how each feels with real product photos on a mid-range Android phone, and whether parts of one belong in the other. A final design (colours, typography, layout) is the founder's decision.

## 2. Recommended direction: Concept C (a proposal)

**Why:** S-2 asks for premium, restrained, editorial and warm, and equal quality on a phone. Concept A carries the brand best but makes a phone shopper work harder (search hidden in the menu, Add to cart scrolls away). Concept B shops fastest but reads as a generic template, which S-2 rules out. C keeps A's typography, photography-led tiles and quiet colour, and takes from B only what shortens the path to buying: visible search, category chips, a clear price and stock badge, and Add to cart always within reach on a phone. Nothing in C depends on a decision that is still open; colours and fonts stay replaceable.

**Design system proposed with it** (prototype values, in `src/app/globals.css` and the components):

| Element | Proposal |
|---|---|
| Colour tokens | From the approved logo colours as a reference (BR-2): ink `#332923` (text, primary buttons), paper `#F9F6F1` (page), surface white (cards, inputs), sand `#E8D5BF` (photo placeholders, panels), line `#E3D7C8` (borders), umber `#6B5B4F` (secondary text), tan `#7A4E24` (links), danger `#9B2C2C` (errors, sold out). Amber `#C28B56` only as a background behind ink text or as decoration, never as text. |
| Contrast (WCAG) | Ink on paper 13.1:1, on white 14.2, on sand 9.9, on amber 4.8; umber on paper 6.0, on white 6.5; tan on paper 6.6; danger on paper 7.0. Amber on paper is 2.7:1, which is why it is never text. |
| Typography | English display text and headings: an installed book serif (Iowan Old Style, Palatino Linotype, Palatino, Book Antiqua, Georgia). Body, prices and controls: the system sans-serif. Bangla: installed Bangla fonts (Noto Sans Bengali, Nirmala UI, Vrinda, Shonar Bangla), line height 1.7, headings semi-bold. Body text at least 16 px; secondary text 14 px (12 px only for the measurements inside size chips and the step numbers); prices with tabular figures. No web font is downloaded. A brand typeface is a separate decision (BR-3). |
| Spacing | 4 px base unit (Tailwind scale); page gutter 16 px on a phone; sections 48 px apart; content width at most 1,152 px. |
| Shape | 8 px radius on cards and controls; pill badges and chips. |
| Components | Header (name, language, cart; search outside the menu on a phone); category chips; product tile (4:5 photo, name, price, stock badge); size chips with measurements; colour chips that say when a colour is missing in the chosen size; quantity stepper; delivery and payment panel; fixed buying bar on a phone; cart line; totals with delivery area; numbered checkout steps; confirmation with next steps. |
| Layout | Phone first: 2 product columns from 360 px, 3 from 640 px, 4 from 1,024 px; product page as photo and buying panel side by side from 768 px, the panel staying in view on a desktop. |
| Accessibility | WCAG 2.2 AA as the bar: every page passes axe in both languages; targets at least 44 × 44 px (S-13); a visible 2 px focus ring; skip link; field labels always visible; errors named per field and summarised; status messages announced; reduced motion respected; `lang="bn"` on Bangla text. |

**Measured (local production build, Concept C, cache cleared, 2026-11-16):** each page loads about 150 KB of compressed JavaScript (about 500 KB uncompressed), 8 KB of CSS and 6 to 10 KB of HTML in 22 to 24 requests; the storefront's own client code adds 3 to 5 KB on the product, cart and checkout pages, the rest is the framework. Photos come in the size the layout needs (320, 640 or 1,280 pixels). Not measured: a real mid-range Android phone on a mobile network, which is the test that matters before launch.

**Tested:** Concept C's home, list, product, cart and checkout pass axe in both languages with no console errors; on a 360 × 740 screen every page fits without sideways scrolling, every control in the header and main content is at least 44 pixels tall, Add to cart and its answer stay on screen, and the three-step checkout to the confirmation records nothing (`tests/e2e/storefront.spec.ts`, `tests/e2e/mobile.spec.ts`). The 44-pixel check found the product list's filter disclosure at 24 pixels; it was fixed.

## 3. Customer-facing wording that needs approval

Interface text is in `src/modules/storefront/i18n.ts` (English and Bangla). It invents no claim, review, discount, delivery time or testimonial. These statements are still drafts and need the founder's approval before any customer sees them:

1. "After you place an order it is received, not yet confirmed. The shop contacts you by phone, Messenger or WhatsApp to verify it, and only then is it confirmed." (S-8; the rule is approved, the words are not.)
2. "Pay the total in cash on delivery." and "Total to pay on delivery" (S-4).
3. "The delivery charge is added to your order before you place it." (S-7.)
4. "The cart is not a reservation: stock is held only when an order is placed." (Rule A.)
5. Stock labels: "In stock", "Some sizes sold out", "Sold out", "Only N available".
6. "The order was not placed and nothing was recorded. Check your connection and try again, or contact the shop." (S-12; added in Gate H.27.) Which contact route is shown is open.
7. The phone hint's example number (01712 345678) follows a common pattern and could belong to a real person; a clearly fictional example may be better.
8. Bangla terms: "ক্যাশ অন ডেলিভারি" (transliterated) and "ডেলিভারির সময় মোট দিতে হবে" (changed in Gate H.27 from "মোট পরিশোধ", which read as a fragment); the English status name "Pending Verification" was removed from the Bangla simulation text.
9. The tracking page's texts (`src/app/track`), which customers would see with their link.
10. The confirmation's next steps (Gate H.30): "The shop contacts you by phone, Messenger or WhatsApp to verify the order.", "Only after that is the order confirmed, packed and sent.", "You pay the total in cash when the parcel arrives.", and the private-link note. They restate rules B, H, K and S-4; the words are drafts.

Not written and not to be invented: delivery times, refund timelines beyond rule M, exchange terms, any legal text (policy drafts are in the Owner Office, [launch-readiness.md](../operations/launch-readiness.md) section 3).

## 4. Customer sign-in: options (proposal only)

S-3 requires guest checkout; S-14 leaves accounts undecided. Nothing below is built: no OAuth credentials, customer sign-up, OTP, profile or order history exists, and Better Auth's public sign-up stays disabled.

| Option | What it gives | Costs and risks |
|---|---|---|
| Guest checkout only (built, inactive) | No account; a private tracking link per order | Lost link: the Owner issues a new one. No order history across orders. |
| Google sign-in (OAuth) | One tap for customers with Google; Better Auth supports it | A Google Cloud project and OAuth client (an external account, founder approval); a consent screen and privacy text naming Google; customers without Google still need guest checkout. |
| Email and password | Works everywhere; Better Auth already used for the Owner | Opening sign-up for customers, keeping them apart from Owner permissions, and recovery by email (needs an email service). Many customers rarely use email. |
| Passkeys | No password; phishing-resistant | Device support varies on older Android phones; recovery still needs another factor. |
| Bangladesh phone number with a one-time code | Matches how customers identify themselves | SMS or WhatsApp codes cost money per message (C-1 is BDT 0; S-9 forbids a required paid SMS dependency) and need a provider account. |

Engineering view for the founder's decision: whichever is chosen, guest checkout stays; accounts should be a separate customer population with no Owner permission, and order history should come from orders linked to a verified account, never from a phone number alone (rule K).
