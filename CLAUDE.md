# Notify Engine — agent instructions

Multi-tenant notification infrastructure. Developers integrate via API key to trigger notifications (starting with email) to their own users, similar in shape to Novu or Courier. This file is read automatically at the start of every session in this repo — treat it as binding unless the user says otherwise in the conversation.

## Stack

- Language: TypeScript everywhere, strict mode on
- Runtime: Node.js 20+
- API framework: Fastify 5
- Database: Postgres via Supabase
- ORM/query layer: Drizzle ORM + drizzle-kit
- Validation: Zod
- Queue (phase 1): Postgres `jobs` table, `SELECT ... FOR UPDATE SKIP LOCKED` — no Redis/broker
- Email provider: Nodemailer over SMTP (provider-agnostic — not Resend, see ADR-005)
- Dashboard: Next.js (App Router), deployed to Cloudflare Pages
- Auth (dashboard): Supabase Auth
- Package manager: pnpm workspaces (monorepo)
- Deployment (API + worker): Docker Compose on Oracle Cloud free-tier VM
- Load testing: k6 (not part of phase 1 build)
- Logging: pino, structured — never `console.log`
- Linting/formatting: ESLint 9 flat config + typescript-eslint + Prettier (`eslint-config-prettier` kills stylistic conflicts). Dashboard keeps its own Next-managed ESLint config rather than the root one.

## Folder structure

```
apps/
  api/              Fastify backend
  worker/           background job processor
  dashboard/        Next.js frontend
packages/
  db/               Drizzle schema, migrations, DB client, seed script
  shared/           Zod schemas, constants, status enums, API-key hashing — reused by api and worker
  queue/            queue abstraction (Postgres-backed now, swappable later)
docs/
  phase-1/
    design.md                target architecture, kept in sync with what's actually implemented
    architecture-diagram.md  mermaid diagram
    decisions.md             ADR-style entries, numbered sequentially
infra/
  docker-compose.yml, Dockerfile.api, Dockerfile.worker
load-tests/
  k6-scripts/
assets/
  logo.svg          README wordmark
```

## Non-negotiable practices

- Multi-tenant from the schema up. Every table that holds tenant data has a `tenant_id` column, `NOT NULL`. Every query is scoped by `tenant_id`, no exceptions, even during single-tenant local testing.
- Layered architecture: route handlers stay thin, business logic lives in a service layer (`apps/*/src/services`), and the service layer is the *only* thing that talks to `packages/db`. Never query the DB directly from a route handler.
- All schema changes go through Drizzle migrations (`pnpm --filter @notify-engine/db run generate`, then `run migrate`). No manual schema edits.
- Structured logging (pino) from the first line of backend code.
- Idempotency keys required on any endpoint that creates a notification event; duplicates return **409 Conflict**, not a silent 200/201 replay (see ADR-002) — no exceptions unless a future ADR explicitly changes this.
- Every meaningful architectural choice gets a short ADR entry in `docs/phase-1/decisions.md`: **Context / Decision / Consequences**, three to five sentences each, numbered `ADR-00N` sequentially. Do this without being asked whenever a non-obvious technical choice is made (e.g. picking one library/pattern over an alternative).
- No premature abstraction. Build only what the current subphase asks for. Do not add caching, Redis, rate limiting, multi-region, notification templates/preferences, or worker send logic until the phase that calls for it explicitly says so.
- Input validation and cross-app types (Zod schemas, status enums, API-key hashing) live in `packages/shared` and get imported by both `apps/api` and `apps/worker` — don't duplicate a schema or a hash function in two apps.

## Testing

- Integration tests, not mocked unit tests — hit the real Supabase DB configured in `.env` (see `apps/api/test/events.test.ts` for the pattern: seed throwaway tenants/keys in `beforeAll`, clean them up in `afterAll`, use Fastify's `app.inject()` rather than a bound port).
- Every subphase that adds an endpoint or a meaningful service function should get integration test coverage for its happy path and its documented failure modes (auth rejection, not-found/cross-tenant, conflict) before being called done.
- Before considering any change complete: `pnpm -r run typecheck`, `pnpm run lint`, and the relevant `pnpm --filter <pkg> run test` must all pass. For anything with a runtime surface (new endpoint, new script), also actually run it — start the dev server and curl it, or run the script against the real DB — and show the output. Don't claim something works from reading the code alone.

## Database / environment gotchas

- Supabase's **direct** connection host (`db.<ref>.supabase.co`) is IPv6-only and unreachable from many networks/CI. Always use the **session pooler** string (`aws-*.pooler.supabase.com`) for `DATABASE_URL`.
- `.env` is git-ignored and must never be committed — verify with `git status`/`git check-ignore` before staging when in doubt. `.env.example` holds placeholder shapes only, no real credentials.
- `packages/db/src/env.ts` loads the repo-root `.env` relative to the compiled/executed file location, so scripts run correctly regardless of the invoking `cwd`. `drizzle.config.ts` loads it separately (drizzle-kit's own loader can't resolve the `.js`-suffixed sibling import), via `resolve(process.cwd(), "../../.env")` — keep that in sync if the config file moves.

## Git conventions

- Commit messages: **single-line**, describe the "why"/what shipped, no AI attribution or co-authorship trailer — this project's commits stay clean of tool traces.
- Only commit/push when explicitly asked. When asked, stage precisely (avoid `git add -A` sweeping in stray files — check `git status` first), and never commit `.env` or other secrets.
- Create a new commit rather than amending, per default git safety rules.

## Docs maintenance

- `README.md` is living documentation — update it (Status line, Roadmap checklist, relevant sections) every time a subphase lands, without being asked. It's the single source of truth for "what's done" — don't let it drift from the code.
- `docs/phase-1/design.md` describes target architecture; when an implementation detail changes from what the doc says (endpoint path, status code, header format, etc.), fix the doc in the same piece of work, not later.
- Roadmap / subphase status: check `README.md`'s Roadmap section for current phase status rather than assuming — it's kept current there, not duplicated here.

## Scope discipline

Each subphase's prompt has an explicit "Do not" list — treat it as a hard boundary, not a suggestion. If a "Do not" item and a "non-negotiable practice" above appear to conflict for a specific table/endpoint (e.g. a spec's column list omits `tenant_id` on a table that holds tenant data), follow the non-negotiable practice and flag the deviation explicitly in the response rather than silently picking one.
