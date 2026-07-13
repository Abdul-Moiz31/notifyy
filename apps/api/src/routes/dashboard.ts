import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dashboardSignupSchema, listEventsQuerySchema, API_KEY_PREFIX } from "@notify-engine/shared";
import { getEventById, listEvents } from "../services/events.service.js";
import {
  ensureTenantForAuthUser,
  getActiveApiKeyMeta,
  getTenantByAuthUserId,
  regenerateApiKey,
} from "../services/tenants.service.js";

const eventIdParamsSchema = z.object({ id: z.string().uuid() });

function maskedKey(lastFour: string | null): string {
  return `${API_KEY_PREFIX}${"•".repeat(8)}${lastFour ?? "????"}`;
}

export default async function dashboardRoutes(app: FastifyInstance) {
  app.post("/v1/dashboard/signup", async (request, reply) => {
    const parsed = dashboardSignupSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const name = parsed.data.name ?? request.authUserEmail;
    const { tenant, apiKey } = await ensureTenantForAuthUser(request.authUserId, name);

    return reply.code(200).send({
      tenant: { id: tenant.id, name: tenant.name },
      apiKey, // raw key, present only the first time a tenant is created — null on repeat calls
    });
  });

  app.get("/v1/dashboard/me", async (request, reply) => {
    const tenant = await getTenantByAuthUserId(request.authUserId);

    if (!tenant) {
      return reply.code(404).send({ error: "No tenant for this account yet" });
    }

    const key = await getActiveApiKeyMeta(tenant.id);

    return reply.send({
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

  app.post("/v1/dashboard/api-key/regenerate", async (request, reply) => {
    const tenant = await getTenantByAuthUserId(request.authUserId);

    if (!tenant) {
      return reply.code(404).send({ error: "No tenant for this account yet" });
    }

    const rawKey = await regenerateApiKey(tenant.id);

    return reply.send({ apiKey: rawKey });
  });

  app.get("/v1/dashboard/events", async (request, reply) => {
    const tenant = await getTenantByAuthUserId(request.authUserId);

    if (!tenant) {
      return reply.code(404).send({ error: "No tenant for this account yet" });
    }

    const parsedQuery = listEventsQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({ error: "Invalid query", details: parsedQuery.error.flatten() });
    }

    const result = await listEvents(tenant.id, parsedQuery.data);
    return reply.send(result);
  });

  app.get("/v1/dashboard/events/:id", async (request, reply) => {
    const tenant = await getTenantByAuthUserId(request.authUserId);

    if (!tenant) {
      return reply.code(404).send({ error: "No tenant for this account yet" });
    }

    const parsedParams = eventIdParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(404).send({ error: "Event not found" });
    }

    const result = await getEventById(tenant.id, parsedParams.data.id);

    if (!result) {
      return reply.code(404).send({ error: "Event not found" });
    }

    return reply.send(result);
  });
}
