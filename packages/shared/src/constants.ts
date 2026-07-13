// Kept in sync by hand with the pgEnum definitions in packages/db/src/schema.ts —
// shared has no dependency on db so API/worker can validate without pulling in Drizzle.
export const NOTIFICATION_EVENT_STATUSES = [
  "pending",
  "processing",
  "sent",
  "failed",
  "dead_letter",
] as const;

export const DELIVERY_CHANNELS = ["email"] as const;

export const DELIVERY_STATUSES = ["pending", "sent", "failed"] as const;

export const JOB_STATUSES = ["queued", "locked", "done", "failed"] as const;

export const DEFAULT_EVENTS_PAGE_LIMIT = 20;
export const MAX_EVENTS_PAGE_LIMIT = 100;

export const API_KEY_PREFIX = "ntfy_";
