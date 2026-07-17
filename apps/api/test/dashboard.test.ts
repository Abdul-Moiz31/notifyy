import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { db, client, tenants } from "@notify-engine/db";
import { buildApp } from "../src/app.js";
import { testEnv } from "./test-env.js";
import type { AppEnv } from "../src/types.js";

const env = testEnv();

async function signUpNewUser() {
  const email = `notifyengine.test.${Date.now()}.${randomUUID()}@gmail.com`;
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "TestPassword123!" }),
  });
  const body = (await response.json<any>()) as { access_token?: string; user?: { id: string } };

  if (!response.ok || !body.access_token || !body.user) {
    throw new Error(
      `Test setup requires Supabase email confirmation to be disabled for this project: ${JSON.stringify(body)}`,
    );
  }

  return { userId: body.user.id, accessToken: body.access_token };
}

describe("/v1/dashboard integration", () => {
  let app: Hono<AppEnv>;
  const createdTenantIds: string[] = [];

  beforeAll(() => {
    app = buildApp();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
    }

    await client.end();
  });

  it("rejects requests with no session token", async () => {
    const response = await app.request("/v1/dashboard/me", {}, env);
    expect(response.status).toBe(401);
  });

  it("rejects requests with a garbage session token", async () => {
    const response = await app.request(
      "/v1/dashboard/me",
      { headers: { authorization: "Bearer not-a-real-token" } },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("allows cross-origin requests from the configured dashboard origin", async () => {
    const response = await app.request(
      "/v1/dashboard/me",
      {
        method: "OPTIONS",
        headers: { origin: env.DASHBOARD_ORIGIN, "access-control-request-method": "GET" },
      },
      env,
    );

    expect(response.headers.get("access-control-allow-origin")).toBe(env.DASHBOARD_ORIGIN);
  });

  it("does not reflect an arbitrary, non-allowlisted origin", async () => {
    const response = await app.request(
      "/v1/dashboard/me",
      {
        method: "OPTIONS",
        headers: { origin: "http://evil.example.com", "access-control-request-method": "GET" },
      },
      env,
    );

    expect(response.headers.get("access-control-allow-origin")).not.toBe("http://evil.example.com");
  });

  it("signup creates a tenant and returns a raw API key once, then is idempotent on repeat calls", async () => {
    const { accessToken } = await signUpNewUser();

    const first = await app.request(
      "/v1/dashboard/signup",
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Test Co" }),
      },
      env,
    );

    expect(first.status).toBe(200);
    const firstBody = await first.json<any>();
    expect(firstBody.tenant.id).toBeDefined();
    expect(typeof firstBody.apiKey).toBe("string");
    expect(firstBody.apiKey.startsWith("ntfy_")).toBe(true);

    createdTenantIds.push(firstBody.tenant.id);

    const second = await app.request(
      "/v1/dashboard/signup",
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Test Co" }),
      },
      env,
    );

    expect(second.status).toBe(200);
    const secondBody = await second.json<any>();
    expect(secondBody.tenant.id).toBe(firstBody.tenant.id);
    expect(secondBody.apiKey).toBeNull();
  });

  it("me returns the tenant and masked key metadata after signup", async () => {
    const { accessToken } = await signUpNewUser();

    const signup = await app.request(
      "/v1/dashboard/signup",
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    const signupBody = await signup.json<any>();
    createdTenantIds.push(signupBody.tenant.id);

    const response = await app.request(
      "/v1/dashboard/me",
      { headers: { authorization: `Bearer ${accessToken}` } },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.tenant.id).toBe(signupBody.tenant.id);
    expect(body.apiKey.masked).toMatch(/^ntfy_.*[0-9a-zA-Z_-]{4}$/);
    expect(body.apiKey.masked).not.toBe(signupBody.apiKey);
  });

  it("me returns 404 before signup has ever run for this account", async () => {
    const { accessToken } = await signUpNewUser();

    const response = await app.request(
      "/v1/dashboard/me",
      { headers: { authorization: `Bearer ${accessToken}` } },
      env,
    );

    expect(response.status).toBe(404);
  });

  it("regenerating the API key revokes the old one and returns a new raw key", async () => {
    const { accessToken } = await signUpNewUser();

    const signup = await app.request(
      "/v1/dashboard/signup",
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    const signupBody = await signup.json<any>();
    createdTenantIds.push(signupBody.tenant.id);
    const originalKey = signupBody.apiKey;

    const regenerate = await app.request(
      "/v1/dashboard/api-key/regenerate",
      { method: "POST", headers: { authorization: `Bearer ${accessToken}` } },
      env,
    );

    expect(regenerate.status).toBe(200);
    const newKey = (await regenerate.json<any>()).apiKey;
    expect(newKey).not.toBe(originalKey);

    const usingOldKey = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { authorization: `Bearer ${originalKey}`, "content-type": "application/json" },
        body: JSON.stringify({ idempotency_key: `test-${randomUUID()}`, event_type: "user.signup", payload: {} }),
      },
      env,
    );
    expect(usingOldKey.status).toBe(401);

    const usingNewKey = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { authorization: `Bearer ${newKey}`, "content-type": "application/json" },
        body: JSON.stringify({ idempotency_key: `test-${randomUUID()}`, event_type: "user.signup", payload: {} }),
      },
      env,
    );
    expect(usingNewKey.status).toBe(201);
  });

  it("dashboard events endpoints reflect events created via the tenant's own API key", async () => {
    const { accessToken } = await signUpNewUser();

    const signup = await app.request(
      "/v1/dashboard/signup",
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    const signupBody = await signup.json<any>();
    createdTenantIds.push(signupBody.tenant.id);
    const rawKey = signupBody.apiKey;

    const created = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          idempotency_key: `test-${randomUUID()}`,
          event_type: "user.signup",
          payload: { to: "user@example.com", subject: "hi", body: "hi" },
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const eventId = (await created.json<any>()).id;

    const list = await app.request(
      "/v1/dashboard/events",
      { headers: { authorization: `Bearer ${accessToken}` } },
      env,
    );
    expect(list.status).toBe(200);
    const listBody = await list.json<any>();
    expect(listBody.events.some((event: { id: string }) => event.id === eventId)).toBe(true);

    const detail = await app.request(
      `/v1/dashboard/events/${eventId}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
      env,
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json<any>();
    expect(detailBody.id).toBe(eventId);
    expect(Array.isArray(detailBody.deliveries)).toBe(true);
  });

  it("another tenant's dashboard session cannot see this tenant's event", async () => {
    const owner = await signUpNewUser();
    const outsider = await signUpNewUser();

    const ownerSignup = await app.request(
      "/v1/dashboard/signup",
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    const ownerSignupBody = await ownerSignup.json<any>();
    createdTenantIds.push(ownerSignupBody.tenant.id);

    const outsiderSignup = await app.request(
      "/v1/dashboard/signup",
      {
        method: "POST",
        headers: { authorization: `Bearer ${outsider.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    const outsiderSignupBody = await outsiderSignup.json<any>();
    createdTenantIds.push(outsiderSignupBody.tenant.id);

    const created = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { authorization: `Bearer ${ownerSignupBody.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ idempotency_key: `test-${randomUUID()}`, event_type: "user.signup", payload: {} }),
      },
      env,
    );
    const eventId = (await created.json<any>()).id;

    const response = await app.request(
      `/v1/dashboard/events/${eventId}`,
      { headers: { authorization: `Bearer ${outsider.accessToken}` } },
      env,
    );

    expect(response.status).toBe(404);
  });
});
