import { createDb } from "@notify-engine/db/hyperdrive";
import { buildApp } from "./app.js";
import { createLogger } from "./logger.js";
import { processDueJobs } from "./scheduled/process-due-jobs.js";
import type { Bindings } from "./types.js";

const app = buildApp();

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const logger = createLogger(env.LOG_LEVEL);
    const { db, client } = createDb(env.HYPERDRIVE.connectionString);

    ctx.waitUntil(
      processDueJobs(db, env, logger)
        .then((claimed) => {
          logger.info({ claimed }, "scheduled job processing cycle complete");
        })
        .catch((error: unknown) => {
          logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            "scheduled job processing cycle failed",
          );
        })
        .finally(() => client.end()),
    );
  },
};
