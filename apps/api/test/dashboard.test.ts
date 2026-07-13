import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, client, tenants } from "@notify-engine/db";
import { buildApp } from "../src/app.js";

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseAnonKey = process.env["SUPABASE_ANON_KEY"];

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required for this test");
}

async function signUpNewUser() {
  const email = `notifyengine.test.${Date.now()}.${randomUUID()}@gmail.com`;
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: supabaseAnonKey ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "TestPassword123!" }),
  });
  const body = (await response.json()) as { access_token?: string; user?: { id: string } };

  if (!response.ok || !body.access_token || !body.user) {
    throw new Error(
      `Test setup requires Supabase email confirmation to be disabled for this project: ${JSON.stringify(body)}`,
    );
  }

  return { userId: body.user.id, accessToken: body.access_token };
}

describe("/v1/dashboard integration", () => {
  let app: FastifyInstance;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
    }

    await app.close();
    await client.end();
  });

  it("rejects requests with no session token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/dashboard/me" });
    expect(response.statusCode).toBe(401);
  });

  it("allows cross-origin requests from the configured dashboard origin", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/dashboard/me",
      headers: {
        origin: "http://localhost:3001",
        "access-control-request-method": "GET",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
  });

  it("does not reflect an arbitrary, non-allowlisted origin", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/dashboard/me",
      headers: {
        origin: "http://evil.example.com",
        "access-control-request-method": "GET",
      },
    });

    expect(response.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });

  it("rejects requests with a garbage session token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/dashboard/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("signup creates a tenant and returns a raw API key once, then is idempotent on repeat calls", async () => {
    const { accessToken } = await signUpNewUser();

    const first = await app.inject({
      method: "POST",
      url: "/v1/dashboard/signup",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Test Co" },
    });

    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.tenant.id).toBeDefined();
    expect(typeof firstBody.apiKey).toBe("string");
    expect(firstBody.apiKey.startsWith("ntfy_")).toBe(true);

    createdTenantIds.push(firstBody.tenant.id);

    const second = await app.inject({
      method: "POST",
      url: "/v1/dashboard/signup",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Test Co" },
    });

    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.tenant.id).toBe(firstBody.tenant.id);
    expect(secondBody.apiKey).toBeNull();
  });

  it("me returns the tenant and masked key metadata after signup", async () => {
    const { accessToken } = await signUpNewUser();

    const signup = await app.inject({
      method: "POST",
      url: "/v1/dashboard/signup",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    createdTenantIds.push(signup.json().tenant.id);

    const response = await app.inject({
      method: "GET",
      url: "/v1/dashboard/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tenant.id).toBe(signup.json().tenant.id);
    expect(body.apiKey.masked).toMatch(/^ntfy_.*[0-9a-zA-Z_-]{4}$/);
    expect(body.apiKey.masked).not.toBe(signup.json().apiKey);
  });

  it("me returns 404 before signup has ever run for this account", async () => {
    const { accessToken } = await signUpNewUser();

    const response = await app.inject({
      method: "GET",
      url: "/v1/dashboard/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("regenerating the API key revokes the old one and returns a new raw key", async () => {
    const { accessToken } = await signUpNewUser();

    const signup = await app.inject({
      method: "POST",
      url: "/v1/dashboard/signup",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    createdTenantIds.push(signup.json().tenant.id);
    const originalKey = signup.json().apiKey;

    const regenerate = await app.inject({
      method: "POST",
      url: "/v1/dashboard/api-key/regenerate",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(regenerate.statusCode).toBe(200);
    const newKey = regenerate.json().apiKey;
    expect(newKey).not.toBe(originalKey);

    const usingOldKey = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${originalKey}` },
      payload: { idempotency_key: `test-${randomUUID()}`, event_type: "user.signup", payload: {} },
    });
    expect(usingOldKey.statusCode).toBe(401);

    const usingNewKey = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${newKey}` },
      payload: { idempotency_key: `test-${randomUUID()}`, event_type: "user.signup", payload: {} },
    });
    expect(usingNewKey.statusCode).toBe(201);
  });

  it("dashboard events endpoints reflect events created via the tenant's own API key", async () => {
    const { accessToken } = await signUpNewUser();

    const signup = await app.inject({
      method: "POST",
      url: "/v1/dashboard/signup",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    createdTenantIds.push(signup.json().tenant.id);
    const rawKey = signup.json().apiKey;

    const created = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        idempotency_key: `test-${randomUUID()}`,
        event_type: "user.signup",
        payload: { to: "user@example.com", subject: "hi", body: "hi" },
      },
    });
    expect(created.statusCode).toBe(201);
    const eventId = created.json().id;

    const list = await app.inject({
      method: "GET",
      url: "/v1/dashboard/events",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json();
    expect(listBody.events.some((event: { id: string }) => event.id === eventId)).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/dashboard/events/${eventId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(eventId);
    expect(Array.isArray(detail.json().deliveries)).toBe(true);
  });

  it("another tenant's dashboard session cannot see this tenant's event", async () => {
    const owner = await signUpNewUser();
    const outsider = await signUpNewUser();

    const ownerSignup = await app.inject({
      method: "POST",
      url: "/v1/dashboard/signup",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {},
    });
    createdTenantIds.push(ownerSignup.json().tenant.id);

    const outsiderSignup = await app.inject({
      method: "POST",
      url: "/v1/dashboard/signup",
      headers: { authorization: `Bearer ${outsider.accessToken}` },
      payload: {},
    });
    createdTenantIds.push(outsiderSignup.json().tenant.id);

    const created = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${ownerSignup.json().apiKey}` },
      payload: { idempotency_key: `test-${randomUUID()}`, event_type: "user.signup", payload: {} },
    });
    const eventId = created.json().id;

    const response = await app.inject({
      method: "GET",
      url: `/v1/dashboard/events/${eventId}`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });

    expect(response.statusCode).toBe(404);
  });
});
