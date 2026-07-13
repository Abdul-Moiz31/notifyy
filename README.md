<p align="center">
  <img src="assets/logo.svg" alt="Notify Engine" width="440" />
</p>

<p align="center">
  Multi-tenant notification infrastructure. Developers integrate via API key to trigger notifications — starting with email — to their own users. Built in the shape of Novu or Courier.
</p>

<p align="center">
  <strong>Status:</strong> Phase 1, subphase 1e complete (dashboard: sign up via Supabase Auth, view/regenerate API key, browse notification events with delivery detail)
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
| Runtime | Node.js 20+ |
| API framework | [Fastify](https://fastify.dev) 5 |
| Database | Postgres via [Supabase](https://supabase.com) |
| ORM / query layer | [Drizzle ORM](https://orm.drizzle.team) + `drizzle-kit` |
| Validation | [Zod](https://zod.dev) |
| Queue (phase 1) | Postgres `jobs` table, `SELECT ... FOR UPDATE SKIP LOCKED` — no Redis/broker yet |
| Email delivery | [Nodemailer](https://nodemailer.com) over SMTP (provider-agnostic — Gmail, Brevo, etc.) |
| Dashboard | [Next.js](https://nextjs.org) 16, App Router, deployed to Cloudflare Pages |
| Dashboard auth | Supabase Auth |
| Logging | [pino](https://getpino.io), structured, no `console.log` |
| Package manager | pnpm workspaces (monorepo) |
| Linting / formatting | ESLint 9 (flat config) + `typescript-eslint` + Prettier, `eslint-config-prettier` to avoid rule conflicts |
| Deployment (API + worker) | Docker Compose on an Oracle Cloud free-tier VM |
| Load testing | [k6](https://k6.io) (not part of the phase 1 build) |

## Project structure

```
apps/
  api/            Fastify backend — /health, /v1/events* (API-key auth), /v1/dashboard/* (Supabase-session auth)
  worker/         polls jobs, sends email via Nodemailer/SMTP, records deliveries, retries with backoff
  dashboard/      Next.js app — sign up/login (Supabase Auth), API key, notification event log
packages/
  db/             Drizzle schema, migrations, DB client, seed script
  shared/         Zod schemas, status enums, API key hashing — reused by apps/api and apps/worker
  queue/          Postgres-backed queue abstraction (`PgQueue`: enqueue, claimNext) — the only thing that touches `jobs` directly
docs/
  phase-1/
    design.md               target architecture for phase 1
    architecture-diagram.md mermaid diagram of the request/delivery flow
    decisions.md            ADR-style log of every non-obvious architectural choice
infra/
  docker-compose.yml   api + worker services
  Dockerfile.api
  Dockerfile.worker
load-tests/
  k6-scripts/     empty for now, phase 1 doesn't need load testing yet
```

## Data model

Defined in `packages/db/src/schema.ts`, migrated via Drizzle:

- **`tenants`** — one row per developer/organization; `auth_user_id` links a tenant to the Supabase Auth user who owns it in the dashboard (nullable — the seed script's tenant has none).
- **`api_keys`** — `key_hash` only (the raw key is never stored), scoped to a tenant, indexed for fast lookup, `revoked_at` for revocation. `last_four` (non-secret) powers the dashboard's masked display.
- **`notification_events`** — one row per triggered event; `UNIQUE (tenant_id, idempotency_key)` rejects duplicate retries at the database level. `status`: `pending → processing → sent | failed | dead_letter`.
- **`deliveries`** — one row per delivery attempt on a channel (`email` for now) for an event; tracks `provider_message_id`, `attempt_count`, `error_message`.
- **`jobs`** — the phase 1 queue. `status`: `queued → locked → done | failed`, with `locked_by`/`locked_at` and `run_after` for backoff. Indexed on `(status, run_after)` since the worker polls this constantly.

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

### Run the apps

```bash
pnpm dev:api        # Fastify on http://localhost:3000
pnpm dev:worker     # polls jobs and sends email via SMTP
pnpm dev:dashboard  # Next.js — runs on :3000 by default; if apps/api already holds :3000,
                    # run it on another port (e.g. `pnpm --filter @notify-engine/dashboard exec next dev -p 3001`)
                    # and update DASHBOARD_ORIGIN / NEXT_PUBLIC_API_URL to match.
```

Open the dashboard, sign up with an email/password (Supabase Auth) — you're dropped straight onto `/dashboard` with a freshly issued API key shown once. From there, `/dashboard/events` shows every event triggered on that key, with delivery attempts on expand.

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

For the worker to actually deliver the event, `payload` must include `to` (a valid email), `subject`, and `body` — the worker validates this shape (`emailNotificationPayloadSchema` in `packages/shared`) before sending. A payload missing any of these fails validation and the event goes straight to `dead_letter` without retrying.

### `GET /v1/events/:id` — fetch one event, scoped to the caller's tenant

```bash
curl -s http://localhost:3000/v1/events/$EVENT_ID -H "Authorization: Bearer $API_KEY"
```

Returns the event plus its `deliveries` array — populated once the worker has attempted (or completed) delivery. An id that doesn't exist — or that belongs to a different tenant — returns **404** in both cases, so tenant existence is never leaked.

### `GET /v1/events` — paginated list, most recent first

```bash
curl -s "http://localhost:3000/v1/events?limit=20&offset=0" -H "Authorization: Bearer $API_KEY"
```

```json
{ "events": [ /* ... */ ], "total": 1, "limit": 20, "offset": 0 }
```

### `/v1/dashboard/*` — the dashboard's own routes

Authenticated by `Authorization: Bearer <supabase-access-token>` instead of an API key (`plugins/supabase-auth.ts`, verified against Supabase's `/auth/v1/user` REST endpoint). CORS is enabled only for this prefix, allowlisted via `DASHBOARD_ORIGIN`.

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
| `DATABASE_URL` | Use Supabase's **connection pooler** string (`aws-*.pooler.supabase.com`), not the direct `db.*.supabase.co` host — the direct host is IPv6-only and unreachable from many networks. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | Any SMTP provider works — Gmail (with an App Password) or a free tier like Brevo (300/day). |
| `NOTIFY_FROM_EMAIL` | The `From` address the worker sends as. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard's own Supabase client, from Supabase → Project Settings → API. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Same Supabase project, read server-side by `apps/api` to verify dashboard session tokens. |
| `NEXT_PUBLIC_API_URL` | Base URL of `apps/api`, called directly from the dashboard's browser code. |
| `DASHBOARD_ORIGIN` | Comma-separated CORS allowlist for `/v1/dashboard/*` — the dashboard's own origin(s). |

The dashboard reads its env vars from the monorepo-root `.env` (loaded via `dotenv` in `apps/dashboard/next.config.ts`), not a dashboard-local `.env.local`.

**Note:** this project's Supabase Auth currently has "Confirm email" disabled, so signup returns a usable session immediately — the dashboard's signup page still handles the confirmation-required case (Supabase Dashboard → Authentication → Providers → Email) if it's re-enabled before production.

## Scripts

Run from the repo root unless noted:

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm typecheck` | `tsc --noEmit` across every app/package |
| `pnpm lint` | ESLint across `apps/api`, `apps/worker`, `packages/*`, plus the dashboard's own ESLint config |
| `pnpm format` / `pnpm format:check` | Prettier write / check across the repo |
| `pnpm dev:api` / `dev:worker` / `dev:dashboard` | Run one app in dev mode |
| `pnpm --filter @notify-engine/api run test` | Vitest integration tests for `/v1/events*` and `/v1/dashboard/*` (hits the real DB and Supabase Auth, see [Environment variables](#environment-variables)) |
| `pnpm --filter @notify-engine/worker run test` | Vitest integration tests for the worker — hits the real DB and sends a real email over SMTP |
| `pnpm --filter @notify-engine/db run generate` | Generate a new Drizzle migration from schema changes |
| `pnpm --filter @notify-engine/db run migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm --filter @notify-engine/db run seed` | Create a test tenant + API key |

## Architecture & decisions

- [`docs/phase-1/design.md`](docs/phase-1/design.md) — components, data model, request flow.
- [`docs/phase-1/architecture-diagram.md`](docs/phase-1/architecture-diagram.md) — mermaid diagram.
- [`docs/phase-1/decisions.md`](docs/phase-1/decisions.md) — ADR log, currently covering: Postgres-backed queue over a broker, idempotency via a unique constraint enforced as a 409, layered service architecture, tenant scoping at the schema level, Nodemailer over Resend, `tenant_id` column over schema-per-tenant, Postgres `jobs` table over Redis, exponential backoff retry capped at 5 attempts with a non-retryable path for invalid payloads, tenant↔Supabase Auth linking via `auth_user_id` with a parallel dashboard auth scope, API keys shown in full only once, and CORS scoped only to `/v1/dashboard/*`.

## Roadmap

Phase 1 subphases, updated as work lands:

- [x] **1a** — monorepo scaffold, tooling (TypeScript, ESLint, Prettier), runnable empty `api`/`worker`/`dashboard`
- [x] **1b** — core schema in `packages/db`
- [x] **1c** — API routes: auth by API key, `POST /v1/events`, `GET /v1/events`, `GET /v1/events/:id`, idempotency-as-409
- [x] **1d** — worker: claim jobs, send email via Nodemailer, record deliveries, retry with backoff and dead-letter on exhaustion
- [x] **1e** — dashboard: sign up/login via Supabase Auth, view + regenerate API key, browse notification events with delivery detail (this README's current state)

> This README is kept up to date as each subphase lands — check the Roadmap above for current status.
