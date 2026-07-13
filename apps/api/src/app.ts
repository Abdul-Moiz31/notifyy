import Fastify, { type FastifyInstance } from "fastify";
import { loggerConfig } from "./logger.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: loggerConfig });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
