import { randomUUID } from "node:crypto";
import { queue } from "@notify-engine/queue";
import { logger } from "./logger.js";
import { createTransporter, smtpConfigFromEnv } from "./services/mailer.service.js";
import { pollOnce } from "./poll.js";

const pollIntervalMs = Number(process.env["WORKER_POLL_INTERVAL_MS"] ?? 2000);
const batchSize = Number(process.env["WORKER_BATCH_SIZE"] ?? 10);
const fromAddress = process.env["NOTIFY_FROM_EMAIL"];

if (!fromAddress) {
  throw new Error("NOTIFY_FROM_EMAIL must be set");
}

const workerId = `worker-${process.pid}-${randomUUID()}`;
const transporter = createTransporter(smtpConfigFromEnv());

logger.info(
  { worker_id: workerId, poll_interval_ms: pollIntervalMs, batch_size: batchSize },
  "worker started",
);

let shuttingDown = false;
let polling = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down worker");
    shuttingDown = true;
  });
}

const interval = setInterval(() => {
  if (shuttingDown) {
    clearInterval(interval);
    process.exit(0);
    return;
  }

  if (polling) {
    return;
  }

  polling = true;
  pollOnce({ queue, transporter, fromAddress, logger, workerId, batchSize })
    .catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "poll cycle failed",
      );
    })
    .finally(() => {
      polling = false;
    });
}, pollIntervalMs);
