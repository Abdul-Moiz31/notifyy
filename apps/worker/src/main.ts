import { logger } from "./logger.js";

logger.info("worker started");

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down worker");
    shuttingDown = true;
  });
}

setInterval(() => {
  if (shuttingDown) {
    process.exit(0);
  }
}, 1000);
