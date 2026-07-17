import { Hono } from "hono";
import { z } from "zod";
import { createNotificationEventSchema, listEventsQuerySchema } from "@notify-engine/shared";
import { createEvent, getEventById, listEvents, IdempotencyConflictError } from "../services/events.service.js";
import type { AppEnv } from "../types.js";

const eventIdParamsSchema = z.object({ id: z.string().uuid() });

const eventsRoutes = new Hono<AppEnv>();

eventsRoutes.post("/v1/events", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = createNotificationEventSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
  }

  try {
    const event = await createEvent(c.get("db"), c.get("tenantId"), parsed.data);
    return c.json(event, 201);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
});

eventsRoutes.get("/v1/events/:id", async (c) => {
  const parsedParams = eventIdParamsSchema.safeParse({ id: c.req.param("id") });

  if (!parsedParams.success) {
    return c.json({ error: "Event not found" }, 404);
  }

  const result = await getEventById(c.get("db"), c.get("tenantId"), parsedParams.data.id);

  if (!result) {
    return c.json({ error: "Event not found" }, 404);
  }

  return c.json(result);
});

eventsRoutes.get("/v1/events", async (c) => {
  const parsedQuery = listEventsQuerySchema.safeParse(c.req.query());

  if (!parsedQuery.success) {
    return c.json({ error: "Invalid query", details: parsedQuery.error.flatten() }, 400);
  }

  const result = await listEvents(c.get("db"), c.get("tenantId"), parsedQuery.data);
  return c.json(result);
});

export default eventsRoutes;
