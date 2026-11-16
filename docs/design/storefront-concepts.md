# Storefront design concepts, wording review and customer sign-in options

**Status:** Draft — Founder Review
**Purpose:** What the two private storefront concepts are, how to compare them, which customer-facing words still need the founder's approval, and the options for customer accounts. Nothing here is an approved design or decision (BR-6, decision 4, S-14).

## 1. The two concepts

Both live in the Owner-only preview (`/office/storefront-preview`, permission `storefront:preview`). Open the page, read the two descriptions, and open either concept in English or Bangla; inside the preview, the buttons in the top banner switch concept on the same page. The choice is a cookie in this browser holding one word; it changes layout only.

| | Concept A · Editorial Boutique | Concept B · Modern Family Shop |
|---|---|---|
| Idea | Calm, spacious, photography first | Fast browsing, clear shopping cues |
| Type | An installed book serif (Iowan Old Style, Palatino or Georgia, whichever the device has) for English headings and the shop name; Bangla uses the installed Bangla font | Bold system sans-serif throughout |
| Home | Shop name set large with a fine amber rule; categories as a quiet index; the first featured product at double size | Search box and category chips first; product cards |
| Product tiles | Tall photo, name, price and stock in small text | Card with square photo, bold price, stock badge, "See options" cue |
| Product list | Filters folded away | Category chips above; filters open |
| Phone | Search inside the menu | Search outside the menu; Add to cart and its answer in a bar fixed to the bottom of the screen |
| Shape | Square edges | Rounded controls and cards, pill badges |

Shared, unchanged: the products, prices, stock, delivery charges, the cart (kept in this browser), the checkout simulation, the colour tokens (the approved logo colours as a reference, or the installation's own preview colours), contrast, focus ring, reduced-motion rules and every Owner-only check. No font, image or script is downloaded; product photos are the Owner's own, and products without a photo show a plain placeholder.

Tested (`npm run test:e2e`, storefront and mobile specs): both concepts show the same product, price and cart; switching keeps the page and query; Concept B's home, list, product, cart and checkout pass axe (WCAG 2.0 to 2.2 A and AA rules) in both languages; its phone layout has no sideways scrolling and keeps Add to cart and its answer on screen; its checkout simulation records nothing. Not tested: any test with real people (G-9), print, older browsers, a screen reader by a person.

What to judge: which direction suits the brand (S-2: premium, restrained, editorial, warm, not a template), how each feels with real product photos on a mid-range Android phone, and whether parts of one belong in the other. A final design (colours, typography, layout) is the founder's decision.

## 2. Customer-facing wording that needs approval

Interface text is in `src/modules/storefront/i18n.ts` (English and Bangla). It invents no claim, review, discount, delivery time or testimonial. These statements are still drafts and need the founder's approval before any customer sees them:

1. "After you place an order it is received, not yet confirmed. The shop contacts you by phone, Messenger or WhatsApp to verify it, and only then is it confirmed." (S-8; the rule is approved, the words are not.)
2. "Pay the total in cash on delivery." and "Total to pay on delivery" (S-4).
3. "The delivery charge is added to your order before you place it." (S-7.)
4. "The cart is not a reservation: stock is held only when an order is placed." (Rule A.)
5. Stock labels: "In stock", "Some sizes sold out", "Sold out", "Only N available".
6. "The order was not placed and nothing was recorded. Check your connection and try again, or contact the shop." (S-12; added in this batch.) Which contact route is shown is open.
7. The phone hint's example number (01712 345678) follows a common pattern and could belong to a real person; a clearly fictional example may be better.
8. Bangla terms: "ক্যাশ অন ডেলিভারি" (transliterated) and "ডেলিভারির সময় মোট দিতে হবে" (changed in this batch from "মোট পরিশোধ", which read as a fragment); the English status name "Pending Verification" was removed from the Bangla simulation text.
9. The tracking page's texts (`src/app/track`), which customers would see with their link.

Not written and not to be invented: delivery times, refund timelines beyond rule M, exchange terms, any legal text (policy drafts are in the Owner Office, [launch-readiness.md](../operations/launch-readiness.md) section 3).

## 3. Customer sign-in: options (proposal only)

S-3 requires guest checkout; S-14 leaves accounts undecided. Nothing below is built: no OAuth credentials, customer sign-up, OTP, profile or order history exists, and Better Auth's public sign-up stays disabled.

| Option | What it gives | Costs and risks |
|---|---|---|
| Guest checkout only (built, inactive) | No account; a private tracking link per order | Lost link: the Owner issues a new one. No order history across orders. |
| Google sign-in (OAuth) | One tap for customers with Google; Better Auth supports it | A Google Cloud project and OAuth client (an external account, founder approval); a consent screen and privacy text naming Google; customers without Google still need guest checkout. |
| Email and password | Works everywhere; Better Auth already used for the Owner | Opening sign-up for customers, keeping them apart from Owner permissions, and recovery by email (needs an email service). Many customers rarely use email. |
| Passkeys | No password; phishing-resistant | Device support varies on older Android phones; recovery still needs another factor. |
| Bangladesh phone number with a one-time code | Matches how customers identify themselves | SMS or WhatsApp codes cost money per message (C-1 is BDT 0; S-9 forbids a required paid SMS dependency) and need a provider account. |

Engineering view for the founder's decision: whichever is chosen, guest checkout stays; accounts should be a separate customer population with no Owner permission, and order history should come from orders linked to a verified account, never from a phone number alone (rule K).
