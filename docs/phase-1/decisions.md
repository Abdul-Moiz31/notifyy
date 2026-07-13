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
