import type { Transporter } from "nodemailer";
import type { Logger } from "pino";
import type { PgQueue } from "@notify-engine/queue";
import { processJob } from "./services/job-processor.service.js";

export interface PollOnceDeps {
  queue: PgQueue;
  transporter: Transporter;
  fromAddress: string;
  logger: Logger;
  workerId: string;
  batchSize: number;
}

/** Claims one batch of due jobs and processes each. Returns how many jobs were claimed. */
export async function pollOnce(deps: PollOnceDeps): Promise<number> {
  const claimed = await deps.queue.claimNext({ workerId: deps.workerId, batchSize: deps.batchSize });

  for (const job of claimed) {
    try {
      await processJob(job, {
        transporter: deps.transporter,
        fromAddress: deps.fromAddress,
        logger: deps.logger,
      });
    } catch (error) {
      deps.logger.error(
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
