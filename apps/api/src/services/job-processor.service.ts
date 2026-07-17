import { eq } from "drizzle-orm";
import type { Database } from "@notify-engine/db/hyperdrive";
import { notificationEvents, deliveries, jobs, type Job } from "@notify-engine/db/schema";
import { emailNotificationPayloadSchema } from "@notify-engine/shared";
import type { Transporter } from "nodemailer";
import type { Logger } from "../logger.js";
import { sendEmail } from "./mailer.service.js";

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;

export function computeBackoffMs(attemptCount: number): number {
  return BASE_BACKOFF_MS * 2 ** (attemptCount - 1);
}

export interface ProcessJobDeps {
  db: Database;
  transporter: Transporter;
  fromAddress: string;
  logger: Logger;
}

interface DeliveryOutcome {
  status: "sent" | "failed";
  providerMessageId: string | null;
  errorMessage: string | null;
}

async function recordDelivery(
  db: Database,
  eventId: string,
  tenantId: string,
  outcome: DeliveryOutcome,
): Promise<void> {
  const [existing] = await db.select().from(deliveries).where(eq(deliveries.eventId, eventId)).limit(1);

  if (existing) {
    await db
      .update(deliveries)
      .set({
        status: outcome.status,
        providerMessageId: outcome.providerMessageId,
        errorMessage: outcome.errorMessage,
        attemptCount: existing.attemptCount + 1,
        lastAttemptedAt: new Date(),
      })
      .where(eq(deliveries.id, existing.id));
    return;
  }

  await db.insert(deliveries).values({
    eventId,
    tenantId,
    channel: "email",
    status: outcome.status,
    providerMessageId: outcome.providerMessageId,
    errorMessage: outcome.errorMessage,
    attemptCount: 1,
    lastAttemptedAt: new Date(),
  });
}

export async function processJob(job: Job, deps: ProcessJobDeps): Promise<void> {
  const { db } = deps;
  const log = deps.logger.child({ event_id: job.eventId, tenant_id: job.tenantId, job_id: job.id });

  const [event] = await db
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.id, job.eventId))
    .limit(1);

  if (!event) {
    throw new Error(`Job ${job.id} references missing notification_event ${job.eventId}`);
  }

  await db
    .update(notificationEvents)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(notificationEvents.id, event.id));

  const parsedPayload = emailNotificationPayloadSchema.safeParse(event.payload);

  if (!parsedPayload.success) {
    const errorMessage = `Invalid email payload: ${parsedPayload.error.message}`;
    log.error({ err: errorMessage }, "job failed permanently: payload does not match email schema");
    await recordDelivery(db, event.id, job.tenantId, {
      status: "failed",
      providerMessageId: null,
      errorMessage,
    });
    await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, job.id));
    await db
      .update(notificationEvents)
      .set({ status: "dead_letter", updatedAt: new Date() })
      .where(eq(notificationEvents.id, event.id));
    return;
  }

  try {
    const result = await sendEmail(deps.transporter, deps.fromAddress, parsedPayload.data);

    await recordDelivery(db, event.id, job.tenantId, {
      status: "sent",
      providerMessageId: result.providerMessageId,
      errorMessage: null,
    });
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id));
    await db
      .update(notificationEvents)
      .set({ status: "sent", updatedAt: new Date() })
      .where(eq(notificationEvents.id, event.id));

    log.info({ provider_message_id: result.providerMessageId }, "email sent");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const newAttemptCount = job.attemptCount + 1;

    await recordDelivery(db, event.id, job.tenantId, {
      status: "failed",
      providerMessageId: null,
      errorMessage,
    });

    if (newAttemptCount < MAX_ATTEMPTS) {
      const backoffMs = computeBackoffMs(newAttemptCount);
      await db
        .update(jobs)
        .set({
          status: "queued",
          attemptCount: newAttemptCount,
          runAfter: new Date(Date.now() + backoffMs),
          lockedAt: null,
          lockedBy: null,
        })
        .where(eq(jobs.id, job.id));

      log.warn(
        { err: errorMessage, attempt_count: newAttemptCount, backoff_ms: backoffMs },
        "email send failed, scheduled for retry",
      );
    } else {
      await db
        .update(jobs)
        .set({ status: "failed", attemptCount: newAttemptCount })
        .where(eq(jobs.id, job.id));
      await db
        .update(notificationEvents)
        .set({ status: "dead_letter", updatedAt: new Date() })
        .where(eq(notificationEvents.id, event.id));

      log.error(
        { err: errorMessage, attempt_count: newAttemptCount },
        "email send failed, exceeded max retry attempts, moved to dead letter",
      );
    }
  }
}
