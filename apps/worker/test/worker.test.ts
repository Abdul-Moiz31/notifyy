import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Transporter } from "nodemailer";
import pino from "pino";
import {
  db,
  client,
  tenants,
  notificationEvents,
  jobs,
  deliveries,
} from "@notify-engine/db";
import { queue } from "@notify-engine/queue";
import { createTransporter, smtpConfigFromEnv } from "../src/services/mailer.service.js";
import { processJob, MAX_ATTEMPTS } from "../src/services/job-processor.service.js";
import { pollOnce } from "../src/poll.js";

const testLogger = pino({ level: "silent" });

describe("worker integration", () => {
  let tenantId: string;

  beforeAll(async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ name: `Test Worker Tenant ${randomUUID()}` })
      .returning();

    if (!tenant) {
      throw new Error("Failed to seed test tenant");
    }

    tenantId = tenant.id;
  });

  afterAll(async () => {
    await db.delete(deliveries).where(eq(deliveries.tenantId, tenantId));
    await db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await db.delete(notificationEvents).where(eq(notificationEvents.tenantId, tenantId));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId]));

    await client.end();
  });

  it("sends a real email through SMTP and marks the event sent with a delivery row", async () => {
    const fromAddress = process.env["NOTIFY_FROM_EMAIL"];
    if (!fromAddress) {
      throw new Error("NOTIFY_FROM_EMAIL must be set for this test");
    }

    const [event] = await db
      .insert(notificationEvents)
      .values({
        tenantId,
        idempotencyKey: `test-${randomUUID()}`,
        eventType: "test.email",
        payload: { to: fromAddress, subject: "Notify Engine worker test", body: "hello from the worker test" },
      })
      .returning();

    if (!event) {
      throw new Error("Failed to seed test event");
    }

    await queue.enqueue({ eventId: event.id, tenantId });

    const transporter = createTransporter(smtpConfigFromEnv());
    const claimedCount = await pollOnce({
      queue,
      transporter,
      fromAddress,
      logger: testLogger,
      workerId: "test-worker",
      batchSize: 10,
    });

    expect(claimedCount).toBeGreaterThanOrEqual(1);

    const [updatedEvent] = await db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, event.id));
    expect(updatedEvent?.status).toBe("sent");

    const [delivery] = await db.select().from(deliveries).where(eq(deliveries.eventId, event.id));
    expect(delivery?.status).toBe("sent");
    expect(delivery?.providerMessageId).toBeTruthy();

    const [job] = await db.select().from(jobs).where(eq(jobs.eventId, event.id));
    expect(job?.status).toBe("done");
  });

  it("moves a job straight to dead_letter when the event payload fails email schema validation", async () => {
    const [event] = await db
      .insert(notificationEvents)
      .values({
        tenantId,
        idempotencyKey: `test-${randomUUID()}`,
        eventType: "test.email",
        payload: { subject: "missing to/body" },
      })
      .returning();

    if (!event) {
      throw new Error("Failed to seed test event");
    }

    const job = await queue.enqueue({ eventId: event.id, tenantId });

    const fakeTransporter = { sendMail: () => Promise.resolve({ messageId: "unused" }) } as unknown as Transporter;

    await processJob(job, {
      transporter: fakeTransporter,
      fromAddress: "from@example.com",
      logger: testLogger,
    });

    const [updatedEvent] = await db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, event.id));
    expect(updatedEvent?.status).toBe("dead_letter");

    const [updatedJob] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(updatedJob?.status).toBe("failed");

    const [delivery] = await db.select().from(deliveries).where(eq(deliveries.eventId, event.id));
    expect(delivery?.status).toBe("failed");
    expect(delivery?.errorMessage).toBeTruthy();
  });

  it("schedules a retry with backoff when send fails and attempts remain", async () => {
    const [event] = await db
      .insert(notificationEvents)
      .values({
        tenantId,
        idempotencyKey: `test-${randomUUID()}`,
        eventType: "test.email",
        payload: { to: "user@example.com", subject: "subj", body: "body" },
      })
      .returning();

    if (!event) {
      throw new Error("Failed to seed test event");
    }

    const job = await queue.enqueue({ eventId: event.id, tenantId });

    const failingTransporter = {
      sendMail: () => Promise.reject(new Error("smtp connection refused")),
    } as unknown as Transporter;

    await processJob(job, {
      transporter: failingTransporter,
      fromAddress: "from@example.com",
      logger: testLogger,
    });

    const [updatedJob] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(updatedJob?.status).toBe("queued");
    expect(updatedJob?.attemptCount).toBe(1);
    expect(updatedJob?.runAfter.getTime()).toBeGreaterThan(Date.now());

    const [updatedEvent] = await db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, event.id));
    expect(updatedEvent?.status).toBe("processing");
  });

  it("moves the job to failed and the event to dead_letter once max attempts are exceeded", async () => {
    const [event] = await db
      .insert(notificationEvents)
      .values({
        tenantId,
        idempotencyKey: `test-${randomUUID()}`,
        eventType: "test.email",
        payload: { to: "user@example.com", subject: "subj", body: "body" },
      })
      .returning();

    if (!event) {
      throw new Error("Failed to seed test event");
    }

    const [job] = await db
      .insert(jobs)
      .values({ eventId: event.id, tenantId, status: "locked", attemptCount: MAX_ATTEMPTS - 1 })
      .returning();

    if (!job) {
      throw new Error("Failed to seed test job");
    }

    const failingTransporter = {
      sendMail: () => Promise.reject(new Error("smtp connection refused")),
    } as unknown as Transporter;

    await processJob(job, {
      transporter: failingTransporter,
      fromAddress: "from@example.com",
      logger: testLogger,
    });

    const [updatedJob] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.attemptCount).toBe(MAX_ATTEMPTS);

    const [updatedEvent] = await db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, event.id));
    expect(updatedEvent?.status).toBe("dead_letter");
  });
});
