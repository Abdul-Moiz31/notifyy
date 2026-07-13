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
