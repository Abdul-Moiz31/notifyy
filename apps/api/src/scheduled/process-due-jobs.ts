import { randomUUID } from "node:crypto";
import type { Database } from "@notify-engine/db/hyperdrive";
import { PgQueue } from "@notify-engine/queue";
import { processJob } from "../services/job-processor.service.js";
import { createTransporter, smtpConfigFromEnv } from "../services/mailer.service.js";
import type { Logger } from "../logger.js";
import type { Bindings } from "../types.js";

const BATCH_SIZE = 10;

/**
 * Runs once per Cron Trigger invocation (see ADR-014): claims a single batch of due jobs and
 * processes each, then returns — no continuous polling loop, unlike the old apps/worker
 * process. Returns how many jobs were claimed.
 */
export async function processDueJobs(db: Database, env: Bindings, logger: Logger): Promise<number> {
  const workerId = `cron-${randomUUID()}`;
  const transporter = createTransporter(smtpConfigFromEnv(env));
  const queue = new PgQueue(db);

  const claimed = await queue.claimNext({ workerId, batchSize: BATCH_SIZE });

  for (const job of claimed) {
    try {
      await processJob(job, {
        db,
        transporter,
        fromAddress: env.NOTIFY_FROM_EMAIL,
        logger,
      });
    } catch (error) {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          event_id: job.eventId,
          tenant_id: job.tenantId,
        },
        "unexpected error processing job",
      );
    }
  }

  return claimed.length;
}
