import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createNotificationEventSchema, listEventsQuerySchema } from "@notify-engine/shared";
import { createEvent, getEventById, listEvents, IdempotencyConflictError } from "../services/events.service.js";

const eventIdParamsSchema = z.object({ id: z.string().uuid() });

export default async function eventsRoutes(app: FastifyInstance) {
  app.post("/v1/events", async (request, reply) => {
    const parsed = createNotificationEventSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    try {
      const event = await createEvent(request.tenantId, parsed.data);
      return reply.code(201).send(event);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/events/:id", async (request, reply) => {
    const parsedParams = eventIdParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(404).send({ error: "Event not found" });
    }

    const result = await getEventById(request.tenantId, parsedParams.data.id);

    if (!result) {
      return reply.code(404).send({ error: "Event not found" });
    }

    return reply.send(result);
  });

  app.get("/v1/events", async (request, reply) => {
    const parsedQuery = listEventsQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({ error: "Invalid query", details: parsedQuery.error.flatten() });
    }

    const result = await listEvents(request.tenantId, parsedQuery.data);
    return reply.send(result);
  });
}
