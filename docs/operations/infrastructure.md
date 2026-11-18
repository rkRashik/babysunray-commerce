# Infrastructure compatibility

**Status:** Draft — Founder Review. **Purpose:** What the backend supports for a hosted installation (a Vercel-compatible Node deployment with Supabase PostgreSQL and Supabase Storage), the settings it takes, what is verified and what is not, and what the founder must set up by hand. Built in Gate H.44; audited and corrected in Gate H.45 (database exposure, pool design, Storage contract, staging tooling).

**Nothing is deployed and no hosting is chosen** (requirements C-1 to C-3, open decision 1, G-8). No Vercel or Supabase project, account, bucket or credential exists, and no test used one: everything below was verified against local PostgreSQL, mocked HTTP and unit tests. Whether a given plan may be used commercially, and at what cost, is a founder decision; see the plan terms (Vercel's Hobby plan is non-commercial: [terms](https://vercel.com/legal/terms), checked 2026-11-17). The launch gate stays closed and no product can be published.

## 1. The three ways to run it

| | Local development | Persistent Node server | Serverless functions |
|---|---|---|---|
| Database connection | local `babysunray_dev` | direct or session connection | transaction-mode pooler |
| `DATABASE_RUNTIME` | unset | `server` (or unset) | `serverless` |
| `DATABASE_POOLER` | unset | `direct` (or unset) | `transaction` |
| Pool per process | 10 | 10 (`DATABASE_POOL_MAX` 1 to 20) | 2 (`DATABASE_POOL_MAX` 1 to 20) |
| Waiting for a connection | at most 10 s | at most 10 s | at most 5 s |
| Idle connection closed after | 10 s | 10 s | 5 s |
| `statement_timeout` (60 s) | sent at connection start | sent at connection start | **not sent**: set on the database role (section 3) |
| TLS to the database | off | `DATABASE_SSL=require` or `verify-full` | `DATABASE_SSL=require` or `verify-full` |
| Photos | `MEDIA_STORAGE_DIR` folder | folder on a persistent disk, or Supabase Storage | Supabase Storage (a function's disk is temporary) |
| Maintenance | `npm run maintenance:run` | the same, or the HTTP call | the HTTP call |

With none of these variables set the behaviour is exactly the earlier local one. `npm run config:check` reports every variable below as set, missing or invalid, never its value; with `NODE_ENV=production` it validates the hosted rules (it never connects to a hosted database).

## 2. Environment variable names

Values are never written in documents or `.env.example`. Secrets are server-side only; nothing is prefixed `NEXT_PUBLIC_`.

| Name | Needed | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | The application's database. A query string is refused; TLS and pooling are set by the variables below |
| `DATABASE_RUNTIME`, `DATABASE_POOLER`, `DATABASE_POOL_MAX` | optional | Section 1 |
| `DATABASE_SSL` | yes, if the database is not on this machine | `require` (encrypted, server not verified) or `verify-full` (verified); `disable` is refused for a remote host |
| `DATABASE_SSL_CA` | optional | PEM text of the provider's CA certificate, for `verify-full` |
| `DIRECT_DATABASE_URL` | for migrations and backups on a hosted database | A direct or session connection, never the transaction pooler (port 6543) |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | yes | Unchanged ([ADR-0003](../adr/0003-authentication-foundation.md)); an https origin when hosted |
| `MEDIA_STORAGE_PROVIDER` | optional | `local` (default) or `supabase` |
| `MEDIA_STORAGE_DIR`, `MEDIA_LOCAL_STORAGE_IN_PRODUCTION` | local provider | As before |
| `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_SERVICE_ROLE_KEY` | `supabase` provider | Project origin, bucket name, and the server-side service key |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_FOLDER` | optional (the first three together turn the CDN on) | Cloudinary delivery of published product photos only ([ADR-0010](../adr/0010-hosting-and-image-delivery.md)); the folder defaults to `babysunray/products` |
| `MAINTENANCE_SECRET` | optional | Turns on `POST /api/internal/maintenance`; 32 or more random characters, different from `BETTER_AUTH_SECRET` |
| `MAINTENANCE_ALLOW_GET` | optional | Exactly `true` lets `GET` use the same Bearer secret, for a host whose scheduler cannot send `POST` (Gate H.53). Off by default; any other value keeps `GET` at `405` |

## 3. Supabase PostgreSQL

Supabase offers a direct connection, a session pooler (port 5432) and a transaction pooler (port 6543). Its [connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres) (read 2026-11-17) says the transaction pooler does not support prepared statements or session-level state (`set`, session advisory locks, `listen`, temporary tables) and that migrations and `pg_dump` need the direct connection (or the session pooler on an IPv4-only network).

| Concern | State |
|---|---|
| Prepared statements | The `pg` driver names a statement only when the code gives it a `name`; none does. A unit test scans the source |
| Session state | No session-level `SET`, advisory lock, `LISTEN` or temporary table exists outside the migration runner and the local tools, which use a direct connection. Exports use `set local` inside a transaction. A unit test scans the source |
| Transactions and row locks | Each transaction is held on one connection by the pooler, so `FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED` and transaction-scoped advisory locks behave as before. Tested against local PostgreSQL with the serverless and transaction-pooler pool settings: the last unit goes to exactly one of eight simultaneous orders. **Not tested against Supabase's pooler** |
| Migrations | `npm run db:migrate` still refuses anything but local `babysunray_dev`. A hosted **staging** command exists (`npm run db:migrate:staging`, [staging-setup.md](staging-setup.md)): a direct connection with TLS, the staging marker, the typed host name, a matching history, a fresh backup, one transaction under the migration lock, then the privilege script and audit, and a report. No production command exists |
| Pool size | Supabase's guide says one connection per serverless function, raised only with evidence of queuing; Vercel's advises against one under Fluid compute. Default 2, allowed 1 to 20. No code path holds one connection while waiting for another (`tests/db/pool-one.integration.test.ts` runs the main paths on a pool of one with a 2 s limit; a control proves the test catches nesting), so a small pool queues but never deadlocks. Capacity: section 5a |
| TLS | `require` encrypts but does not verify the server; Supabase says so and documents `verify-full` with its CA. The founder chooses |
| Statement limit | PostgreSQL's 60 s `statement_timeout` is sent as a connection start parameter in direct mode. Supabase documents that a session `set statement_timeout` does not work through the transaction pooler ([timeouts](https://supabase.com/docs/guides/database/postgres/timeouts), read 2026-11-17), so in `transaction` mode nothing is sent and the founder sets it on the role (`alter role babysunray_app set statement_timeout = '60s'`, [staging-setup.md](staging-setup.md), step 3). Whether a role setting applies through the pooler is **not documented**; the staging suite checks it |
| Idle connections | Closed after 5 s in serverless mode. Vercel's [guide](https://vercel.com/kb/guide/efficiently-manage-database-connection-pools-with-fluid-compute) also describes `attachDatabasePool` from `@vercel/functions` for closing idle connections before an instance is suspended. It is **not used**: it adds a dependency tied to one host; decide it at the staging check |

## 4. Product photos

`MEDIA_STORAGE_PROVIDER=supabase` stores photos in a **private** Supabase Storage bucket through its REST API with a secret key on the server (`src/modules/media/supabase-store.ts`). No library was added. The request and error contracts were checked against Supabase Storage's own source and its official client on 2026-11-17 (domain errors arrive as HTTP 400 with the real code in the body, for example `KeyAlreadyExists` or `NoSuchKey`).

- Keys are the same random names as before; only those reach a URL. The content type comes from the key's extension, objects are never overwritten, reads use the authenticated route, requests time out after 15 s, and network errors, 5xx and 429 answers are retried twice. A write whose answer was lost is recovered when the retry finds the same bytes. A missing bucket is an error, never an empty store. Downloads are read as a stream and cut off at 10 MB, and must come back with the content type of their key. Every answer is validated before use. New `sb_secret_...` keys are sent only as `apikey`; a legacy service_role key also as the bearer token; publishable and anon keys are refused.
- Images are still validated and re-encoded by the application before they are stored ([ADR-0006](../adr/0006-product-media-storage.md)); the Owner's replacement and removal rules, the manifest check and the encrypted photo backup work on the same store interface.
- **Unpublished photos are never public.** The bucket must be private and unversioned: the store refuses to upload unless that was confirmed within the last minute, and readiness reports not ready otherwise (both fail closed). The Owner Office serves a photo only to a signed-in Owner. For customers, `src/api/public-media.ts` serves a photo only when its product is published at that moment; it is built, tested and **not routed**, answers `503` while the launch gate is closed, and sets `no-store` until a caching policy exists (hosting).
- **Not verified against a real bucket:** the unit tests use an in-memory fake that follows those contracts, which is not proof. `npm run test:staging` exercises the real API (upload, duplicate, read, list, metadata, delete, private and anonymous access refused) once a staging project exists.
- The photo backup and restore commands still run against the local folder and the local development database. A bucket backup is designed, not built: the encrypted photo-backup format already reads through the store interface, so a staging variant needs only a guarded command (a later gate). Until then the bucket is not backed up by this project.

## 5. Serverless limits

- **Per-process limits do not add up to a global limit.** The bulkheads (anonymous reads, checkout, `/api/auth`) and the in-memory photo cache are per process. Each instance sizes its bulkheads from `DATABASE_POOL_MAX`: from 5 connections 40%, 20% and 20% (4, 2, 2 at 10); below 5, `/api/auth` keeps its own bulkhead of 1 (the Owner's sign-in never waits behind a tracking flood) and anonymous reads and checkout share one bulkhead of max(1, P - 2); one connection stays free for the Owner's pages at 3 and 4, none at the default 2, where Owner pages queue behind at most two short anonymous requests (never refused). Across N instances the anonymous total is N times that. They protect the database from a flood; they are **not rate limits**.
- **The storewide checkout limit and the tracking limits are stored in the database**, so they are shared by every instance.
- **No per-client limit is claimed.** The application trusts no client address header (Better Auth is configured with `ipAddressHeaders: []`; nothing reads `X-Forwarded-For`). A per-client limit needs an address the host's proxy guarantees, plus counters shared by all instances (the database, as today). Both are decided at the staging check; until then the launch gate's `abuse_protection` blocker stands.
- **Function time:** the maintenance route declares `maxDuration = 60`. Vercel's [duration page](https://vercel.com/docs/functions/configuring-functions/duration) (read 2026-11-17) gives 300 s as the default and, on Hobby, the maximum with Fluid compute; Pro allows more. Page routes use the host's default. Cold starts were not measured.
- **Ephemeral disk:** nothing the application needs is kept on local disk when `MEDIA_STORAGE_PROVIDER=supabase`. The local photo folder is refused in production unless `MEDIA_LOCAL_STORAGE_IN_PRODUCTION=allow`.
- **Sessions and cookies:** sessions are rows in the database (no cookie cache), so any instance can verify any session at once. Cookies are `Secure` for an https `BETTER_AUTH_URL` (Better Auth's behaviour, exercised by `npm run test:e2e:prod` behind a local TLS proxy); a hosted URL must be https. Origin and CSRF checks stay on. `sharp` (native) must be installable on the host: untested.

## 5a. Capacity (assumptions stated)

Supabase's published limits for the smallest compute sizes (Nano, the Free plan, and Micro): 60 database connections, 200 pooler clients, a pooler pool of 15 server connections per role and database ([compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk), read 2026-11-17). Assuming those, `DATABASE_POOL_MAX=2` and nothing else using the pooler:

| Quantity | Value |
|---|---|
| Client connections per warm function instance | 2 (closed after 5 s idle) |
| Warm instances before the pooler's 200-client limit | 100; keep 80 as the planning limit |
| Transactions running at once, whole shop | at most 15 (the pooler's pool for `babysunray_app`); more wait in the pooler |
| Direct connections for migrations and backups | 1 each, from the founder's machine, out of the 60 the database allows (Supabase's own services also use some) |
| Rough throughput at 10 to 20 ms per transaction | 750 to 1,500 transactions per second in theory, far above a small shop's need |

Not measured: how many concurrent requests Vercel puts on one instance, Supavisor's queue time-out, and Supabase's own connection use. With many concurrent requests on one instance, all but two wait up to 5 s for a connection and then fail with a clear error (tested locally). Raise `DATABASE_POOL_MAX` only when the staging run or real logs show waiting.

## 6. Maintenance jobs

`POST /api/internal/maintenance` runs the same jobs as `npm run maintenance:run`: verification expiry, dead sessions (audited), stale rate-limit counters, then the integrity checks.

| Rule | Behaviour |
|---|---|
| Off by default | `404` unless `MAINTENANCE_SECRET` is set and strong; a weak or placeholder secret keeps it off |
| Who | `Authorization: Bearer <secret>` only, compared in constant time; `401` otherwise. A request with an `Origin` header (a browser page) gets `403`; only `POST` is accepted (and `GET`, only when `MAINTENANCE_ALLOW_GET=true`, see below); a body over 1 KiB gets `413` |
| Concurrent calls | Allowed and safe: every job is a single statement or claims its rows with `SKIP LOCKED` and re-checks them under their own lock, so overlapping runs only find less to do. A run uses one connection at a time (H.44's run lock held a transaction open while the jobs took further connections, which waits for itself on a pool of one; removed in H.45) |
| Replay | The jobs are idempotent; a repeated call finds nothing more to do |
| Bounded | At most 1,000 rows per job per call; no job starts after 45 s; the rest are reported as `skipped` |
| Lateness | Each run first reports the work already overdue when it started (`backlog`: overdue verifications, the oldest by minutes, expired sessions), so a late or missed scheduler shows in the next run. Nothing claims a scheduled call always runs on time |
| Reporting | `200` when everything succeeded; `500` when a job failed, a job was skipped or an integrity check found a problem. Answers and logs carry counts and error class names only |
| Timing is never relied on | An overdue verification is also released by every new reservation and by the Owner's confirmation; a missed run leaves rows reading as expired a little longer, nothing else |

Manual call (placeholders, never paste the real secret into a chat or a ticket): `curl -X POST https://<site>/api/internal/maintenance -H "Authorization: Bearer <secret>"`. If it returns `500`, read the host's logs (event `maintenance_run`), and if `integrityProblems` is above 0 follow [the runbook](runbook.md), section 4. If it is unreachable, run `npm run maintenance:run` against the development database, or call again later; nothing depends on it being on time.

**No scheduler is activated.** Which scheduler calls it (a host cron, GitHub Actions, a free external pinger) is a founder decision. Vercel Cron, as documented, calls with `GET` and a `CRON_SECRET` header; this endpoint accepts `POST` and `MAINTENANCE_SECRET`, so Gate H.53 added a small adapter, off by default: with `MAINTENANCE_ALLOW_GET=true` the same endpoint accepts `GET` with the same `Authorization: Bearer <secret>` (set the host's `CRON_SECRET` to the same value as `MAINTENANCE_SECRET`; a second secret is not supported). Nothing else changes: no secret in a URL or query string (ignored), `401` without the right header, `403` with an `Origin` header, `404` without a usable secret, `no-store`, bounded run, idempotent jobs, so an overlapping, repeated, early or late call is harmless. It is tested with the jobs replaced (`tests/modules/maintenance-http.test.ts`); no host scheduler has been configured or tried. GitHub's schedule is not a real-time guarantee either; nothing here assumes it is.

## 7. Health and readiness

| Path | Meaning | Touches |
|---|---|---|
| `GET /api/health/live` | the process answers: `{"status":"ok"}` | nothing |
| `GET /api/health/ready` | configuration valid and the database answers `select 1` within 2 s: `{"status":"ready"}` or `503 {"status":"not_ready"}` | the database, at most once per 5 s however many callers |

Anonymous callers get a status word only. The reason (variable names, an error class) goes to the server log, never a value, host, version or error text. A database outage makes the application not ready but never not alive.

## 8. Remaining security limits

| Item | State |
|---|---|
| Trusted proxy, real client address | Not configured; decided with the host. Client-supplied address headers are ignored |
| Per-client and global rate limits | Not claimed; section 5 |
| Bot and flood protection in front of the application | None; the host or a CDN must provide it before checkout opens |
| Host header and origin | Better Auth checks origins against `BETTER_AUTH_URL`; the public transports accept only no `Origin` or the site's own; there is no CORS. Preview-deployment URLs would need a reviewed change |
| Request sizes | Streamed limits on every anonymous body (tracking 2 KiB, quote 8 KiB, checkout 64 KiB, maintenance 1 KiB) and on Owner API bodies |
| Anonymous exposure | Guest tracking, the two status probes and the maintenance call (off unless configured). No catalogue, quote, checkout or photo route exists |
| Secrets | Environment only; never logged; error messages name variables, never values. Rotating `BETTER_AUTH_SECRET` signs everyone out; `MAINTENANCE_SECRET` and the service key can be rotated independently |
| Storage credentials | The service key bypasses the bucket's access rules, so it must stay server-side; it is never sent to a browser |
| Cloud failures | A storage outage fails uploads with no record written, leaves no half-written state, and makes photo serving return an error without details; a database outage makes the application not ready |

## 9. Founder: manual setup

The staging steps are in [staging-setup.md](staging-setup.md): create a separate staging project, switch off the Data API, mark the database and create the application role, create a private bucket, collect the settings in `.env.staging.local`, run `npm run db:migrate:staging` and `npm run test:staging`. Nothing there has been done yet. Production needs the decisions below first.

## 10. Pending founder decisions

Hosting and plan (decision 1, C-1 to C-3); the photo store for production (decision 14); the scheduler and who alerts on failure; recovery objectives and the off-device backup place (K-9, decision 15); TLS mode (`require` or `verify-full`); a caching policy for published photos; the publication rule (I-6); published policies (S-17, G-7); the trusted-proxy design for per-client limits.
