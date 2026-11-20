# BabySunRay

**A warm, practical online shop for babywear — built to work for the people running it, too.**

BabySunRay brings the customer shop and everyday business management into one place. Shoppers can find clothes, choose sizes and place cash-on-delivery orders. Behind the scenes, the owner can prepare products, keep track of stock, process orders and see where the money stands.

Designed for a small business in Bangladesh, with a **mobile-first customer experience**, English and বাংলা shopping pages, and a straightforward, English-language Admin.

> **Current status: Private pre-launch.** The application is deployed at [babysunray.com](https://babysunray.com), but the public shop is **not open for business yet**. The owner is completing setup and the final shopping-to-delivery rehearsal. Please do not place or promise real customer orders at this stage.

## Find what you need

| If you're… | Start here |
|---|---|
| **Running the store** | **[Complete Store Owner's Guide](docs/USER-GUIDE.md)** — everyday instructions, from adding your first product to reconciling COD |
| **Reviewing the Admin** | [Admin](https://babysunray.com/admin) — private sign-in required |
| **Preparing for opening day** | [Launch readiness](docs/operations/launch-readiness.md) — what must be completed before going public |
| **Working on the application** | [Project documentation](docs/README.md) — architecture, development, operations and decisions |

## What BabySunRay helps you do

### Make it easy for customers to shop

- Browse clothing by category, search and size.
- View product photos, measurements, availability and the full price before ordering.
- Shop in **English or বাংলা**.
- Add items to the bag and place a **cash-on-delivery** order.
- Order as a guest, with optional customer sign-in when enabled.
- Follow an order using a private tracking link.

The customer-facing shop and checkout are built, but **remain restricted while the owner completes pre-launch checks**.

### Keep the business organised

- **Products:** Create drafts, add English and Bangla details, sizes, colours, photos and prices; review items before publishing.
- **Inventory:** Record incoming stock, see what is reserved for orders and reconcile physical counts.
- **Orders:** Find customers by order number, name or phone; confirm, pack, dispatch and record deliveries.
- **Cash on delivery:** Keep money collected by couriers separate from money actually received by the business.
- **Returns:** Record returns, undelivered parcels and inspected items before restocking.
- **Reports:** Check order activity, COD reconciliation and inventory movements.
- **Store settings:** Update contact details, branding, delivery charges and customer policies.

The Admin is designed for day-to-day work on a computer or phone. It currently supports an **Owner account**; general staff accounts and invitations are not part of the current release.

## From a new product to a completed order

1. **Create a draft** with names, descriptions and photos.
2. **Add variants and stock** for each size or colour.
3. **Review and publish** when the product information is ready.
4. **Receive and confirm an order** after checking with the customer.
5. **Pack, dispatch and record delivery** as the parcel moves.
6. **Record COD collection and settlement** based on real payment information.
7. **Check reports** to see what is complete and what needs attention.

**[Read the step-by-step owner's guide](docs/USER-GUIDE.md)** for screenshots-free instructions that are easy to follow and share.

## What isn't automatic

BabySunRay currently does **not** book a courier, verify delivery directly with a courier, accept online card/mobile-wallet payments or transfer collected COD to a bank. Those steps require the owner's normal business process and accurate records in Admin.

Some pre-launch items also remain open: approved store policies, finished business details, the production database, final integration checks and the owner's launch decision. The website is **not publicly launched** until those are complete.

## A note about the brand

BabySunRay's current interface uses the **First Light** direction. The logo and supporting brand artwork are being refined separately; the current files are not the final vector identity.

## Documentation

This repository keeps two kinds of documentation intentionally separate.

**For store owners and day-to-day users:** [Complete User Guide](docs/USER-GUIDE.md). It explains what to click and what each action means, without code or installation commands.

**For the technical team:** [Documentation index](docs/README.md), [development setup](docs/getting-started.md), [system design](docs/architecture), and [operations and recovery](docs/operations/runbook.md). These references include historical decisions, so always use the current implementation and release notes when changing the software.

## Privacy and responsibility

Business information, customer contacts, orders and recovery credentials are private. Do not commit real customer data, account passwords, exported reports or backups to this repository. Examples and automated checks should use fictional information.

---

*BabySunRay is being prepared for its first public opening. The aim is simple: make ordering comfortable for customers and running the store manageable for the people behind it.*
