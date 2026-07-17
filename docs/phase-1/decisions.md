# Phase 1 Decisions

## ADR-001: Postgres-backed queue instead of a dedicated queue system

**Context:** Phase 1 needs reliable job delivery for a single channel (email) at low volume.
**Decision:** Use a `jobs` table in the same Postgres database, claimed via `SELECT ... FOR UPDATE SKIP LOCKED`, wrapped in a `PgQueue` class in `packages/queue`.
**Consequences:** No extra infrastructure to run or pay for in phase 1. The abstraction is isolated behind `PgQueue` so a later phase can swap in Redis/SQS/etc. without changing callers, at the cost of lower throughput ceiling than a dedicated queue.

## ADR-002: Idempotency via a unique `(tenant_id, idempotency_key)` constraint, enforced as a 409

**Context:** Clients may retry `POST /v1/events` on network failure, and retries must not double-send.
**Decision:** Require `idempotency_key` in the body of every event-creation request; enforce uniqueness per tenant at the database level. `services/events.service.ts` catches the resulting unique-violation and the route returns **409 Conflict** rather than silently replaying the original 201 — the caller finds out explicitly that this key was already used instead of getting an ambiguous 200/201.
**Consequences:** Retried requests never create a duplicate event or job. Clients must generate and persist their own idempotency keys; the API does not synthesize one. A client that wants the original event's data back after a 409 needs to look it up separately (e.g. `GET /v1/events` filtered client-side), which is a small extra step traded for an unambiguous status code.

## ADR-003: Layered architecture in apps/api and apps/worker

**Context:** Business logic (idempotency checks, event creation, job dispatch) needs to be testable independent of the HTTP/worker-loop transport.
**Decision:** Route handlers and the poll loop stay thin; all logic lives in `src/services`, and direct table access goes through `packages/db`.
**Consequences:** Easier to test services in isolation and to reuse logic (e.g. from the dashboard) later, at the cost of an extra layer of indirection for simple operations.

## ADR-004: Tenant scoping enforced at the schema level

**Context:** This is multi-tenant infrastructure from day one; a missing `tenant_id` filter is a data leak.
**Decision:** Every tenant-owned table has a non-nullable `tenant_id` foreign key, and every service query filters by it — even in single-tenant local testing.
**Consequences:** Slightly more boilerplate per query, but removes an entire class of cross-tenant data leak bugs before they can occur.

## ADR-005: Nodemailer over SMTP instead of Resend

**Context:** Phase 1 email volume is low and cost-sensitive; Resend's free tier is generous but ties delivery to one vendor's API and key.
**Decision:** Use Nodemailer against a standard SMTP endpoint (`SMTP_HOST`/`PORT`/`USER`/`PASS`), configurable to any provider (Gmail, Brevo, a self-hosted relay, etc.) rather than a provider-specific SDK.
**Consequences:** No vendor lock-in and free-tier flexibility across providers, at the cost of losing Resend-specific features (delivery webhooks, built-in analytics) that would need to be built separately if ever needed.

## ADR-006: A `tenant_id` column on every table instead of schema-per-tenant

**Context:** Multi-tenant Postgres has two common shapes: a `tenant_id` column with row-level scoping on shared tables, or a separate Postgres schema (or database) per tenant.
**Decision:** Use a single shared schema with a non-nullable `tenant_id` column on every tenant-owned table (`api_keys`, `notification_events`, `deliveries`, `jobs`), scoped explicitly in every query — see ADR-004.
**Consequences:** One migration path, one connection pool, and simple cross-tenant admin queries (e.g. counting jobs by status across all tenants for ops). Schema-per-tenant would give stronger physical isolation and per-tenant backup/restore, but at hundreds-of-tenants scale it means running migrations N times, managing a growing number of schemas, and connection pool exhaustion — none of which phase 1 needs at its expected tenant count. Revisit only if a compliance requirement demands physical isolation.

## ADR-007: Postgres `jobs` table instead of Redis or a message broker

**Context:** The worker needs a queue of pending email deliveries to poll, at phase 1's expected volume (low, single email channel).
**Decision:** Use the `jobs` table (see ADR-001) claimed via `SELECT ... FOR UPDATE SKIP LOCKED`, instead of introducing Redis, SQS, or another broker.
**Consequences:** Zero additional infrastructure — no new service to deploy, monitor, or pay for on the Oracle free-tier VM, and jobs share transactional guarantees with the rows that created them (a job and its `notification_events` row commit or roll back together). The tradeoff is a lower throughput ceiling and polling latency instead of push-based delivery; acceptable at phase 1 volume, and `packages/queue`'s `PgQueue` abstraction keeps this swappable if a broker becomes necessary.

## ADR-008: Exponential backoff retry, capped at 5 attempts, with a non-retryable path for bad payloads

**Context:** The worker's SMTP send can fail transiently (provider hiccup, network blip) or permanently (the event's `payload` doesn't match `emailNotificationPayloadSchema` — no `to`/`subject`/`body` — which will never succeed no matter how many times it's retried).
**Decision:** On a transient send failure, the worker increments the job's `attempt_count` and requeues it with `run_after = now + 2^(attempt_count - 1) seconds`, up to 5 attempts total; the 5th failure marks the job `failed` and the event `dead_letter` instead of requeuing. A payload that fails schema validation skips straight to `failed`/`dead_letter` on the first attempt — validation failures are deterministic, so consuming retry budget on them would only delay surfacing the problem.
**Consequences:** Transient provider issues get a few minutes of retry headroom (1s, 2s, 4s, 8s, 16s backoff) without a dedicated scheduler, reusing the `jobs.run_after` column the poll query already filters on. A tenant with a malformed payload sees `dead_letter` immediately rather than after 5 wasted poll cycles, at the cost of the worker needing to distinguish "won't succeed" from "might succeed later" rather than treating every failure identically.

## ADR-009: Tenant ↔ Supabase Auth user linked by a nullable `auth_user_id`, dashboard routes as a parallel auth scope

**Context:** `apps/api` only had API-key auth (external integrators). The dashboard needs its own tenants to sign up and log in via Supabase Auth, then see their own key and events — but there was no link between a Supabase Auth user and a `tenants` row, and API keys are only ever stored as a hash, so they can't be looked up by session.
**Decision:** Add a nullable, unique `tenants.auth_user_id` column (nullable because API-key-only tenants, e.g. the seed script, never sign up through the dashboard). Add a second Fastify auth plugin, `supabase-auth.ts`, that verifies the dashboard's `Authorization: Bearer <supabase-access-token>` by calling Supabase's own `/auth/v1/user` REST endpoint (no service-role key needed) and stamps `request.authUserId`. It's registered as a sibling scope to `api-key-auth.ts`, not a replacement — `/v1/events*` stays API-key-only for integrators, and new `/v1/dashboard/*` routes (`POST /signup`, `GET /me`, `POST /api-key/regenerate`, `GET /events`, `GET /events/:id`) are Supabase-session-only, delegating to the same `events.service.ts` functions the API routes use so business logic isn't duplicated.
**Consequences:** One Postgres project, one `tenants` table, no separate identity service — signing up in the dashboard is just "resolve or create the tenant row for this Supabase user." The dashboard can never authenticate as a tenant using an API key (by design — API keys are for server-to-server calls, not browser sessions), and a Supabase user who never calls `/signup` has no tenant row and gets 404 from `/me`, which the dashboard client treats as "needs to complete signup" rather than an error.

## ADR-010: API key shown in full only once, masked (`last_four`) thereafter

**Context:** `api_keys.key_hash` stores only a SHA-256 hash — by design, so a leaked database dump can't be used to forge keys. That means there is no way to "reveal" the original raw key again after creation; a dashboard "reveal" control that decrypts a stored key is not possible without weakening that guarantee.
**Decision:** Return the raw key exactly once, in the response body of `POST /v1/dashboard/signup` (first call for a tenant) and `POST /v1/dashboard/api-key/regenerate` — never again after that. Store an additional non-secret `api_keys.last_four` column (last 4 characters of the raw key) purely for display, so `GET /v1/dashboard/me` can render a masked value like `ntfy_••••••••ab12` indefinitely without ever holding the full key server-side.
**Consequences:** Matches the industry-standard pattern (GitHub tokens, Stripe secret keys): the dashboard's "reveal" affordance only ever applies to a key that was just generated in that same response — copy it now or regenerate. A tenant that loses their key has no recovery path other than regenerating (which invalidates the old one), which is the correct tradeoff for a secret that should never be persisted in reversible form.

## ADR-011: CORS enabled only for `/v1/dashboard/*`, not `/v1/events*`

**Context:** The dashboard runs in a browser on its own origin (`http://localhost:3001` in dev, a Cloudflare Pages domain in prod) and calls `apps/api` directly per this phase's "don't duplicate business logic in the frontend" rule. Browsers enforce CORS on cross-origin `fetch`, so without an explicit allow, every dashboard call to `/v1/dashboard/*` fails preflight. `/v1/events*` never has this problem — it's called server-to-server by integrators' backends, which aren't subject to CORS.
**Decision:** Register `@fastify/cors` scoped only to the `/v1/dashboard/*` registration block, allowlisting origins from `DASHBOARD_ORIGIN` (comma-separated, env-configured — the dashboard's own URL). `/v1/events*` gets no CORS plugin at all.
**Consequences:** The dashboard works from the browser without over-broadening the API's attack surface — `/v1/events*` (server-to-server, API-key authenticated) stays unreachable via a wildcard-origin browser request, and `/v1/dashboard/*`'s CORS allowlist is explicit rather than `origin: true` (reflect-any-origin), which would be inappropriate given it sits behind session-token auth. Deploying the dashboard to a new environment requires remembering to update `DASHBOARD_ORIGIN` — a small operational step traded for not open-ending the CORS policy.

## ADR-012: Migrate `apps/api` and `apps/worker` off Docker/VM onto a single Cloudflare Worker (Fastify → Hono)

**Context:** The original phase-1 deployment plan was Docker Compose on a free-tier VM (Oracle Cloud). In practice, every no-cost path to a VM either requires a credit card up front (Oracle, AWS, GCP free tiers) or is a "free-forever" reseller VPS with no reliability guarantee — neither is acceptable for a real deployment target. Cloudflare Workers has a genuinely free tier with no card requirement and no always-on VM to patch or monitor.
**Decision:** Replace Fastify with Hono (a router designed for edge/Workers runtimes) and fold `apps/worker`'s job-processing logic into the same Worker as a `scheduled()` export, so the whole backend is one `wrangler deploy`. Route shapes, status codes, Zod validation, and the API-key/session auth logic are ported behavior-for-behavior — `/v1/events*` and `/v1/dashboard/*` work identically from the outside. Services (`events.service.ts`, `tenants.service.ts`, `api-keys.service.ts`, `job-processor.service.ts`) are unchanged in their query/business logic, just parameterized to take a `db` argument instead of importing a module-level singleton, since Workers have no long-lived process to hold one.
**Consequences:** No server to provision, patch, or pay a card to keep alive, and one deploy instead of two coordinated ones (API + worker). The tradeoff is a different execution model to reason about: every request/scheduled invocation is a fresh, short-lived isolate with no persistent in-memory state or long-lived DB connection — code has to create what it needs (a DB client, an SMTP transporter) per invocation rather than once at startup. `apps/worker` is deleted entirely; its logic lives in `apps/api/src/scheduled/process-due-jobs.ts` now.

## ADR-013: Cloudflare Hyperdrive instead of a direct Postgres connection from the Worker

**Context:** Workers are short-lived, high-concurrency isolates — opening a fresh direct TCP connection to Supabase's Postgres on every request would both be slow (a full connection handshake per request) and quickly exhaust Supabase's session-pooler connection limit under any real traffic, the same way it did in this codebase's own vitest run before this was fixed (see the `dbMiddleware` connection-close fix below).
**Decision:** Provision a Cloudflare Hyperdrive config pointing at the existing Supabase connection string, bind it in `wrangler.toml` as `HYPERDRIVE`, and have the Worker read `env.HYPERDRIVE.connectionString` instead of a static `DATABASE_URL`. No schema or Drizzle table definition changes — `packages/db/src/hyperdrive.ts` adds a `createDb(connectionString)` factory (postgres.js + Drizzle, same as before) that the Worker calls once per invocation; `packages/db`'s existing Node-context singleton (`db`/`client`, used by `migrate.ts`/`seed.ts`/vitest) is untouched. The Worker-side `postgres.js` client is closed at the end of every request/scheduled run (`dbMiddleware`'s `finally` block, and `index.ts`'s `scheduled()` handler) — Hyperdrive pools the actual connection to Supabase, so the Worker-side client doesn't need to (and shouldn't) stay open across invocations.
**Consequences:** Hyperdrive absorbs connection pooling and reduces latency for repeat queries to the same origin, without touching a single line of query code — the entire migration is a connection-string source change. The one piece of new plumbing: `createDb`/`Database`/schema tables must be imported from the `@notify-engine/db/hyperdrive` and `@notify-engine/db/schema` subpaths in Worker code, never the root `@notify-engine/db` package — the root package's `client.ts` does a Node-only `dotenv`/`import.meta.url` load at module scope that crashes when bundled for the Workers runtime (this surfaced as a real `wrangler dev` startup crash during this migration and is why the package now exports side-effect-free subpaths specifically for Worker consumers).

## ADR-014: Cron Trigger (once-per-minute) job processing instead of continuous polling

**Context:** `apps/worker` used to poll `jobs` every 2 seconds in a `setInterval` loop on an always-on process. Workers have no equivalent to an always-on background loop — the platform's primitive for recurring work is a Cron Trigger, which invokes a `scheduled()` handler on a schedule and then the isolate goes away.
**Decision:** Configure a Cron Trigger at `* * * * *` (every minute) in `wrangler.toml`. The `scheduled()` handler runs `processDueJobs()` once per invocation — claim one batch of due jobs via the existing `PgQueue.claimNext` (`SELECT ... FOR UPDATE SKIP LOCKED`, unchanged), process each with the existing retry/backoff/dead-letter logic, then return. No loop, no `setInterval` — Cloudflare's own scheduler is the loop now.
**Consequences:** Worst-case pickup latency for a newly queued job goes from ~2 seconds to just under 60 seconds. This is an accepted tradeoff for phase 1: this system sends transactional emails, not real-time chat — a delivery landing within a minute instead of two seconds isn't user-visible in practice, and Cron Trigger's minimum interval (one minute) is a hard platform floor, not a config choice. Nothing about the retry/backoff math changes; a job scheduled 8 seconds in the future by backoff still just waits for the next Cron Trigger tick to be picked up, the same way it waited for the next poll cycle before.

## ADR-015: Nodemailer stays, running in-Worker via the `nodejs_compat` compatibility flag

**Context:** Nodemailer's SMTP transport is built on Node's `net`/`tls` sockets, which don't exist in the Workers runtime by default — this made a provider switch to an HTTP-based email API (e.g. Resend) look necessary when this migration started. But ADR-005 already picked Nodemailer/SMTP over Resend specifically to stay provider-agnostic, and Cloudflare's `nodejs_compat` compatibility flag backs `node:net`/`node:tls` with the Workers TCP Sockets API (`cloudflare:sockets`), which is enough for Nodemailer's SMTP transport to work unmodified.
**Decision:** Keep Nodemailer over SMTP exactly as ADR-005 decided; add `compatibility_flags = ["nodejs_compat"]` to `wrangler.toml` and read SMTP config from Worker bindings (`env.SMTP_HOST` etc.) instead of `process.env` in `smtpConfigFromEnv()`. No provider switch, no new account, no new API to integrate.
**Consequences:** Zero change to the email-sending code path's behavior or the ADR-005 rationale (provider-agnostic SMTP, works with any provider — Gmail, Brevo, a self-hosted relay). The verified gap: local `wrangler dev` (Miniflare's simulated Workers sandbox) failed to complete a real SMTP connection in this development environment with a DNS resolution error, while the identical code sending through plain Node (vitest) succeeded — this looks like a sandboxed-network limitation of the local simulator rather than a flaw in the approach (Cloudflare's own docs document raw TCP/SMTP working from deployed Workers), but it means local `wrangler dev` email delivery could not be fully confirmed in this environment and should be re-verified after a real deploy.
