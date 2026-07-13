<p align="center">
  <img src="assets/logo.svg" alt="Notify Engine" width="440" />
</p>

<p align="center">
  Multi-tenant notification infrastructure. Developers integrate via API key to trigger notifications — starting with email — to their own users. Built in the shape of Novu or Courier.
</p>

<p align="center">
  <strong>Status:</strong> Phase 1, subphase 1c complete (API routes) · subphase 1d (worker sending) not started yet
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
  api/            Fastify backend — /health plus /v1/events (create, get, list), API-key auth
  worker/         background job processor — logs startup and stays alive so far, sending lands in subphase 1d
  dashboard/      Next.js frontend (default App Router scaffold)
packages/
  db/             Drizzle schema, migrations, DB client, seed script
  shared/         Zod schemas, status enums, API key hashing — reused by apps/api now, apps/worker in 1d
  queue/          Postgres-backed queue abstraction (scaffolded, not populated yet)
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

- **`tenants`** — one row per developer/organization.
- **`api_keys`** — `key_hash` only (the raw key is never stored), scoped to a tenant, indexed for fast lookup, `revoked_at` for revocation.
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
pnpm dev:api        # Fastify on http://localhost:3000, GET /health
pnpm dev:worker      # logs "worker started" and stays alive
pnpm dev:dashboard  # Next.js default page
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

A matching `jobs` row (`status: "queued"`) is created in the same transaction. Repeating the same `idempotency_key` for the same tenant returns **409 Conflict** and creates nothing new. An invalid or revoked API key returns **401**.

### `GET /v1/events/:id` — fetch one event, scoped to the caller's tenant

```bash
curl -s http://localhost:3000/v1/events/$EVENT_ID -H "Authorization: Bearer $API_KEY"
```

Returns the event plus its `deliveries` array (empty until subphase 1d sends anything). An id that doesn't exist — or that belongs to a different tenant — returns **404** in both cases, so tenant existence is never leaked.

### `GET /v1/events` — paginated list, most recent first

```bash
curl -s "http://localhost:3000/v1/events?limit=20&offset=0" -H "Authorization: Bearer $API_KEY"
```

```json
{ "events": [ /* ... */ ], "total": 1, "limit": 20, "offset": 0 }
```

## Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Use Supabase's **connection pooler** string (`aws-*.pooler.supabase.com`), not the direct `db.*.supabase.co` host — the direct host is IPv6-only and unreachable from many networks. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | Any SMTP provider works — Gmail (with an App Password) or a free tier like Brevo (300/day). |
| `NOTIFY_FROM_EMAIL` | The `From` address the worker sends as. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard auth, from Supabase → Project Settings → API. |

## Scripts

Run from the repo root unless noted:

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm typecheck` | `tsc --noEmit` across every app/package |
| `pnpm lint` | ESLint across `apps/api`, `apps/worker`, `packages/*`, plus `next lint` for the dashboard |
| `pnpm format` / `pnpm format:check` | Prettier write / check across the repo |
| `pnpm dev:api` / `dev:worker` / `dev:dashboard` | Run one app in dev mode |
| `pnpm --filter @notify-engine/api run test` | Vitest integration tests for `/v1/events` (hits the real DB, see [Environment variables](#environment-variables)) |
| `pnpm --filter @notify-engine/db run generate` | Generate a new Drizzle migration from schema changes |
| `pnpm --filter @notify-engine/db run migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm --filter @notify-engine/db run seed` | Create a test tenant + API key |

## Architecture & decisions

- [`docs/phase-1/design.md`](docs/phase-1/design.md) — components, data model, request flow.
- [`docs/phase-1/architecture-diagram.md`](docs/phase-1/architecture-diagram.md) — mermaid diagram.
- [`docs/phase-1/decisions.md`](docs/phase-1/decisions.md) — ADR log, currently covering: Postgres-backed queue over a broker, idempotency via a unique constraint enforced as a 409, layered service architecture, tenant scoping at the schema level, Nodemailer over Resend, `tenant_id` column over schema-per-tenant, and Postgres `jobs` table over Redis.

## Roadmap

Phase 1 subphases, updated as work lands:

- [x] **1a** — monorepo scaffold, tooling (TypeScript, ESLint, Prettier), runnable empty `api`/`worker`/`dashboard`
- [x] **1b** — core schema in `packages/db`
- [x] **1c** — API routes: auth by API key, `POST /v1/events`, `GET /v1/events`, `GET /v1/events/:id`, idempotency-as-409 (this README's current state)
- [ ] **1d** — worker: claim jobs, send email via Nodemailer, record deliveries
- [ ] **1e** — dashboard: view API keys and notification history

> This README is kept up to date as each subphase lands — check the Roadmap above for current status.
