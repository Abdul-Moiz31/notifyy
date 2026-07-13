import { and, eq, desc, sql } from "drizzle-orm";
import { db, notificationEvents, deliveries, jobs } from "@notify-engine/db";
import type { CreateNotificationEventInput, ListEventsQuery } from "@notify-engine/shared";

export class IdempotencyConflictError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

export async function createEvent(tenantId: string, input: CreateNotificationEventInput) {
  return db.transaction(async (tx) => {
    let created;

    try {
      [created] = await tx
        .insert(notificationEvents)
        .values({
          tenantId,
          idempotencyKey: input.idempotency_key,
          eventType: input.event_type,
          payload: input.payload,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new IdempotencyConflictError(
          `An event with idempotency key "${input.idempotency_key}" already exists for this tenant`,
        );
      }
      throw error;
    }

    if (!created) {
      throw new Error("Failed to create notification event");
    }

    await tx.insert(jobs).values({
      eventId: created.id,
      tenantId,
      status: "queued",
    });

    return created;
  });
}

export async function getEventById(tenantId: string, eventId: string) {
  const [event] = await db
    .select()
    .from(notificationEvents)
    .where(and(eq(notificationEvents.id, eventId), eq(notificationEvents.tenantId, tenantId)))
    .limit(1);

  if (!event) {
    return null;
  }

  const eventDeliveries = await db
    .select()
    .from(deliveries)
    .where(eq(deliveries.eventId, eventId));

  return { ...event, deliveries: eventDeliveries };
}

export async function listEvents(tenantId: string, query: ListEventsQuery) {
  const rows = await db
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.tenantId, tenantId))
    .orderBy(desc(notificationEvents.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationEvents)
    .where(eq(notificationEvents.tenantId, tenantId));

  return {
    events: rows,
    total: totalRow?.count ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}
