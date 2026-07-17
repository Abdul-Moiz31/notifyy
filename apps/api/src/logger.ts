import pino from "pino";

/**
 * pino's Node transports (worker_threads-based pretty-printing, file destinations) aren't
 * available in the Workers runtime. `browser.asObject` keeps structured JSON logging — still
 * pino's API, still one structured line per log — routed through console methods, which
 * Workers supports natively.
 */
export function createLogger(level: string | undefined) {
  return pino({
    level: level ?? "info",
    browser: { asObject: true },
  });
}

export type Logger = ReturnType<typeof createLogger>;
