# BabySunray: Product Requirements

**Status:** Draft — Founder Review (revision A.6)
**Purpose:** The single source of truth for what BabySunray's website and Owner Office must do. Technology choices live in [ADR-0001](../adr/0001-application-stack.md). Visual design is not specified here.
**Last updated:** 2026-11-15

## How to read this document

Each requirement carries a basis:

| Basis | Meaning |
|---|---|
| **F** | A business outcome or constraint stated by the founder (founder decisions as recorded in the briefs, or direct instruction). Binding. |
| **P** | Proposed by an advisor or AI review: a technical or operational method, or a business rule the founder has not yet approved. Not scope until the founder confirms it. |
| **F + P** | The outcome is founder-stated. The specific rule or method given is proposed. |
| **Q** | Open question. Do not implement. |

Labels were audited in revision A.1: items that came only from advisor text, or that are implementation details of a founder outcome, are marked **P** or **F + P**. Nothing here is approved merely because it is written down.
Revision A.2 records the founder's long-term outcomes (B-8 to B-13), adds API and reuse requirements (sections 2.3 and 2.4) and engineering expectations (section 9.1), and adds IDs I-9 to I-12, O-15, O-16, OF-9, OF-10 and G-11 to G-14. No existing ID, basis label or gate was changed.
Revision A.3 records the founder's Gate G.3 approval (14 Nov 2026) to implement the technical defaults in open decision 18 and Drizzle (decision 2), and closes decision 16. Approval to implement a **P** item does not turn it into **F**: basis labels are unchanged. Only the parts named in decision 18 are approved; the rest of each item keeps its status. What was built is recorded in [ADR-0002](../adr/0002-drizzle-and-inventory-foundation.md).
Revision A.4 records the founder's Gate G.3a technical defaults (SKU character set, strictly positive price, ASCII slugs, stock on inactive SKUs). Basis labels are unchanged.
Revision A.5 records the founder's Gate H.2 approval (15 Nov 2026) of the authentication solution (open decision 3) and of the versioned REST and OpenAPI direction (open decision 17). What was built is recorded in [ADR-0003](../adr/0003-authentication-foundation.md). Basis labels are unchanged; OF-5's recovery path and API-10's native-client credentials remain open.
Revision A.6 records batch H.2a + H.3 (15 Nov 2026): a read-only, Owner-only `/api/v1` with Bearer authentication and OpenAPI ([ADR-0004](../adr/0004-api-v1-and-bearer-transport.md)). Basis labels are unchanged.
Revision A.7 records batch H.4–H.6 (15 Nov 2026): operation-level idempotency for stock and draft-catalogue writes ([ADR-0005](../adr/0005-operation-idempotency.md); API-8 for these operations, not O-3, since orders do not exist), Owner-only write endpoints, request-size limits, a no-CORS policy and per-user API rate limits (API-11, [ADR-0004](../adr/0004-api-v1-and-bearer-transport.md)), and a first functional Owner Office for draft products, variants, stock receipts, adjustments and movement history (part of OF-1; README.md, Owner Office). The Office's screens are functional only; final UI design (decision 4) stays open. Basis labels are unchanged.
Revision A.8 records batch H.7–H.9 (15 Nov 2026): real-browser tests of the Owner Office; a local, operator-only Owner password reset (`npm run auth:reset-owner-password`), which is **not** the recovery path OF-5 asks for and leaves it open; editing of draft product text and of variant size, colour and price through the shared operations, `/api/v1` (PATCH) and the Office, with optimistic versions against stale overwrites; and Owner product search by slug, English or Bangla name and SKU with status filter and paging (part of I-12; order and stock listings do not exist or are not searchable yet). Three editing limits are technical defaults chosen in this batch, pending founder review rather than approved rules: archived products and their variants are not edited, inactive variants are not edited, and slug and SKU never change. Basis labels are unchanged.
Revision A.9 records the founder's approval of the order business rules (Gate H.10–H.12, 15 Nov 2026): reservation at submission, manual verification, cancellation by stage, 24-hour verification expiry, returns and exchanges, return shipping responsibility, RTO quarantine, order milestones, Owner-configured delivery zones, COD accounting, guest tracking, dispatch deduction, manual COD refunds and further defaults. The rules are reproduced in [order-policy-decisions.md](order-policy-decisions.md) with the states and engineering defaults derived from them. Rows that the founder decided now show the new basis with the old one in brackets (for example "F (was Q)") and a reference to the rule; the requirement text itself is unchanged. These rules authorise the internal Orders system only; public checkout still waits for S-17 and G-7.
Choices the founder has not made are collected in [section 12](#12-open-decisions) rather than guessed. Earlier AI recommendations (the discarded prototype, the earlier Cloudflare proposal) have **not** been promoted to F.

## 1. Business context

| ID | Requirement | Basis |
|---|---|---|
| B-1 | Brand: **BabySunray**. Domain `babysunray.com` is already owned. | F |
| B-2 | Initial business: Bangladesh-focused baby and kids clothing, online-first, social-led discovery, nationwide delivery managed from Dhaka. Accessories, essentials and toys may follow after validation. | F |
| B-3 | Single founder operates the business and maintains the platform personally. Staff may be added later; no partner, equity, investor or profit-distribution logic is authorised. | F |
| B-4 | Sales channels: the website, plus Facebook, Instagram, Messenger and WhatsApp. Orders taken on Messenger or WhatsApp must live in the same records as website orders. | F |
| B-5 | Business launch and website launch are separate. A website outage must not stop customer service or lose an order record. | F |
| B-6 | No fixed launch date. Readiness gates outrank dates. A December 2026 soft launch was a planning target for the business, not a commitment for the custom platform. | F |
| B-7 | The platform should be maintainable and portfolio-grade. Generic code is kept apart from BabySunray's assets and data, but multi-tenant SaaS is **not** in scope. | F |
| B-8 | BabySunray is a complete, production-minded e-commerce and business-operations system, delivered in phases (section 10). It is **not yet feature-complete**: no capability in B-13 is described as implemented until its code and tests exist. | F |
| B-9 | It is a real, working platform for the founder's own baby and kidswear business, not only a demonstration. | F |
| B-10 | It is also a portfolio-quality full-stack and backend engineering project (extends B-7). Quality is shown by working functionality, test coverage, recorded architecture decisions, security and reproducibility, not by the volume of documentation or by claims. | F |
| B-11 | **API-driven:** future web, Windows and Android clients can use the same backend capabilities as the website. Requirements: section 2.3. | F |
| B-12 | **Reusable and rebrandable:** a customised copy can be reused for, or sold to, a separate client business without leaking BabySunray's private data. Requirements: section 2.4. This is not multi-tenant SaaS (section 11). | F |

### 1.1 Intended scope of the finished system

| ID | Requirement | Basis |
|---|---|---|
| B-13 | Through phased delivery (section 10) the finished system includes the capabilities below. This states long-term completeness, **not launch scope** and not an implementation order. Each capability is defined by the requirements cited; where it cites an open item, that item stays open. | F |

| Capability | Defined in | Notes |
|---|---|---|
| Bilingual, responsive, product-first storefront | S-1, S-2 | Final visual design undecided (BR-6). |
| Product and SKU/variant management | I-1, I-9 to I-11 | |
| Secure guest cash-on-delivery checkout | S-3, S-4, S-17 | Public checkout waits for approved policies (G-7). |
| Website orders and manual Messenger/WhatsApp orders | B-4, S-5, O-2 | |
| Owner Office, with future Admin and Staff permissions | OF-1, OF-7, OF-10 | Staff roles are not built now (OF-7). |
| Inventory receipts, adjustments, stock history and reconciliation | I-2, I-3, I-8 | Reservation meaning follows O-9 to O-12. |
| Order, fulfilment, payment and return/refund lifecycles | O-1, section 4 | Values and transitions are not yet defined (O-9 to O-14). |
| Courier tracking, COD collection and settlement | S-9, OF-3, OF-8 | Courier-tracking scope and the settlement process are not yet defined. |
| Expenses, financial records and reporting | OF-1, OF-2, D-8 | No figures or KPIs are assumed. |
| Search, filters and pagination where appropriate | I-12, API-7 | Customer-facing search, accounts, wishlist and reviews remain undecided (S-14). |
| XLSX, CSV, JSON and printable reports | D-1 to D-10 | |
| Audit trails, backups and verified restore | OF-6, K-1 to K-10 | |
| Versioned APIs and maintainable technical documentation | section 2.3, EN-5 | |
| Automated tests for normal, failure and concurrent operations | section 9, EN-6 | |

## 2. Constraints

### 2.1 Budget

| ID | Requirement | Basis |
|---|---|---|
| C-1 | Default website infrastructure and software budget is **BDT 0**: no paid hosting, database, SMS, backup service, image service, commercial licence or subscription. | F |
| C-2 | No free trial, auto-converting plan, billing activation or card verification without separate founder approval. | F |
| C-3 | A Bangladesh-based hosting plan costing **less than BDT 1,500 per year** may be *evaluated* as an optional alternative. It must not be purchased without separate founder approval. | F |
| C-4 | The domain is already paid. Future domain renewal, courier fees and normal business costs are tracked separately from website infrastructure cost. | F |
| C-5 | Do not promise that the site will be free or reliable forever. Verify current terms and limits before relying on any free tier. | F |

### 2.2 Repository and data handling

| ID | Requirement | Basis |
|---|---|---|
| R-1 | Source is kept GitHub-ready. Visibility (private first, or public) is an open decision, see section 12. | F + Q |
| R-2 | Never commit: financial or source ZIPs, the Founder Fieldbook, customer personal data, database exports or backups, secrets, supplier or business contacts, internal review files. | F |
| R-3 | Documentation is short and human-readable. No generated filler. Dependencies are kept minimal. | F |

### 2.3 API-driven architecture

The founder requires the outcome in B-11. The approach below is **proposed** unless labelled otherwise; the technology side is recorded in [ADR-0001](../adr/0001-application-stack.md).

| ID | Requirement | Basis |
|---|---|---|
| API-1 | Pricing, stock, order and authorisation rules exist once, in shared server-side domain and application services. The website and every external API client use them; no client re-implements them. | F + P |
| API-2 | External clients use a versioned HTTP API served by the existing Next.js application. No separate backend server is added. The style (proposed: REST under a `/api/v1` prefix, implemented with Next.js Route Handlers) awaits approval. | P |
| API-3 | The website's own server-rendered pages and server actions call the shared services directly, not the application's own HTTP endpoints. | P |
| API-4 | The API contract is described in an OpenAPI document, public and authorised endpoints both, and checked against behaviour (G-12). | P |
| API-5 | Every endpoint validates and normalises input on the server, handles unexpected fields by an explicit and tested rule, and authenticates and authorises on the server. This extends OF-4 from Owner Office pages to every client. | P |
| API-6 | Errors use one structure with stable error codes. Responses never contain stack traces, SQL, secrets or customer personal data (S-10). | P |
| API-7 | List endpoints support pagination, filtering and a stable, deterministic sort. | P |
| API-8 | Retry-sensitive operations (order submission, O-3, and other operations that move stock or money) are idempotent over the API as well. | P |
| API-9 | A written versioning and compatibility policy exists before the first external client: what counts as a breaking change, and how versions are introduced and retired. | P |
| API-10 | Browser and native clients may use different credential and session strategies. The choice follows the authentication decision (OF-5) and a security review. | P + Q |
| API-11 | Request-size limits, rate limiting and a deliberate CORS policy are defined and tested. Structured technical logs are separate from the business audit log (OF-6) and contain no personal data. | P |
| API-12 | Exact endpoint paths, the authentication protocol for native clients, OpenAPI tooling and version numbering are design decisions for later gates. | Q |

### 2.4 Reuse and rebranding

The founder requires the outcome in B-12. The approach below is **proposed** unless labelled otherwise. It does not authorise multi-tenant SaaS (section 11).

| ID | Requirement | Basis |
|---|---|---|
| RU-1 | One reusable commerce codebase. Business identity (name, assets, contacts, policies, text) is configuration, kept apart from generic commerce logic and from BabySunray-specific branding (extends B-7). | F + P |
| RU-2 | Each client installation has its own database, secrets, file storage and deployment. | P |
| RU-3 | No BabySunray customer, supplier, financial or other private business data is copied into a client installation, its seed data, tests, documentation or repository history (see R-2). | F |
| RU-4 | Installation, configuration, migration, testing, backup and handover procedures are documented and can be reproduced from a clean checkout using fictional data. | P |
| RU-5 | Third-party licences (libraries, fonts, images, tools) are reviewed before redistribution or commercial handoff. | P |
| RU-6 | Reusing or selling a copy does not by itself authorise subscriptions, billing infrastructure, white-label dashboards or onboarding platforms. Commercial terms of any handoff are a founder decision. | F |

## 3. Customer experience

| ID | Requirement | Basis |
|---|---|---|
| S-1 | Full **Bangla and English** experience, including interface labels, policies, size information, address forms and order messages. Currency is BDT. | F |
| S-2 | Premium, restrained, editorial, warm and clean. Explicitly **not** a generic template look. Mobile quality equals desktop quality. | F |
| S-3 | **Guest checkout.** No account creation is forced. | F |
| S-4 | **Cash on delivery (COD)** at launch. Online payment is a later option, subject to merchant approval. *Proposed:* the site does not collect card numbers while on a free-tier host (see ADR-0001). | F + P |
| S-5 | Assisted ordering (founder enters an order taken on Messenger or WhatsApp) is supported. | F |
| S-6 | Product pages show sizes in **cm**, variant availability, fabric and care, and a delivery and return explanation. | P |
| S-7 | The delivery charge is shown before the customer submits the order. *Founder rule I (A.9), [order-policy-decisions.md](order-policy-decisions.md).* | F (was P) |
| S-8 | Checkout is short and labelled for first-time online buyers. After submission the order is shown as *received* and not as *confirmed* until verified. What verification means is a business rule (O-10). *Founder rule B (A.9): submission is Pending Verification. Checkout wording stays P.* | F + P (was P) |
| S-9 | Customers can follow an order privately without an account, using an opaque, randomly generated tracking link. Lookup by order number plus the last four phone digits is **not** acceptable. SMS one-time codes must not be a required paid dependency. *Founder rule K (A.9).* | F (was P) |
| S-10 | Public URLs, analytics and logs contain no customer personal data. | P |
| S-11 | Product claims, fabric statements and policies are never invented. Competitor product photos are not used. | F |
| S-12 | Loading, error and offline states are designed. If the order service is unavailable the site says the order was **not** recorded and offers a manual contact route. | P |
| S-13 | Accessibility: sufficient text contrast, visible focus, persistent field labels, large touch targets. | P |
| S-14 | **Search, customer accounts, wishlists and reviews: launch scope undecided.** They are neither included nor excluded until the founder decides. | Q |
| S-15 | A tracking link is a credential and is protected as one. It is long and random; it expires; the owner can revoke or regenerate it. It must not appear in analytics, server or access logs, error reports, or requests to third parties. The tracking page sends no referrer, loads no third-party scripts or embeds, is not cached or indexed, and shows only minimal, masked information. Lookups are rate-limited and failures return one generic message. *Founder rule K (A.9) applies these protections.* | F (was P) |
| S-16 | The tracking link's lifetime, and what happens to it after delivery, cancellation or return, are to be defined. *Founder rule N (A.9): links expire 30 days after the order is closed; the Owner can revoke or regenerate them earlier.* | F (was Q) |
| S-17 | **Public checkout is disabled until the founder has approved and published** the delivery, return/exchange and privacy policies, and any terms checkout depends on. Placeholder or "pending" text is not an acceptable public policy. Drafts may exist internally. | F |

## 4. Orders and fulfilment

Order data uses **separate** lifecycle dimensions. A change to one must not overwrite another.

| Dimension | Meaning | Values |
|---|---|---|
| Order status | Where the order stands as a commercial record | `pending_verification`, `verification_expired`, `confirmed`, `cancelled`, `closed` |
| Fulfilment status | Physical preparation and delivery | `unfulfilled`, `packed`, `dispatched`, `delivered`, `rto`, `rto_received` |
| Payment status | Money expected, collected and settled | `unpaid`, `partially_collected`, `collected`, `settled` (derived from recorded amounts) |
| Return / refund status | Returns, exchanges and refunds | `none`, `requested`, `in_progress`, `resolved` |

**Order source** (website, Messenger, WhatsApp, other) is an attribute of the order, **not** a lifecycle status.

| ID | Requirement | Basis |
|---|---|---|
| O-1 | The four lifecycle dimensions above are stored and displayed separately. Their allowed values and transitions are written once the business rules below are approved. *Values and transitions: [order-policy-decisions.md](order-policy-decisions.md), section 2 (A.9; Draft — Founder Review).* | F |
| O-2 | Order source is a separate attribute. | F |
| O-3 | Orders are submitted **idempotently**: repeating a submission with the same key creates one order. *Founder invariant (A.9).* | F (was P) |
| O-4 | Stock is checked and held consistently under the reservation rules (O-9 to O-12). No order exists in a state that contradicts those rules, and no hold exists without a corresponding order. | P |
| O-5 | Money is stored as integer minor units (paisa). Display uses BDT formatting. *Founder invariant (A.9).* | F (was P) |
| O-6 | Timestamps are stored unambiguously (UTC) and displayed in Asia/Dhaka. *Founder invariant (A.9).* | F (was P) |
| O-7 | Phone numbers and order identifiers are text, so leading zeros survive. Bangladesh mobile numbers are validated and normalised. *Founder invariant (A.9).* | F (was P) |
| O-8 | Delivery charges are configured by the owner, never hardcoded. How they depend on district or area is open. *Founder rule I (A.9): two Owner-configured zones, Dhaka City and Outside Dhaka; no amount approved; district-level rules still open.* | F + Q (was Q) |
| O-9 | **Reservation timing:** when stock is held for an order (at submission, at verification, at dispatch, or otherwise). *Founder rule A (A.9): reserve everything at submission, atomically; no backorders.* | F (was Q) |
| O-10 | **Pending-verification orders:** what verification is, who performs it, whether such orders hold stock, and how long they may wait. *Founder rule B (A.9): Owner verifies by hand; pending orders hold stock for 24 hours (rule D).* | F (was Q) |
| O-11 | **Cancellation:** who may cancel and when, and the effect on stock, payment and tracking. *Founder rule C (A.9).* | F (was Q) |
| O-12 | **Reservation release and expiry:** whether holds expire automatically or are released by hand, the time limits, and any notice to the customer. *Founder rule D (A.9): 24 elapsed hours, automatic release, Verification Expired — Owner Review, no auto-cancel.* | F (was Q) |
| O-13 | **Returns and exchanges:** eligibility, time window, condition requirements, refund method, and effect on stock. *Founder rules E, F and M (A.9). Exchange execution (replacement delivery charge, price difference) is still open.* | F + Q (was Q) |
| O-14 | **RTO (undelivered or refused parcels returned to the shop):** handling, cost recording, inspection and restock. *Founder rule G (A.9).* | F (was Q) |
| O-15 | Each order item stores the unit price, SKU and product and variant names as they were when the order was placed. Later price or catalogue changes never alter past orders. *Founder invariant (A.9).* | F (was P) |
| O-16 | If cancellation affects stock, the stock reversal happens exactly once, even under repeated or concurrent requests, and the whole operation rolls back on partial failure. Whether, when and how stock is reversed is defined by O-9 to O-12 and is not decided here. Cancellation is not modelled as one combined status that restocks automatically (O-1). *The Q part is decided by founder rules C and D (A.9).* | P (Q part decided) |

O-9 to O-14 were left to the founder. **Decided in Revision A.9** (founder instruction, Gate H.10–H.12, 15 Nov 2026): the rules are in [order-policy-decisions.md](order-policy-decisions.md), section 1; the states, transitions and engineering defaults derived from them are in sections 2 and 3 of that document (Draft — Founder Review). This document still proposes no amounts.

## 5. Catalogue and inventory

| ID | Requirement | Basis |
|---|---|---|
| I-1 | Products have variants and SKUs (for example size and colour) with stock per SKU. | F |
| I-2 | Stock is tracked as on hand, reserved and available, backed by an **append-only movement ledger**. The meaning of "reserved" follows O-9 to O-12. *Reserved stock at submission and its release, and the dispatch deduction, are founder rules A, D and L (A.9).* | P |
| I-3 | Every manual stock adjustment records a reason and who made it. | P |
| I-4 | Overselling is not allowed, including when several customers order the last unit at once and for multi-item carts. | P |
| I-5 | Product photos: how the owner adds and changes images depends on hosting (browser upload versus a local build and deploy step). Open. | Q |
| I-6 | A product cannot be published until bilingual text, cm measurements and an approved fabric statement exist. | P |
| I-7 | **Returned and RTO goods are inspected before they are sellable.** Goods awaiting inspection are held apart from sellable stock (quarantine) and enter sellable stock only through a recorded decision. The inspection criteria and outcomes are business rules (O-13, O-14). | P |
| I-8 | **Inventory reconciliation:** the owner can compare counted physical stock with system stock. Differences are recorded as reasoned ledger adjustments, never as silent edits. The counting routine and its frequency are to be defined. | P |
| I-9 | A product has one or more variants. Each variant is a sellable SKU with its own price and its own stock (extends I-1). Implementation approved by the founder (Gate G.3). | P |
| I-10 | SKUs are entered by the founder, normalised (case and surrounding whitespace) and unique across the catalogue. Normalisation and uniqueness: implementation approved by the founder (Gate G.3). Technical default approved in Gate G.3a: 1–64 ASCII uppercase letters, digits, hyphens and underscores. How a SKU is structured and what its parts mean is still to be agreed. | P |
| I-11 | Products and variants that are referenced by stock history, orders or audit records are deactivated or archived, never silently deleted. Audit-relevant records are never removed without a recorded, authorised action. | P |
| I-12 | Owner Office product, stock and order listings are searchable, filterable and paginated with a stable sort. Customer-facing search is undecided (S-14). | P |

## 6. Owner Office

A private area for the founder, with security boundaries that anticipate later staff roles.

| ID | Requirement | Basis |
|---|---|---|
| OF-1 | Manage products, pricing, stock, orders (website and assisted), expenses, fulfilment, configuration and reports. Phased delivery is acceptable. | F |
| OF-2 | A practical dashboard, not an executive analytics page. No fictional KPIs. | P |
| OF-3 | Cash-on-delivery money is shown in separate buckets: expected, collected by the courier, settled to the owner. Whether an order counts as *expected* depends on verification (O-10). *Founder rule J (A.9).* | F (was P) |
| OF-4 | Every Office page and API enforces authentication and authorisation. Each is covered by a negative test. | P |
| OF-5 | Authentication uses an established solution, not a custom-designed protocol. It includes session expiry, CSRF protection and a recovery path for a lost device. Which solution is open. | P + Q |
| OF-6 | Privileged and sensitive actions (exports, stock adjustments, status changes) are written to an audit log with actor and time. | P |
| OF-7 | Staff roles are not built now. Permission checks are written so roles can be added without rewriting them. | F |
| OF-8 | **COD courier settlement:** for each cash-on-delivery consignment the owner can record the amount expected, the amount the courier remitted, courier fees or deductions, the date received, and any unresolved difference. All amounts and fees are entered by the owner. None are assumed here. How courier statements are reconciled is to be defined. *Founder rule J (A.9): manual recording of collection and settlement. Statement reconciliation stays P.* | F + P (was P) |
| OF-9 | Audit and ledger entries record the real acting identity (extends I-3 and OF-6). Before an authentication solution exists, entries carry an explicit non-user source label; the system never invents or reuses a person's identity. Truthful actor auditing: implementation approved by the founder (Gate G.3). | P |
| OF-10 | The approved authentication solution (OF-5) handles passwords: no hand-written password hashing or session protocol. Admin and Staff permissions are enforced on the server for every privileged operation, and session or token lifetime suits the client type (API-10). Roles themselves are not built now (OF-7). | P |

## 7. Data portability, reports and recovery

Launch-critical, not a later phase.

### 7.1 Exports

| ID | Requirement | Basis |
|---|---|---|
| D-1 | Owner can export to **Excel (.xlsx)**, **CSV** and **JSON**. | F |
| D-2 | CSV is UTF-8 and opens correctly in desktop Excel with Bangla text. CSV and spreadsheet formula injection is prevented. | P |
| D-3 | JSON includes a schema version, export time, timezone, and IDs and relations preserved. | P |
| D-4 | Phone numbers and order IDs stay as text in every format. Amounts avoid floating-point approximation. | P |
| D-5 | Filters include date range, channel, order status and payment status. A **complete** export is independent of on-screen pagination. Every export is clearly labelled complete or filtered. | P |
| D-6 | Exports of customer personal data are owner-only and logged. Download links are not public or predictable. | P |
| D-7 | A report is consistent: totals and relations are the same throughout one export. | P |
| D-8 | Data sets to cover, as they become active: catalogue and variants, stock and movement ledger, orders and items, assisted-order source, fulfilment and tracking, COD expected/collected/settled, returns and refunds, expenses and cash movements, customers, settings and policies, audit log. | P |

### 7.2 Print

| ID | Requirement | Basis |
|---|---|---|
| D-9 | Print-ready reports exist for the owner. *Proposed:* A4, showing business name, title, date range, generated time, page numbers and totals, without clipped columns. | F + P |
| D-10 | Routine printed summaries omit customer phone and address. | P |

### 7.3 Backup and recovery

The founder requires **verified backup and recovery**. The items below are the proposed means.

An export is a readable snapshot. It is **not** a disaster-recovery backup. Spreadsheet, CSV and JSON exports, including daily ones, never replace complete database backups (K-10).

| ID | Requirement | Basis |
|---|---|---|
| K-1 | Consistent, restore-tested logical database backups, including schema, relations and migration history. | P |
| K-2 | Uploaded media is backed up with a manifest mapping files to products. | P |
| K-3 | Source, migrations and configuration templates (no secrets) are kept in Git. | P |
| K-4 | An encrypted local copy **and** a separate off-device copy, in a place chosen by the founder. | P |
| K-5 | Backup frequency is **derived from the approved RPO (K-9)** and from what the chosen host and a one-person routine can realistically sustain. A weekly full backup is a proposed *minimum*, and is not enough if the RPO is shorter. A backup is also taken before migrations and risky bulk edits. | P |
| K-6 | A **restore drill** into a fresh environment checks counts, sample orders and stock, foreign keys, images, Bangla text and absence of duplicate orders, and measures the time taken against the RTO. The date and result are recorded. A backup without a successful restore is not considered verified. | P |
| K-7 | Outage fallback: locally kept order, stock, cash and courier sheets, plus a written procedure to avoid duplicates and reconcile when the service returns. | F + P |
| K-8 | Each backup target's retention window and its limits are written down in the operations runbook. | P |
| K-9 | **The founder approves a recovery point objective (RPO)** (how much recent data may be lost) **and a recovery time objective (RTO)** (how long the shop may be without its records) before launch. Backup frequency, off-device copy and restore drills are set to meet them. | Q |
| K-10 | Spreadsheet, CSV and JSON exports do not satisfy K-1. Both exist, for different purposes. | P |

### 7.4 Implementation status (Gate H.13–H.16)

What exists for the items above and the related Owner Office items, as of 15 Nov 2026. Basis labels are unchanged: implementing a **P** item does not approve it. Details: [runbook](../operations/runbook.md), [export formats](../operations/exports.md).

| ID | Status | Notes |
|---|---|---|
| OF-2 | Implemented and tested | Dashboard of work queues and stock from live data; no KPI or target. |
| OF-3 | Implemented and tested | Expected (verified, not dispatched), to collect, held by the courier, settled, with a reconciliation check. |
| OF-6 | Implemented and tested for exports and stock counts | Export requests and count corrections are audited with actor and time. |
| OF-8 | Partly implemented | Expected, collected and settled per order; courier fees, deductions and statement reconciliation are not recorded. |
| I-8 | Implemented and tested | Owner-started counts, resumable drafts, stale-count refusal, reasoned ledger adjustments. Counting routine and frequency still open. |
| D-1 to D-7 | Implemented and tested | Twelve datasets in XLSX, CSV and JSON; XLSX read back with an independent parser. Not yet opened in desktop Excel or on a phone by a person (G-5 not met). |
| D-8 | Partly implemented | Every dataset whose data model exists; expenses, cash movements, a separate customer record and policies do not exist. |
| D-9 | Implemented, not independently verified | A4 print views with title, scope, generated time and page numbers, checked in Chromium only. No business name: no approved identity configuration exists. |
| D-10 | Implemented and tested | Routine print views carry no phone or address; only the order shipping document does. |
| K-1 | Implemented and tested (local) | Encrypted pg_dump backup of the local database; drill passed on fictional data. |
| K-4 | Local part implemented | Encrypted local copy only. The off-device copy waits for decision 15. |
| K-5, K-8, K-9 | Not implemented (blocked) | No frequency, retention, RPO or RTO approved. |
| K-6 | Drill implemented on fictional test data | Restore into babysunray_test verified table by table; times recorded as observations. G-6 not met (no approved RTO, no restore of real data). |
| K-7 | Draft — Founder Review | Outage procedure and blank sheets written; not rehearsed. |
| K-10 | Implemented | Exports and backups are separate tools. |

## 8. Brand

| ID | Requirement | Basis |
|---|---|---|
| BR-1 | Approved direction: **A / Warm Cocoa, Refined Timeless Boutique**. The wordmark silhouette, small sunrise arc and three rays above "Sunray" are preserved. No lower swoosh, no detached sun. | F |
| BR-2 | Approved logo colours: Deep Cocoa `#332923`, Muted Amber `#C28B56`, Warm Ivory `#F9F6F1`. | F |
| BR-3 | The logo is not redesigned and no replacement font is substituted without approval. Refinements may be proposed as options only. | F |
| BR-4 | The current vector is a trace of a raster original. A clean vector master is needed before print, favicon or small-size use. It is a reference, not trademark clearance. | F |
| BR-5 | *Little Days. Warm Moments.* is a proposed communication line. It is not registered, not locked, and not part of the logo artwork. | F |
| BR-6 | The logo identity is approved as a brand reference. **The website's colour system, layout, typography and visual design are not yet decided.** The earlier design prototype is discarded and is not approved. Interface colours that must hold contrast on text and controls are a design decision still to be made. | F |

## 9. Quality and acceptance gates

These must be demonstrated before the matching feature is called ready. Evidence is recorded, not assumed.

| ID | Gate |
|---|---|
| G-1 | Under the approved reservation rules, parallel orders for the last unit never oversell. A failed reservation leaves no order, item or hold. Multi-item carts and retries are included. |
| G-2 | A repeated submission with the same idempotency key yields one order, including after a timeout and retry. |
| G-3 | Every Office route and API rejects unauthenticated and unauthorised requests. |
| G-4 | Tracking links cannot be enumerated or guessed. Expiry and revocation work. No link or personal data appears in logs, analytics, error reports, referrer headers or third-party requests. Generic errors and rate limits apply. |
| G-5 | XLSX, CSV and JSON exports open correctly on Windows desktop Excel and common mobile browsers, with Bangla text, text phone numbers and no formula execution. |
| G-6 | A full restore drill passes (K-6) and meets the approved RTO. The backup routine meets the approved RPO. |
| G-7 | Delivery, return/exchange and privacy policies are **founder-approved and published** before public checkout is enabled. Placeholder text does not satisfy this gate (S-17). |
| G-8 | The chosen production hosting is confirmed to permit commercial use, its limits and failure behaviour are tested, and its backup and restore capability is verified. |
| G-9 | Usability: at least five informal testers including one first-time online buyer, on a mid-range Android phone. |
| G-10 | The business rules O-9 to O-14 are approved in writing before the schema and logic that depend on them are implemented. *Met in Revision A.9 ([order-policy-decisions.md](order-policy-decisions.md)).* |
| G-11 | For every API endpoint: unauthenticated and unauthorised requests are rejected (G-3); invalid and unexpected input is handled as documented; errors follow API-6 and leak no internals or personal data; size limits, rate limits and CORS behave as specified (API-11). |
| G-12 | The OpenAPI description matches actual endpoint behaviour, and the versioning policy (API-9) is followed whenever a contract changes. |
| G-13 | Under the approved rules (O-11), repeated and concurrent cancellation requests reverse stock exactly once and leave no partial state. Blocked until O-9 to O-12 are approved. |
| G-14 | A fresh installation, following the documented procedure with a different brand configuration and fictional data, runs without any BabySunray data, and licences have been reviewed (RU-1 to RU-5). |

### 9.1 Engineering expectations

The founder wants a production-minded inventory and order API. The outcome is founder-stated; the specific methods are proposed. Detailed working rules are in `.claude/rules/engineering.md`.

| ID | Expectation | Basis |
|---|---|---|
| EN-1 | TypeScript in strict mode. Routes, domain services and database access are separate layers, and transaction boundaries are visible in the code that opens them. | F + P |
| EN-2 | PostgreSQL enforces integrity with NOT NULL, UNIQUE, FOREIGN KEY and CHECK constraints wherever possible, in addition to application checks. Schema changes are repeatable migrations, reviewed and kept in Git, so migration history exists. | F + P |
| EN-3 | Database access uses parameterised queries or a safe ORM. SQL is never built by concatenating input. | F + P |
| EN-4 | Development fixtures and seed data are fictional, development-only, and cannot run against a production database. | F + P |
| EN-5 | The README records setup, test and API-usage instructions that have been run and verified. Features that do not exist yet are not described as available. | F + P |
| EN-6 | Tests cover unit logic, PostgreSQL integration, API security (negative authorisation, validation, error and data leakage), concurrency (parallel requests for the last unit) and failure paths (rollback, retry, timeout). | F + P |

### 9.2 Implementation status (Gate H.17–H.20)

What batch H.17–H.20 built, as of 15 Nov 2026. Basis labels are unchanged: implementing a **P** item does not approve it, and nothing here publishes a product or opens checkout.

| ID | Status | Notes |
|---|---|---|
| O-13 | Return window protected | A delivered order can be closed only after its 7-day return window, enforced by the rules and a database check, so closing or settlement never ends the customer's right to ask for a return. Engineering default, Draft — Founder Review ([order-policy-decisions.md](order-policy-decisions.md), section 3). |
| S-1, S-6, S-11 | Content prepared, nothing published | Fabric, care, size guidance and a size chart in cm per product, in both languages; the fabric statement counts as confirmed only after the Owner confirms it. No text is generated or translated. Nothing is shown to customers. |
| I-5, K-2 | Local development storage only | Owner photo upload with type, size and decoding checks, metadata removed, stored outside the repository; a manifest (`product_media`) and `npm run media:verify`. No production storage, no automatic photo backup. Decision 14 stays open ([ADR-0006](../adr/0006-product-media-storage.md)). |
| I-6 | Advisory checklist only | A read-only readiness checklist separates approved requirements, this proposed rule and recommendations. No publish action exists. |
| D-8 | Extended | Three more export datasets: product content, size charts and the photo manifest. |
| S-15, G-4 | Hardened, not complete | The tracking page removes the token from the address bar and the tab's history and keeps it in memory only. Limits per live link and a global limit for unknown tokens that never blocks a live link. A per-client limit and flood protection still need a trusted proxy (decision 1). |

## 10. Phasing (proposed)

| Phase | Outcome | Basis |
|---|---|---|
| 0 | Documentation and decisions: requirements, stack ADR, business rules (O-9 to O-14), RPO and RTO, hosting and ORM decisions, design research and approved design system | P |
| 1 | Local PostgreSQL development and tests (only after separate founder approval): catalogue, stock and Owner Office foundation, with exports and backup working on demo data | P |
| 2 | Guest COD checkout, confirmation, tracking, assisted orders | P |
| 3 | Reports, print, restore drill, outage procedure, then launch review against section 9 | P |

The API (section 2.3) and reuse (section 2.4) requirements apply from Phase 1 and are met capability by capability, not as a separate phase. *Proposed.*

Local development does not require approved hosting. **Production deployment** requires validated hosting, backups and commercial-use terms (G-8). Order and scope can change after founder review.

## 11. Out of scope for now

Multi-tenant or SaaS features, partner or profit-sharing logic, online card payment, staff roles, and SMS or one-time codes as a required dependency, unless the founder adds them. Search, accounts, wishlists and reviews are **undecided**, not excluded (S-14).

Also out of scope: a separate backend server, Express, microservices, a monorepo or an API gateway (ADR-0001 keeps one modular monolith); and multi-tenant SaaS, subscriptions, billing infrastructure, white-label dashboards and customer onboarding platforms, even though a customised copy may be reused or sold (B-12, RU-6).

## 12. Open decisions

| # | Decision | Notes |
|---|---|---|
| 1 | Production hosting and database host | Must satisfy BDT 0 (C-1), commercial use and restore (G-8). A sub-BDT-1,500/year Bangladesh plan may be evaluated (C-3). |
| 2 | ORM: Drizzle or Prisma | **Resolved:** Drizzle, approved by the founder in Gate G.3 (14 Nov 2026). See ADR-0002. |
| 3 | Authentication solution | **Resolved:** Better Auth, email and password, database browser sessions, no public sign-up, local Owner bootstrap, Owner-first permissions; approved by the founder in Gate H.2 (15 Nov 2026). See ADR-0003. Still open: the lost-device recovery path OF-5 requires (not built), 2FA, and native-client credentials (API-10). |
| 4 | Final UI design | Colours, typography, layout. Needs design research and approval (BR-6). |
| 5 | Business rules O-9 to O-14 | Reservation timing, pending verification, cancellation, release and expiry, returns, RTO. Needed before schema work (G-10). **Resolved** (A.9, [order-policy-decisions.md](order-policy-decisions.md)), except exchange execution (replacement delivery charge, price difference). |
| 6 | RPO and RTO | Founder approval (K-9). |
| 7 | Policies: delivery, return/exchange, privacy | Founder-approved text required before public checkout (S-17, G-7). |
| 8 | Delivery charges and zones | Owner to supply real values (O-8). Zones decided (A.9: Dhaka City and Outside Dhaka, Owner-configured); amounts and any district rules still open. |
| 9 | Courier and COD settlement process, return inspection criteria, stock counting routine | Real processes not yet documented (OF-8, I-7, I-8). COD collection and settlement are recorded by hand (A.9, rule J); inspection is pass or fail with a note; the real courier process and inspection criteria are still open. |
| 10 | Tracking link lifetime | S-16. **Resolved** (A.9, rule N): 30 days after closure; revocable. |
| 11 | Lifecycle status values and transitions | Defined after item 5 (section 4). **Resolved** as Draft — Founder Review in [order-policy-decisions.md](order-policy-decisions.md), section 2. |
| 12 | Launch scope of search, accounts, wishlist, reviews | Undecided (S-14). |
| 13 | Repository visibility | Private first or public (R-1). |
| 14 | Product photo workflow | Depends on hosting (I-5). |
| 15 | Off-device backup location | Founder chooses (K-4). |
| 16 | Approval to start local PostgreSQL development | **Resolved:** approved by the founder; the local PostgreSQL development and test foundation exists (README.md). |
| 17 | API contract: endpoint structure, versioning policy, OpenAPI tooling, native-client credentials | Direction approved by the founder in Gate H.2 (15 Nov 2026): versioned REST under `/api/v1`, described in OpenAPI. Batch H.2a + H.3 built four read-only Owner endpoints, Bearer authentication (Better Auth's plugin, the session token as credential), OpenAPI 3.1 with contract tests and a draft compatibility policy (`docs/api/README.md`, ADR-0004). Batch H.4–H.6 added Owner-only writes for the draft catalogue and stock with idempotency keys, 64 KiB body limit, no CORS and per-user rate limits (version 1.1.0). Still open: native apps and their token handling (API-10), founder approval of the versioning policy (API-9), retention of idempotency records, a limit for unauthenticated traffic (hosting). |
| 18 | Approval of the proposed technical defaults: Drizzle; Product → Variant with variant-level price (I-9); founder-entered unique SKU and its format (I-10); `on_hand` balance plus append-only ledger (I-2); integer paisa and UTC (O-5, O-6); truthful actor auditing (OF-9) | **Approved for implementation** in Gate G.3 (14 Nov 2026). Gate G.3a approved the SKU character set (ASCII letters, digits, hyphen, underscore), strictly positive prices and ASCII slugs; the SKU structure (I-10) is still to be agreed. "Reserved" and "available" stock (I-2) followed from O-9 to O-12, decided in Revision A.9. O-9 to O-14 stay open independently (item 5). |
| 19 | Reuse: configuration mechanism, licence review scope, terms of any handoff | RU-1 to RU-6. Commercial terms are a founder decision. |

## 13. Source materials

| Source | Used for | Note |
|---|---|---|
| Founder brief: review brief, section 2 | Business context, brand, channels, scope | Founder statement. |
| Advisor alignment brief (14 Nov 2026), section 1 | Budget, portability, solo operation, repository standards | Founder decisions recorded by an advisor. Other sections are advisor text. |
| Founder instruction, Gate A and A.1 (14 Nov 2026) | Lifecycle dimensions, budget wording, stack direction, brand status, corrections | Highest precedence. |
| Second technical advisor review (Gate A.1) | Label audit, business-rule gaps, recovery objectives, tracking security | Advisor input, applied as corrections by the founder's instruction. |
| Architecture decision review (14 Nov 2026) | Acceptance gates, export and recovery details | Advisor proposal. Cloudflare-specific parts are not carried over. |
| Founder instruction, Gate G.2b (14 Nov 2026) | Long-term outcomes (B-8 to B-13), API and reuse direction, engineering expectations | Outcomes are founder-stated. API, reuse and engineering methods are advisor proposals. |
| Founder instruction, Gate G.3 (14 Nov 2026) | Approval to implement Drizzle and the technical defaults in decision 18; closes decision 16 | Approves implementation only; basis labels unchanged. |
| Founder instruction, Gate G.3a (14 Nov 2026) | SKU character set, strictly positive price, ASCII slugs, stock on inactive SKUs | Technical defaults; basis labels unchanged. |
| Founder instruction, Gate H.10–H.12 (15 Nov 2026) | Order business rules A to N (O-9 to O-14 and related) | Founder statement; reproduced in order-policy-decisions.md, section 1. |
| Founder instruction, Gate H.2 (15 Nov 2026) | Authentication solution and its scope (decision 3); REST and OpenAPI direction (decision 17) | Approves implementation of the named scope only; basis labels unchanged. |
| Founder instruction, batch H.2a + H.3 (15 Nov 2026) | Authentication audit fixes; read-only `/api/v1` with Bearer and OpenAPI | Approves the named scope only; basis labels unchanged. |
| Founder instruction, batch H.4–H.6 (15 Nov 2026) | Operation idempotency; stock and draft-catalogue write API; API limits, CORS policy and rate limits; a minimal functional Owner Office (not a UI design) | Approves the named scope only; basis labels unchanged. |
| Founder instruction, batch H.13–H.16 (15 Nov 2026) | Dashboard, reports, exports, stock reconciliation, print, local backup and recovery tooling | Approves the named engineering scope only; basis labels unchanged; no schedule, retention, off-device copy or RPO/RTO decided. |
| Founder instruction, batch H.17–H.20 (15 Nov 2026) | Order and tracking fixes, product content and readiness, local development media, an Owner-only storefront preview with cart and checkout simulation, test and readiness work | Approves the named engineering scope only; basis labels unchanged; no publication, public checkout, customer accounts, hosting or final design approved. |
| Original BabySunray brand and business documents on the G: drive | Not read for this draft | Should be checked against sections 1 and 8 during review. |
