<p align="center">
  <img src="assets/logo.svg" alt="Notify Engine" width="440" />
</p>

<p align="center">
  Multi-tenant notification infrastructure. Developers integrate via API key to trigger notifications — starting with email — to their own users. Built in the shape of Novu or Courier.
</p>

<p align="center">
  <strong>Status:</strong> Phase 1, subphase 1b complete (schema) · subphase 1c (API routes) not started yet
</p>

---

## Table of contents

- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Data model](#data-model)
- [Getting started](#getting-started)
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
  api/            Fastify backend — GET /health only so far, routes land in subphase 1c
  worker/         background job processor — logs startup and stays alive so far
  dashboard/      Next.js frontend (default App Router scaffold)
packages/
  db/             Drizzle schema, migrations, DB client, seed script
  shared/         shared types, Zod schemas, constants (scaffolded, not populated yet)
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
| `pnpm --filter @notify-engine/db run generate` | Generate a new Drizzle migration from schema changes |
| `pnpm --filter @notify-engine/db run migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm --filter @notify-engine/db run seed` | Create a test tenant + API key |

## Architecture & decisions

- [`docs/phase-1/design.md`](docs/phase-1/design.md) — components, data model, request flow.
- [`docs/phase-1/architecture-diagram.md`](docs/phase-1/architecture-diagram.md) — mermaid diagram.
- [`docs/phase-1/decisions.md`](docs/phase-1/decisions.md) — ADR log, currently covering: Postgres-backed queue over a broker, idempotency via a unique constraint, layered service architecture, tenant scoping at the schema level, Nodemailer over Resend, `tenant_id` column over schema-per-tenant, and Postgres `jobs` table over Redis.

## Roadmap

Phase 1 subphases, updated as work lands:

- [x] **1a** — monorepo scaffold, tooling (TypeScript, ESLint, Prettier), runnable empty `api`/`worker`/`dashboard`
- [x] **1b** — core schema in `packages/db` (this README's current state)
- [ ] **1c** — API routes: auth by API key, `POST /v1/notification-events`, idempotency handling
- [ ] **1d** — worker: claim jobs, send email via Nodemailer, record deliveries
- [ ] **1e** — dashboard: view API keys and notification history

> This README is kept up to date as each subphase lands — check the Roadmap above for current status.
