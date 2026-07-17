<p align="center">
  <img src="assets/logo.svg" alt="Notify Engine" width="440" />
</p>

<p align="center">
  Multi-tenant notification infrastructure. Developers integrate via API key to trigger notifications — starting with email — to their own users. Built in the shape of Novu or Courier.
</p>

<p align="center">
  <strong>Status:</strong> Phase 1, subphase 1f complete (migrated apps/api + apps/worker onto a single Cloudflare Worker — Hono, Hyperdrive, Cron Trigger job processing)
</p>

---

## Table of contents

- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Data model](#data-model)
- [Getting started](#getting-started)
- [API](#api)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [Architecture & decisions](#architecture--decisions)
- [Roadmap](#roadmap)

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript, strict mode everywhere |
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com) (`apps/api`); Node.js 20+ for local scripts/tests only |
| API framework | [Hono](https://hono.dev) |
| Database | Postgres via [Supabase](https://supabase.com), reached through [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) |
| ORM / query layer | [Drizzle ORM](https://orm.drizzle.team) + `drizzle-kit` |
| Validation | [Zod](https://zod.dev) |
| Queue (phase 1) | Postgres `jobs` table, `SELECT ... FOR UPDATE SKIP LOCKED` — claimed once a minute by a Cron Trigger, no Redis/broker |
| Email delivery | [Nodemailer](https://nodemailer.com) over SMTP (provider-agnostic — Gmail, Brevo, etc.), running in-Worker via the `nodejs_compat` compatibility flag |
| Dashboard | [Next.js](https://nextjs.org) 16, App Router, deployed to Cloudflare Pages |
| Dashboard auth | Supabase Auth |
| Logging | [pino](https://getpino.io), structured, no `console.log` (`browser.asObject` mode in the Worker) |
| Package manager | pnpm workspaces (monorepo) |
| Linting / formatting | ESLint 9 (flat config) + `typescript-eslint` + Prettier, `eslint-config-prettier` to avoid rule conflicts |
| Deployment (API) | `wrangler deploy` — one Cloudflare Worker, no VM |
| Load testing | [k6](https://k6.io) (not part of the phase 1 build) |

## Project structure

```
apps/
  api/            One Cloudflare Worker (Hono). fetch: /health, /v1/events* (API-key auth),
                   /v1/dashboard/* (Supabase-session auth). scheduled: claims + processes due
                   jobs once a minute (Cron Trigger) — sends email via Nodemailer/SMTP, records
                   deliveries, retries with backoff. wrangler.toml holds the Worker config.
  dashboard/      Next.js app — sign up/login (Supabase Auth), API key, notification event log
packages/
  db/             Drizzle schema, migrations. Two client surfaces: a Node singleton
                   (@notify-engine/db, for migrate/seed/tests) and a side-effect-free
                   per-invocation factory (@notify-engine/db/hyperdrive, for the Worker)
  shared/         Zod schemas, status enums, API key hashing — reused across apps
  queue/          Postgres-backed queue abstraction (`PgQueue`: enqueue, claimNext) — the only thing that touches `jobs` directly
docs/
  phase-1/
    design.md               target architecture for phase 1
    architecture-diagram.md mermaid diagram of the request/delivery flow
    decisions.md            ADR-style log of every non-obvious architectural choice
load-tests/
  k6-scripts/     empty for now, phase 1 doesn't need load testing yet
```

## Data model

Defined in `packages/db/src/schema.ts`, migrated via Drizzle:

- **`tenants`** — one row per developer/organization; `auth_user_id` links a tenant to the Supabase Auth user who owns it in the dashboard (nullable — the seed script's tenant has none).
- **`api_keys`** — `key_hash` only (the raw key is never stored), scoped to a tenant, indexed for fast lookup, `revoked_at` for revocation. `last_four` (non-secret) powers the dashboard's masked display.
- **`notification_events`** — one row per triggered event; `UNIQUE (tenant_id, idempotency_key)` rejects duplicate retries at the database level. `status`: `pending → processing → sent | failed | dead_letter`.
- **`deliveries`** — one row per delivery attempt on a channel (`email` for now) for an event; tracks `provider_message_id`, `attempt_count`, `error_message`.
- **`jobs`** — the phase 1 queue. `status`: `queued → locked → done | failed`, with `locked_by`/`locked_at` and `run_after` for backoff. Indexed on `(status, run_after)` since the Cron Trigger's scheduled handler claims from it every minute.

Every tenant-owned table carries a non-nullable `tenant_id`, scoped in every query — no exceptions, even in local single-tenant testing.

## Getting started

### Prerequisites

- Node.js >= 20
- pnpm (`corepack enable` provides the pinned version)
- A Supabase project (Postgres) — see [Environment variables](#environment-variables)

### Install

```bash
pnpm install
```

### Set up the database

```bash
cp .env.example .env   # fill in DATABASE_URL and the rest, see below
pnpm --filter @notify-engine/db run migrate
pnpm --filter @notify-engine/db run seed
```

The seed script creates one test tenant and one API key, and prints the **raw** key once — only its SHA-256 hash is stored, so save it when it prints.

### Run apps/api locally (wrangler dev)

`apps/api` is a Cloudflare Worker — local dev runs it in Miniflare (Cloudflare's local Workers simulator), not `node`. Two config files:

- `wrangler.toml` — committed, no secrets, placeholder values.
- `wrangler.local.toml` — gitignored, your own copy with real values (Supabase connection string, SMTP creds) for local testing, so you never put real credentials in a tracked file.

```bash
# create apps/api/.dev.vars (gitignored) with SMTP_HOST/PORT/SECURE/USER/PASS, NOTIFY_FROM_EMAIL,
# SUPABASE_URL/ANON_KEY, DASHBOARD_ORIGIN — see Environment variables below — and
# apps/api/wrangler.local.toml with a real DATABASE_URL as the [[hyperdrive]] localConnectionString
pnpm --filter @notify-engine/api exec wrangler dev -c wrangler.local.toml --port 8787
```

The Cron Trigger doesn't fire automatically under `wrangler dev`. To run the scheduled job-processing handler once locally:

```bash
pnpm --filter @notify-engine/api exec wrangler dev -c wrangler.local.toml --port 8787 --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

### Run the dashboard

```bash
pnpm dev:dashboard  # Next.js — runs on :3001 (matching DASHBOARD_ORIGIN) if apps/api holds :8787/:3000,
                    # e.g. `pnpm --filter @notify-engine/dashboard exec next dev -p 3001`
                    # and set NEXT_PUBLIC_API_URL to match apps/api's local port.
```

Open the dashboard, sign up with an email/password (Supabase Auth) — you're dropped straight onto `/dashboard` with a freshly issued API key shown once. From there, `/dashboard/events` shows every event triggered on that key, with delivery attempts on expand.

### Deploy

```bash
wrangler login                                                          # once, interactively
wrangler hyperdrive create notify-engine-db --connection-string="$DATABASE_URL"
                                                                          # copy the printed id into wrangler.toml's [[hyperdrive]] block
wrangler secret put SMTP_USER --config apps/api/wrangler.toml
wrangler secret put SMTP_PASS --config apps/api/wrangler.toml
pnpm deploy:api                                                          # wrangler deploy
```

## API

All `/v1/events*` routes require `Authorization: Bearer <api-key>` (the raw key printed once by the seed script). `/health` is unauthenticated.

### `POST /v1/events` — create a notification event

```bash
curl -s -X POST http://localhost:3000/v1/events \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"idempotency_key":"demo-key-001","event_type":"user.signup","payload":{"email":"demo@example.com"}}'
```

```json
{
  "id": "ad85f5b5-c396-4436-9ca4-617f13dc38d4",
  "tenantId": "0b81aada-6f31-40c6-afdf-10ce06798d66",
  "idempotencyKey": "demo-key-001",
  "eventType": "user.signup",
  "payload": { "email": "demo@example.com" },
  "status": "pending",
  "createdAt": "2026-07-13T13:01:00.041Z",
  "updatedAt": "2026-07-13T13:01:00.041Z"
}
```

A matching `jobs` row (`status: "queued"`) is created in the same transaction via `packages/queue`. Repeating the same `idempotency_key` for the same tenant returns **409 Conflict** and creates nothing new. An invalid or revoked API key returns **401**.

For the event to actually get delivered, `payload` must include `to` (a valid email), `subject`, and `body` — the scheduled handler validates this shape (`emailNotificationPayloadSchema` in `packages/shared`) before sending, on its next run (within a minute — see ADR-014). A payload missing any of these fails validation and the event goes straight to `dead_letter` without retrying.

### `GET /v1/events/:id` — fetch one event, scoped to the caller's tenant

```bash
curl -s http://localhost:3000/v1/events/$EVENT_ID -H "Authorization: Bearer $API_KEY"
```

Returns the event plus its `deliveries` array — populated once the scheduled handler has attempted (or completed) delivery. An id that doesn't exist — or that belongs to a different tenant — returns **404** in both cases, so tenant existence is never leaked.

### `GET /v1/events` — paginated list, most recent first

```bash
curl -s "http://localhost:3000/v1/events?limit=20&offset=0" -H "Authorization: Bearer $API_KEY"
```

```json
{ "events": [ /* ... */ ], "total": 1, "limit": 20, "offset": 0 }
```

### `/v1/dashboard/*` — the dashboard's own routes

Authenticated by `Authorization: Bearer <supabase-access-token>` instead of an API key (`middleware/supabase-auth.ts`, verified against Supabase's `/auth/v1/user` REST endpoint). CORS is enabled only for this prefix, allowlisted via `DASHBOARD_ORIGIN`.

| Route | Notes |
|---|---|
| `POST /v1/dashboard/signup` | Idempotent: creates a tenant + first API key for this Supabase user if none exists yet; the raw key is only ever present in this response (first call) or a regenerate call — never again after. |
| `GET /v1/dashboard/me` | Tenant + masked API key metadata (`ntfy_••••••••ab12`, `createdAt`, `lastUsedAt`). 404 if signup hasn't run yet for this account. |
| `POST /v1/dashboard/api-key/regenerate` | Revokes the active key, mints a new one, returns the new raw key once. |
| `GET /v1/dashboard/events` / `GET /v1/dashboard/events/:id` | Same pagination/404 semantics as `/v1/events*`, scoped to the session's tenant instead of a header-supplied key. |

## Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Use Supabase's **connection pooler** string (`aws-*.pooler.supabase.com`), not the direct `db.*.supabase.co` host — the direct host is IPv6-only and unreachable from many networks. Used by `migrate`/`seed`/vitest, and as the `[[hyperdrive]] localConnectionString` in `wrangler.local.toml` for local `wrangler dev`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | Any SMTP provider works — Gmail (with an App Password) or a free tier like Brevo (300/day). In deployed `apps/api`, `SMTP_USER`/`SMTP_PASS` are Worker secrets (`wrangler secret put`); the rest are plain `[vars]` in `wrangler.toml`. |
| `NOTIFY_FROM_EMAIL` | The `From` address the scheduled handler sends as. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard's own Supabase client, from Supabase → Project Settings → API. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Same Supabase project, read by `apps/api` (as Worker `[vars]`) to verify dashboard session tokens. |
| `NEXT_PUBLIC_API_URL` | Base URL of `apps/api`, called directly from the dashboard's browser code. |
| `DASHBOARD_ORIGIN` | Comma-separated CORS allowlist for `/v1/dashboard/*` — the dashboard's own origin(s). |

The dashboard reads its env vars from the monorepo-root `.env` (loaded via `dotenv` in `apps/dashboard/next.config.ts`), not a dashboard-local `.env.local`. `apps/api` is a Cloudflare Worker, so it does **not** read root `.env` at runtime — its config lives in `wrangler.toml` (`[vars]`, committed, no secrets) and `wrangler secret put` (deployed secrets) or `apps/api/.dev.vars` / `apps/api/wrangler.local.toml` (local dev, both gitignored). `migrate.ts`/`seed.ts`/vitest are plain Node scripts and still read root `.env` the old way.

**Note:** this project's Supabase Auth currently has "Confirm email" disabled, so signup returns a usable session immediately — the dashboard's signup page still handles the confirmation-required case (Supabase Dashboard → Authentication → Providers → Email) if it's re-enabled before production.

## Scripts

Run from the repo root unless noted:

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm typecheck` | `tsc --noEmit` across every app/package |
| `pnpm lint` | ESLint across `apps/api`, `packages/*`, plus the dashboard's own ESLint config |
| `pnpm format` / `pnpm format:check` | Prettier write / check across the repo |
| `pnpm dev:api` | `wrangler dev` for `apps/api` (needs a `-c wrangler.local.toml` override for local secrets — see Getting started) |
| `pnpm dev:dashboard` | Run the dashboard in dev mode |
| `pnpm deploy:api` | `wrangler deploy` — deploys `apps/api` to Cloudflare |
| `pnpm --filter @notify-engine/api run test` | Vitest integration tests for `/v1/events*`, `/v1/dashboard/*`, and scheduled job processing (hits the real DB, Supabase Auth, and sends a real email over SMTP — see [Environment variables](#environment-variables)) |
| `pnpm --filter @notify-engine/db run generate` | Generate a new Drizzle migration from schema changes |
| `pnpm --filter @notify-engine/db run migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm --filter @notify-engine/db run seed` | Create a test tenant + API key |

## Architecture & decisions

- [`docs/phase-1/design.md`](docs/phase-1/design.md) — components, data model, request flow.
- [`docs/phase-1/architecture-diagram.md`](docs/phase-1/architecture-diagram.md) — mermaid diagram.
- [`docs/phase-1/decisions.md`](docs/phase-1/decisions.md) — ADR log, currently covering: Postgres-backed queue over a broker, idempotency via a unique constraint enforced as a 409, layered service architecture, tenant scoping at the schema level, Nodemailer over Resend, `tenant_id` column over schema-per-tenant, Postgres `jobs` table over Redis, exponential backoff retry capped at 5 attempts with a non-retryable path for invalid payloads, tenant↔Supabase Auth linking via `auth_user_id` with a parallel dashboard auth scope, API keys shown in full only once, CORS scoped only to `/v1/dashboard/*`, migrating off VM/Docker onto a single Cloudflare Worker, Hyperdrive instead of a direct Postgres connection, Cron Trigger job processing (once-a-minute latency tradeoff), and keeping Nodemailer running in-Worker via `nodejs_compat` instead of switching providers.

## Roadmap

Phase 1 subphases, updated as work lands:

- [x] **1a** — monorepo scaffold, tooling (TypeScript, ESLint, Prettier), runnable empty `api`/`worker`/`dashboard`
- [x] **1b** — core schema in `packages/db`
- [x] **1c** — API routes: auth by API key, `POST /v1/events`, `GET /v1/events`, `GET /v1/events/:id`, idempotency-as-409
- [x] **1d** — worker: claim jobs, send email via Nodemailer, record deliveries, retry with backoff and dead-letter on exhaustion
- [x] **1e** — dashboard: sign up/login via Supabase Auth, view + regenerate API key, browse notification events with delivery detail
- [x] **1f** — migrate `apps/api` + `apps/worker` off Docker/VM onto a single Cloudflare Worker: Fastify → Hono, Hyperdrive instead of a direct Postgres connection, Cron Trigger job processing instead of a polling process (this README's current state)

> This README is kept up to date as each subphase lands — check the Roadmap above for current status.
