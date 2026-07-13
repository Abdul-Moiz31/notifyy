import { z } from "zod";
import {
  NOTIFICATION_EVENT_STATUSES,
  DELIVERY_CHANNELS,
  DELIVERY_STATUSES,
  JOB_STATUSES,
  DEFAULT_EVENTS_PAGE_LIMIT,
  MAX_EVENTS_PAGE_LIMIT,
} from "./constants.js";

export const notificationEventStatusSchema = z.enum(NOTIFICATION_EVENT_STATUSES);
export const deliveryChannelSchema = z.enum(DELIVERY_CHANNELS);
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export const jobStatusSchema = z.enum(JOB_STATUSES);

/** Body for POST /v1/events — also the shape the worker will read back off a job's event. */
export const createNotificationEventSchema = z.object({
  idempotency_key: z.string().min(1).max(255),
  event_type: z.string().min(1).max(255),
  payload: z.record(z.string(), z.unknown()),
});

export type CreateNotificationEventInput = z.infer<typeof createNotificationEventSchema>;

export const listEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_EVENTS_PAGE_LIMIT).default(DEFAULT_EVENTS_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

/** Shape the worker requires inside `notification_events.payload` to send an email (phase 1: single email channel, no templates). */
export const emailNotificationPayloadSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export type EmailNotificationPayload = z.infer<typeof emailNotificationPayloadSchema>;
