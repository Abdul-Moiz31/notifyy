import Fastify, { type FastifyInstance } from "fastify";
import { loggerConfig } from "./logger.js";
import apiKeyAuthPlugin from "./plugins/api-key-auth.js";
import eventsRoutes from "./routes/events.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: loggerConfig });

  app.get("/health", async () => ({ status: "ok" }));

  app.register(async (instance) => {
    instance.register(apiKeyAuthPlugin);
    instance.register(eventsRoutes);
  });

  return app;
}
