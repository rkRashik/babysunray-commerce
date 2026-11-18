# ADR-0010: Hosting target and published-image delivery (Netlify, Supabase, Cloudinary)

**Status:** Draft — Founder Review
**Purpose:** Records the founder's confirmed hosting architecture and how published product photos reach customers; says what is built, what is not, and what the Netlify review found. Nothing is deployed.
**Date:** 2026-11-18
**Related:** [ADR-0006](0006-product-media-storage.md), [ADR-0008](0008-customer-identity-recovery-and-two-factor.md), [ADR-0009](0009-hosted-database-security-boundary.md), [infrastructure](../operations/infrastructure.md)

## Confirmed by the founder

| Concern | Choice |
|---|---|
| Hosting | Netlify Free (auto-deploys from `main` once the site is connected; the public shop stays closed by the launch gate) |
| Database | Supabase PostgreSQL ([ADR-0009](0009-hosted-database-security-boundary.md)) |
| Private and original photos | Supabase Storage, private bucket (unchanged) |
| Published product photo delivery | Cloudinary CDN (this ADR) |
| Owner sign-in | Existing Better Auth, unchanged |
| Customer sign-in (future) | Google OAuth. **Planned, not built, not enabled.** Customer sign-up stays refused until the founder approves it (ADR-0008, S-14) |

## Cloudinary: published photos only (built, inactive without settings)

- **Nothing draft is ever public.** A copy is uploaded only for a photo of a product whose status is `published`; the original stays in the private store and is never read by Cloudinary or the browser. Code: `src/modules/media/cdn.ts` (client, signing, URLs) and `cdn-sync.ts` (lifecycle); column `product_media.cdn_public_id` (migration 0019; null for every non-published photo).
- **The database decides what is public.** A Cloudinary URL appears in the public catalogue (`PublicPhoto.images`: `src` and `srcSet`, three widths, `f_auto,q_auto,c_limit`) only for a published product's photo with a recorded copy. Withdrawing a product removes its photos from every public answer at once, whatever Cloudinary is doing. Delivery is straight from `res.cloudinary.com`; no image request passes through Next.js. A published photo without a copy falls back to the closed `/api/public/media/{id}` route.
- **Publication** (`publishProductOnce`) uploads the copies after the commit; it cannot run today (no approved rule, I-6). **Withdrawal** destroys them with CDN invalidation after the commit. Failures are logged and counted, never thrown, and the `cdn_reconcile` maintenance job retries both directions (the job fails, so maintenance reports it, until it succeeds).
- **Replacement needs no invalidation.** The public id contains the photo id and the first 16 hex digits of its SHA-256, so changed content is a new URL and an old URL never serves different content. (A published product cannot be edited at all; replacement happens in a draft.)
- **No orphans.** A copy is destroyed only while its product is not published, and a photo that still has a recorded copy cannot be replaced or removed until its destroy has succeeded (`PRODUCT_NOT_EDITABLE`, retry later). A failed destroy therefore keeps a record that the reconcile job finishes.
- **Settings** (server only): `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, optional `CLOUDINARY_FOLDER` (default `babysunray/products`). None set means no CDN; a partial or malformed set is reported by `config:check` and readiness, and nothing is sent.
- **Cache limit that cannot be removed:** an image already held by a visitor's browser or another cache outside Cloudinary stays until it expires, and Cloudinary documents that an invalidation can take a few minutes to reach every node. For a short time after withdrawal, someone who has the exact image URL may still see it. Photos are not secret once published; the guarantee is that no draft is ever sent and that withdrawal removes the copy.
- **Not verified:** nothing was sent to Cloudinary. Tests use a recording fake, and the request signature is checked against Cloudinary's documented example. The first real upload, `destroy` with `invalidate`, the delivery transformations and the Free plan's limits must be checked against a real account.

## Netlify compatibility review (not deployed)

| Area | Finding |
|---|---|
| Build | `npm run build` (Next.js 16, Node 24 from `.nvmrc`); no database or secret is needed at build time. Netlify should detect the Next.js runtime automatically; not tried |
| Database | Use `DATABASE_RUNTIME=serverless`, `DATABASE_POOLER=transaction`, `DATABASE_SSL=require` with the Supabase transaction pooler (port 6543) and the `babysunray_app` role. Migrations are never run by Netlify; they stay a founder-run command |
| Photo upload size | The Owner upload accepts up to 10 MB. Netlify documents about 6 MB for a function request body, so larger photos are likely refused there. Keep photos below about 5 MB, or design direct-to-storage uploads later (a decision, not built) |
| Maintenance | `MAX_RUN_MS` is 45 s; Netlify Free functions are documented to stop sooner (about 10 s). The jobs are bounded and idempotent, but a run can be cut short. Scheduling is unresolved: no Netlify scheduled function is wired, and an external caller needs `MAINTENANCE_SECRET` |
| Per-client rate limits | Need a trusted client address; the code reads no forwarded header (a test guards this). Netlify supplies one, but using it is a decision (open decision 1) |
| `sharp` | Used for photo processing; Netlify supports it, not verified here |
| Previews | Branch and deploy-preview URLs are other origins; Better Auth (`BETTER_AUTH_URL`) is configured for one origin, so use the production site URL only |
| Public shop | Closed by the launch gate whatever is deployed: `/` is a status page and `/track` works; the catalogue, checkout and publication are not routed |
| Is the URL itself private? | **No.** A private Git repository or Netlify project does not protect the site URL, and site-wide password protection is, to our knowledge, not part of Netlify Free (verify in the dashboard). Anyone with the URL can open `/`, `/track` and the health probes and reach the Owner sign-in page. Customers have nothing to buy and no way to register, pages are `noindex`, and `/office` and `/api/v1` need the Owner's sign-in, but the URL is reachable. Keep it unshared; connect automatic deploys only when ready |
| Staging data on a site | `npm run netlify:env` (Gate H.58) writes the application's settings from the staging file as an importable `.env` file (never the administrator connection, never Cloudinary). A site configured this way uses the STAGING database and bucket; it has no Owner (the staging tests' accounts are disabled) and no real data. A production site needs its own Supabase project |

**Netlify settings by name:** `DATABASE_URL`, `DATABASE_RUNTIME`, `DATABASE_POOLER`, `DATABASE_SSL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `MEDIA_STORAGE_PROVIDER`, `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, optionally `CLOUDINARY_FOLDER`, `MAINTENANCE_SECRET`, `MAINTENANCE_ALLOW_GET`. Set the keys and secrets as secret variables; none is prefixed with the browser-public prefix.

## Not decided

The production Supabase project and production migration procedure ([production-migration.md](../operations/production-migration.md)); the maintenance scheduler; trusted-proxy rate limits; Google OAuth enablement and the customer account model (ADR-0008); a Cloudinary plan, usage limits and cost.
