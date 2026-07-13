# Phase 1 Design

## Goal

Let a developer trigger an email notification to one of their own users via an API call, authenticated with a per-tenant API key, with idempotent retries and reliable delivery via a background worker.

## Components

- **apps/api** — Fastify service. Authenticates requests by API key, validates the request body, records the notification event, and enqueues a job. Route handlers are thin; all logic lives in `src/services`.
- **apps/worker** — Long-running process that polls the `jobs` table (`SELECT ... FOR UPDATE SKIP LOCKED`), sends email via Nodemailer over SMTP, and updates job status.
- **apps/dashboard** — Next.js app (Supabase Auth) for tenants to view their API keys and notification history. Minimal in phase 1.
- **packages/db** — Drizzle schema and Postgres client, shared by api and worker.
- **packages/queue** — Postgres-backed queue abstraction (`PgQueue`), isolated so it can be swapped for a dedicated queue system later without touching callers.
- **packages/shared** — Zod schemas, constants, and types shared across apps.

## Data model

- `tenants` — one row per developer/organization.
- `api_keys` — `key_hash` (never the raw key) scoped to a tenant; `last_used_at` tracked on auth, `revoked_at` nullable so only unrevoked keys authenticate. Indexed on `key_hash` for fast lookup.
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
6. (Subphase 1d) The worker will poll `jobs` (`status = 'queued' AND run_after <= now()`), claim a batch with `FOR UPDATE SKIP LOCKED`, send the email through Nodemailer, record a `deliveries` row, and mark the job `done` or `failed`.

## Out of scope for phase 1

Caching, rate limiting, Redis, multi-region deployment, non-email channels, retry/backoff scheduling beyond a single attempt, and the dashboard's data views beyond a placeholder page.
