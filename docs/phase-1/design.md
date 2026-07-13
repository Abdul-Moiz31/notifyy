# Phase 1 Design

## Goal

Let a developer trigger an email notification to one of their own users via an API call, authenticated with a per-tenant API key, with idempotent retries and reliable delivery via a background worker.

## Components

- **apps/api** — Fastify service with two parallel auth scopes: `/v1/events*` authenticates by API key (external integrators); `/v1/dashboard/*` authenticates by Supabase session token (the dashboard). Both validate request bodies and delegate to the same `src/services`, keeping route handlers thin.
- **apps/worker** — Long-running process that polls the `jobs` table (`SELECT ... FOR UPDATE SKIP LOCKED`), sends email via Nodemailer over SMTP, and updates job status.
- **apps/dashboard** — Next.js app (Supabase Auth) where a tenant signs up, sees their API key (shown in full once at issuance, masked thereafter — see ADR-010) and can regenerate it, and views their notification event history with delivery attempts. Calls `apps/api`'s `/v1/dashboard/*` routes directly; no business logic is duplicated in the frontend.
- **packages/db** — Drizzle schema and Postgres client, shared by api and worker.
- **packages/queue** — Postgres-backed queue abstraction (`PgQueue`), isolated so it can be swapped for a dedicated queue system later without touching callers.
- **packages/shared** — Zod schemas, constants, and types shared across apps.

## Data model

- `tenants` — one row per developer/organization; `auth_user_id` nullable and unique, linking a tenant to the Supabase Auth user who owns it in the dashboard (null for tenants that only ever existed via the seed script). See ADR-009.
- `api_keys` — `key_hash` (never the raw key) scoped to a tenant; `last_four` stores the last 4 characters of the raw key, non-secret, for masked display in the dashboard (e.g. `ntfy_••••••••ab12`); `last_used_at` tracked on auth, `revoked_at` nullable so only unrevoked keys authenticate. Indexed on `key_hash` for fast lookup. See ADR-010.
- `notification_events` — one row per triggered event, unique on `(tenant_id, idempotency_key)` to make retries safe. `status` tracks `pending → processing → sent | failed | dead_letter`.
- `deliveries` — one row per delivery attempt on a channel for an event (`channel` currently only `email`); tracks `provider_message_id`, `attempt_count`, and `error_message` independent of the job that drove it.
- `jobs` — one row per unit of queued work for an event; polled by the worker via `SELECT ... FOR UPDATE SKIP LOCKED`. `status` is `queued → locked → done | failed`, with `locked_by`/`locked_at` recording which worker holds the row and `run_after` controlling when it becomes claimable (retry backoff). Indexed on `(status, run_after)` for the poll query.

Every table carries `tenant_id` (including `jobs` and `deliveries`, which also carry `event_id`) and every query is scoped by it, even during local/single-tenant testing. See `docs/phase-1/decisions.md` ADR-004 and ADR-006.

## Request flow

1. Client calls `POST /v1/events` with an `Authorization: Bearer <api-key>` header and a JSON body (`idempotency_key`, `event_type`, `payload`).
2. `plugins/api-key-auth.ts` hashes the key, resolves it to a `tenantId` via `api_keys.key_hash` (rejecting revoked keys), and stamps `request.tenantId` — or rejects with 401. It also updates `last_used_at`. This hook is scoped only to `/v1/events*`, not `/health`.
3. The route validates the body with a Zod schema from `packages/shared` and delegates to `services/events.service.ts`.
4. The service inserts the event and a `jobs` row (`status = 'queued'`) in one transaction. If `(tenantId, idempotencyKey)` already exists, the unique constraint fires; the service catches the Postgres unique-violation and the route returns **409 Conflict** — no duplicate event or job is created. A successful create returns **201** with the event.
5. `GET /v1/events/:id` and `GET /v1/events` (paginated, most recent first) are scoped to `request.tenantId` in every query — a valid id belonging to another tenant returns 404, identical to a nonexistent id, so tenant existence is never leaked.
6. The worker polls `jobs` (`status = 'queued' AND run_after <= now()`), claims a batch with `FOR UPDATE SKIP LOCKED` via `packages/queue`'s `PgQueue.claimNext`, loads the associated `notification_event`, validates its `payload` against `emailNotificationPayloadSchema`, and sends the email through Nodemailer. On success it marks the event `sent`, upserts a `deliveries` row with the provider's message id, and marks the job `done`. On failure it upserts the `deliveries` row with the error message and either requeues the job with an exponential backoff `run_after` (attempts below the max) or marks the job `failed` and the event `dead_letter` (attempts at or beyond the max, or a payload that fails schema validation, which cannot succeed on retry). See ADR-008.

## Dashboard request flow

1. A tenant signs up / logs in via Supabase Auth directly from the dashboard (client-side), getting a Supabase session (access token) — `apps/api` never sees a password or handles Supabase user creation itself.
2. The dashboard calls `POST /v1/dashboard/signup` with `Authorization: Bearer <supabase-access-token>`. `plugins/supabase-auth.ts` verifies the token against Supabase's `/auth/v1/user` REST endpoint and stamps `request.authUserId` — or rejects with 401. `services/tenants.service.ts`'s `ensureTenantForAuthUser` looks up a `tenants` row by `auth_user_id`; if none exists, it creates the tenant and mints its first API key. The raw key is returned in this response only — never persisted, never returned again (ADR-010).
3. `GET /v1/dashboard/me` returns the tenant and a masked view of its active key (`last_four`, `created_at`, `last_used_at`); `POST /v1/dashboard/api-key/regenerate` revokes the active key and mints a new one, again returning the raw value once.
4. `GET /v1/dashboard/events` and `GET /v1/dashboard/events/:id` resolve the tenant from the session (not a header-supplied id) and delegate to the same `events.service.ts` functions `/v1/events*` uses, so listing/detail behavior (pagination, 404-on-cross-tenant) is identical between the two auth paths.

## Out of scope for phase 1

Caching, rate limiting, Redis, multi-region deployment, non-email channels, batching/digesting multiple events into one send, billing, team invites/multi-user tenants, and notification template editing.
