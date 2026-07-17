import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { db, client, tenants, apiKeys, notificationEvents, jobs } from "@notify-engine/db";
import { generateApiKey, hashApiKey } from "@notify-engine/shared";
import { buildApp } from "../src/app.js";
import { testEnv } from "./test-env.js";
import type { AppEnv } from "../src/types.js";

describe("POST /v1/events integration", () => {
  let app: Hono<AppEnv>;
  const env = testEnv();
  let tenantAId: string;
  let tenantBId: string;
  let tenantARawKey: string;
  let tenantBRawKey: string;

  beforeAll(async () => {
    app = buildApp();

    const suffix = randomUUID();

    const [tenantA] = await db
      .insert(tenants)
      .values({ name: `Test Tenant A ${suffix}` })
      .returning();
    const [tenantB] = await db
      .insert(tenants)
      .values({ name: `Test Tenant B ${suffix}` })
      .returning();

    if (!tenantA || !tenantB) {
      throw new Error("Failed to seed test tenants");
    }

    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    tenantARawKey = generateApiKey();
    tenantBRawKey = generateApiKey();

    await db.insert(apiKeys).values([
      { tenantId: tenantAId, keyHash: hashApiKey(tenantARawKey) },
      { tenantId: tenantBId, keyHash: hashApiKey(tenantBRawKey) },
    ]);
  });

  afterAll(async () => {
    await db.delete(jobs).where(inArray(jobs.tenantId, [tenantAId, tenantBId]));
    await db.delete(notificationEvents).where(inArray(notificationEvents.tenantId, [tenantAId, tenantBId]));
    await db.delete(apiKeys).where(inArray(apiKeys.tenantId, [tenantAId, tenantBId]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantAId, tenantBId]));

    await client.end();
  });

  it("creates an event and a queued job for a valid request", async () => {
    const idempotencyKey = `test-${randomUUID()}`;

    const response = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { authorization: `Bearer ${tenantARawKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          event_type: "user.signup",
          payload: { email: "user@example.com" },
        }),
      },
      env,
    );

    expect(response.status).toBe(201);

    const body = await response.json<any>();
    expect(body.id).toBeDefined();
    expect(body.status).toBe("pending");
    expect(body.idempotencyKey).toBe(idempotencyKey);

    const [job] = await db.select().from(jobs).where(eq(jobs.eventId, body.id));
    expect(job).toBeDefined();
    expect(job?.status).toBe("queued");
  });

  it("rejects a duplicate idempotency key for the same tenant with a conflict, without creating a duplicate", async () => {
    const idempotencyKey = `test-dup-${randomUUID()}`;
    const payload = {
      idempotency_key: idempotencyKey,
      event_type: "user.signup",
      payload: { email: "dup@example.com" },
    };

    const first = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { authorization: `Bearer ${tenantARawKey}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(first.status).toBe(201);

    const second = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { authorization: `Bearer ${tenantARawKey}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(second.status).toBe(409);

    const rows = await db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.idempotencyKey, idempotencyKey));
    expect(rows).toHaveLength(1);
  });

  it("rejects an invalid API key with 401", async () => {
    const response = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { authorization: "Bearer not-a-real-key", "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: `test-${randomUUID()}`,
          event_type: "user.signup",
          payload: {},
        }),
      },
      env,
    );

    expect(response.status).toBe(401);
  });

  it("returns 404 for another tenant's event", async () => {
    const createResponse = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { authorization: `Bearer ${tenantARawKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: `test-${randomUUID()}`,
          event_type: "user.signup",
          payload: {},
        }),
      },
      env,
    );
    const created = await createResponse.json<any>();

    const response = await app.request(
      `/v1/events/${created.id}`,
      { headers: { authorization: `Bearer ${tenantBRawKey}` } },
      env,
    );

    expect(response.status).toBe(404);
  });
});
