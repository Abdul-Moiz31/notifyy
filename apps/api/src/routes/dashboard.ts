import { Hono } from "hono";
import { z } from "zod";
import { dashboardSignupSchema, listEventsQuerySchema, API_KEY_PREFIX } from "@notify-engine/shared";
import { getEventById, listEvents } from "../services/events.service.js";
import {
  ensureTenantForAuthUser,
  getActiveApiKeyMeta,
  getTenantByAuthUserId,
  regenerateApiKey,
} from "../services/tenants.service.js";
import type { AppEnv } from "../types.js";

const eventIdParamsSchema = z.object({ id: z.string().uuid() });

function maskedKey(lastFour: string | null): string {
  return `${API_KEY_PREFIX}${"•".repeat(8)}${lastFour ?? "????"}`;
}

const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.post("/v1/dashboard/signup", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = dashboardSignupSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
  }

  const db = c.get("db");
  const name = parsed.data.name ?? c.get("authUserEmail");
  const { tenant, apiKey } = await ensureTenantForAuthUser(db, c.get("authUserId"), name);

  return c.json({
    tenant: { id: tenant.id, name: tenant.name },
    apiKey, // raw key, present only the first time a tenant is created — null on repeat calls
  });
});

dashboardRoutes.get("/v1/dashboard/me", async (c) => {
  const db = c.get("db");
  const tenant = await getTenantByAuthUserId(db, c.get("authUserId"));

  if (!tenant) {
    return c.json({ error: "No tenant for this account yet" }, 404);
  }

  const key = await getActiveApiKeyMeta(db, tenant.id);

  return c.json({
    tenant: { id: tenant.id, name: tenant.name },
    apiKey: key
      ? {
          masked: maskedKey(key.lastFour),
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
        }
      : null,
  });
});

dashboardRoutes.post("/v1/dashboard/api-key/regenerate", async (c) => {
  const db = c.get("db");
  const tenant = await getTenantByAuthUserId(db, c.get("authUserId"));

  if (!tenant) {
    return c.json({ error: "No tenant for this account yet" }, 404);
  }

  const rawKey = await regenerateApiKey(db, tenant.id);

  return c.json({ apiKey: rawKey });
});

dashboardRoutes.get("/v1/dashboard/events", async (c) => {
  const db = c.get("db");
  const tenant = await getTenantByAuthUserId(db, c.get("authUserId"));

  if (!tenant) {
    return c.json({ error: "No tenant for this account yet" }, 404);
  }

  const parsedQuery = listEventsQuerySchema.safeParse(c.req.query());

  if (!parsedQuery.success) {
    return c.json({ error: "Invalid query", details: parsedQuery.error.flatten() }, 400);
  }

  const result = await listEvents(db, tenant.id, parsedQuery.data);
  return c.json(result);
});

dashboardRoutes.get("/v1/dashboard/events/:id", async (c) => {
  const db = c.get("db");
  const tenant = await getTenantByAuthUserId(db, c.get("authUserId"));

  if (!tenant) {
    return c.json({ error: "No tenant for this account yet" }, 404);
  }

  const parsedParams = eventIdParamsSchema.safeParse({ id: c.req.param("id") });

  if (!parsedParams.success) {
    return c.json({ error: "Event not found" }, 404);
  }

  const result = await getEventById(db, tenant.id, parsedParams.data.id);

  if (!result) {
    return c.json({ error: "Event not found" }, 404);
  }

  return c.json(result);
});

export default dashboardRoutes;
