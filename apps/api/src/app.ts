import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { loggerConfig } from "./logger.js";
import apiKeyAuthPlugin from "./plugins/api-key-auth.js";
import supabaseAuthPlugin from "./plugins/supabase-auth.js";
import eventsRoutes from "./routes/events.js";
import dashboardRoutes from "./routes/dashboard.js";

const dashboardOrigins = (process.env["DASHBOARD_ORIGIN"] ?? "http://localhost:3001")
  .split(",")
  .map((origin) => origin.trim());

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: loggerConfig });

  app.get("/health", async () => ({ status: "ok" }));

  // /v1/events* is server-to-server only (API key), never called from a browser — no CORS needed.
  app.register(async (instance) => {
    instance.register(apiKeyAuthPlugin);
    instance.register(eventsRoutes);
  });

  // /v1/dashboard/* is called directly from the dashboard's browser origin, so it needs CORS.
  app.register(async (instance) => {
    instance.register(cors, { origin: dashboardOrigins });
    instance.register(supabaseAuthPlugin);
    instance.register(dashboardRoutes);
  });

  return app;
}
