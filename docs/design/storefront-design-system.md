# First Light design system

**Status:** Draft — Founder Review. The visual direction, foundations, tokens, components, motion and accessibility rules of the storefront and BabySunRay Admin.

**First Light** is the design the founder chose for implementation on 2026-11-18, from a 14-board design proposal (brand, components, an interactive phone prototype, storefront and BabySunRay Admin screens). It replaces the earlier storefront design and Concept C, both rejected. It is implemented in the Owner-only storefront preview (`/admin/storefront-preview`), the guest tracking page (`/track`) and every BabySunRay Admin page. Nothing here is public: the launch gate stays closed, checkout is a simulation, and the requirement texts (BR-6, ADR-0001 open item 5) still read "not decided" until the founder updates them.

## 1. Direction

"Every screen should feel like a sunrise: quiet, then one clear warm thing to do next." Built for Bangladeshi families of every age and every level of phone confidence, on entry-level Android phones first.

- **Cocoa to read, amber to act, ivory to rest.** The approved logo colours (BR-2) are the base: Deep Cocoa for text, Muted Amber for the next step, Warm Ivory for the page.
- **Amber means go.** On a storefront screen one amber button is the next step (Add to Bag, Checkout, Continue, Place order). Ink is a strong second choice, outlined buttons are quiet. In the Admin, amber is the main action of a form or page.
- **Pictures before words.** Categories, sizes and steps come with a photo or an icon and a label in both languages; an icon never stands alone.
- **The arch is the signature.** The logo's sunrise arc is the frame of every product photo (4:5, the top fully rounded, the foot 22 px); the ray mark (arc and three rays, `src/app/_design/sun-mark.tsx`) appears only at good moments: the opening, an empty bag, the order received.
- **Bangla is designed, not translated.** Its own typefaces and line heights, Bangla digits and Taka, and a language switch (English | বাংলা) that is always visible.
- **No surprises.** The delivery charge before the order, "received, not yet confirmed" said plainly, prices re-checked in the bag, and an honest "not placed, nothing recorded" when the network fails (S-12).
- **No invented content.** Headings are navigation words or the installation's own line (`STORE_LINE_*`); the proposed line "Little Days. Warm Moments." (BR-5) is **not** used because it is not approved. Trust lines and steps restate approved order rules only. No reviews, discounts, delivery times or contact channels are invented.

## 2. Foundations and libraries

| Need | Choice | Why |
|---|---|---|
| Styling | Tailwind CSS 4 and First Light component classes in `src/app/globals.css`: `.sf-*` for the storefront, `.of-*` for the Admin | One token set for both products; utilities still override component classes. |
| Admin palette | Inside `.of`, Tailwind's neutral, red, amber, green and blue scales are remapped to First Light tones | Every Admin page (about 30) shares one palette without a class per page; status words and icons carry meaning, colour only groups. |
| Type | **Fraunces** (display, Latin), **Figtree** (text, Latin), **Tiro Bangla** (display, Bangla), **Hind Siliguri** 400 and 600 (text, Bangla), all SIL OFL 1.1, from the `@fontsource` packages 5.3, self-hosted with `next/font/local` (`src/app/_design/fonts.ts`) | A warm serif for moments and a clear sans for work, in both scripts. Each face covers only its script (unicode-range), so a page loads the Bangla files only where Bangla (or the taka sign) appears. Only Figtree (20 KB) is preloaded; Fraunces 66 KB, Tiro Bangla 82 KB, Hind Siliguri 71 + 75 KB load on demand. |
| Logo | The installation's own files in `public/brand/` (`logo.png`, `mark.png`), committed so a Git deployment ships them; without them the shop's name is shown as text (`src/app/_design/brand.tsx`) | BabySunray's files are the approved Direction A artwork (BR-1) with only its paper background removed: never redrawn or recoloured (BR-3). A copy for another business replaces them. A clean vector master is still needed (BR-4). |
| Sheets | **Base UI** `@base-ui/react` Drawer (MIT) | Focus trap and return, scroll lock, Escape, swipe to dismiss. |
| Gallery | **Embla Carousel** (MIT) | Touch swiping with snap; thumbnails, arrows and keys in sync. |
| Icons | **Lucide** (ISC) | One stroke icon set; always beside a word. |

## 3. Tokens

Colours (`@theme` in `globals.css`). An installation may replace ink, accent and paper (`STORE_THEME_*`, `src/config/installation.ts`), checked for contrast.

| Token | Value | Use | Contrast |
|---|---|---|---|
| `sf-ink` | `#332923` Deep Cocoa | Text, ink buttons, chosen chips | 13.1:1 on ivory |
| `sf-ink-2` | `#6b5b4f` | Secondary text | 6.0:1 on ivory |
| `sf-paper` | `#f9f6f1` Warm Ivory | Page | |
| `sf-card` | `#fffdf9` | Cards, fields, sheets | |
| `sf-sun` | `#c28b56` Muted Amber | The action colour, the current tab, the bag count | ink on it 4.8:1; never text on ivory (2.6:1) |
| `sf-sun-deep` | `#8a5524` | Amber as text or an icon | 5.7:1 on ivory |
| `sf-sun-soft` | `#f6e7d2` | Chosen options, notes, the opening field | ink on it 11.6:1 |
| `sf-peach`, `sf-butter`, `sf-sage`, `sf-sky`, `sf-blush`, `sf-oat` | garment tints | Grounds behind products and categories (always with ink text) | |
| `sf-line` / `sf-line-strong` | `#e6ddd1` / `#968878` | Dividers / field and chip outlines | outlines 3.2:1 on ivory |
| `sf-danger`, `sf-success`, `sf-warn`, `sf-info` (+ `-soft`) | `#a63a2b`, `#2f6b4f`, `#7a5200`, `#2e5a73` | Sold out and errors, in stock and done, low stock and waiting, information | 5.5, 5.3, 6.1 and 6.0:1 on their soft grounds |
| `of-night`, `of-night-2`, `of-canvas` | `#2a211c`, `#43362e`, `#f4efe8` | Admin sidebar, its current item, the Admin canvas | |

The ratios are calculated (WCAG formula); axe checks text contrast in the browser tests.

Type: storefront body 17 px (Figtree 400, Hind Siliguri in Bangla), labels and secondary text 14 to 15 px, nothing below 12 px. Headings in Fraunces 500 (Tiro Bangla 400 in Bangla) at 28 to 76 px; buttons, prices and form labels in the text face, prices tabular and never wrapped. Bangla is never letter-spaced and gets taller lines (1.65 body, 1.35 headings). The Admin uses Figtree and Hind Siliguri only.

Shape and space: pills for buttons, chips and steppers; 16 px corners for size and colour options, 20 px for cards, 28 px for sheets; the arch for photos. Touch targets at least 44 × 44 px (56 px for the main storefront buttons). Page gutter 16 px on a phone, 32 px on a desktop.

## 4. Components

Storefront (`src/app/admin/storefront-preview/_components/`): `header.tsx` and `header-client.tsx` (logo, language switch, desktop navigation and search, bag with a count that bumps when it grows, search sheet, and the phone tab bar: Home, Shop, Search, Bag, My order), `parts.tsx` (arch photo, product card with tint, grid and rail, section heading, trust lines, how to order, preview strip, footer), `gallery.tsx`, `variant-picker.tsx`, `cart-view.tsx`, `checkout-form.tsx`, `sheet.tsx`, `filter-sheet.tsx`, `no-photo.tsx`, `frame.tsx`. Shared: `src/app/_design/` (fonts, logo, ray mark).

Admin (`src/app/admin/_components/`): `shell.tsx` (cocoa sidebar grouped as Daily work, Catalogue, Money and records, then Shop and Settings, which fold (native `details`) unless the current page is in them; on a phone a bottom bar and a Menu of every page; a "Test database (staging)" notice on a staging-marked database; page title with actions; notices; `Section` cards), `action-form.tsx` (fields capped at a readable width, choices as pills, the amber submit, Cancel beside it inside an editable section), `editable-section.tsx` (a settings card that shows saved values as text until Edit; Cancel and leaving ask before typed changes are lost; used where settings are stable and rarely changed, not on operational forms such as orders, stock or variants), `file-picker.tsx` (the file input drawn as a drop area with the real input transparent over it, file name and size, an image preview and type and size checks before upload; a submit button that sends a plain upload form once), `content.tsx` (readiness checklist with progress); `orders/_components/labels.tsx` (status pills: amber waiting, green done, blue moving, red off the normal path, quiet otherwise; the four order dimensions side by side, never merged; order history in plain words).

Rules:

- **Choices** are radio buttons or checkboxes inside labels (size, colour, delivery area, filters) or links with `aria-current` (categories). Size and colour options are larger, and a chosen one is an ink outline on the sun wash. Sold out: dashed and struck through, still readable; a colour missing in the chosen size is disabled.
- **Delivery area** is a large choice card with a drawn radio, the area's name and its configured charge.
- **Product card:** arch photo on a tint, name, price; "Sold out" on the photo, "Some sizes sold out" under the price; without a photo, the tint with "No photo yet".
- **Checkout:** numbered steps (done in green with a tick, current in ink), errors per field with an icon and summarised at the top, a review card, then the confirmation with the ray mark, what happens next, and where the private tracking link would appear (a simulation records nothing).
- **Tracking:** a timeline of five milestones (received, confirmed, packed, on its way, delivered) with the current one in amber, then the items and the cash to pay; English and Bangla switch in the page (no URL change, the link token stays in memory only).
- **States:** skeletons with reserved space, empty catalogue, no results, empty bag, a problem per bag line that blocks checkout, a failed check with "Check again", and "the order was not placed" (S-12).

## 5. Motion

Only motion that answers an action, transform and opacity only: buttons and chips press to 97 % (120 ms); sheets slide (420 ms, `cubic-bezier(0.32, 0.72, 0, 1)`) and follow a swipe; pages and answers rise 14 px (320 ms); the bag count bumps when it grows; photos zoom 3 % on hover (desktop); the ray mark breathes three times at the opening and the confirmation; skeletons shimmer. With reduced motion every duration is zero.

## 6. Accessibility

WCAG 2.2 AA is the bar and axe checks every storefront page in both languages (`tests/e2e/storefront.spec.ts`, `tests/e2e/mobile.spec.ts`). A skip link comes first; every control shows a 2.5 px ink focus ring (light amber on dark surfaces); the language of each text is marked (`lang`); the language switch is a named group with the current language marked; sheets trap and return focus; icon-only controls are named; status is always a word, never colour alone. Not tested: a real screen reader, real phones, and people (G-9).

## 7. Photography and review screenshots

The design expects the Owner's own photos at 4:5, centred for the arch, on a plain ground, front, back and a detail (the number per product is launch decision I-5). A published product's photo comes from Cloudinary only when it has a recorded CDN copy ([ADR-0010](../adr/0010-hosting-and-image-delivery.md)); every other photo comes from the Owner-only media route.

Review screenshots of the storefront, the tracking page and the Admin, and a phone walkthrough video (opt-in, writes only outside the project, fictional data in `babysunray_test`):
`DESIGN_SHOTS_DIR=<folder> DESIGN_PHOTOS_DIR=<folder> npm run test:e2e -- tests/e2e/design-preview.spec.ts`. `DESIGN_PHOTOS_DIR` may hold demo images named `<photo>-1.jpg` and `<photo>-2.jpg`; they are stored as the fictional products' photos and described as demo photos, never as BabySunray products.
