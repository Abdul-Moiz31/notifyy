import { Hono } from "hono";
import { cors } from "hono/cors";
import { dbMiddleware } from "./middleware/db.js";
import { apiKeyAuthMiddleware } from "./middleware/api-key-auth.js";
import { supabaseAuthMiddleware } from "./middleware/supabase-auth.js";
import eventsRoutes from "./routes/events.js";
import dashboardRoutes from "./routes/dashboard.js";
import type { AppEnv } from "./types.js";

export function buildApp() {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ status: "ok" }));

  // /v1/events* is server-to-server only (API key), never called from a browser — no CORS needed.
  app.use("/v1/events", dbMiddleware, apiKeyAuthMiddleware);
  app.use("/v1/events/*", dbMiddleware, apiKeyAuthMiddleware);
  app.route("/", eventsRoutes);

  // /v1/dashboard/* is called directly from the dashboard's browser origin, so it needs CORS.
  const dashboardCors = cors({
    origin: (origin, c) => {
      const allowed = c.env.DASHBOARD_ORIGIN.split(",").map((entry: string) => entry.trim());
      return allowed.includes(origin) ? origin : null;
    },
  });
  app.use("/v1/dashboard", dashboardCors, dbMiddleware, supabaseAuthMiddleware);
  app.use("/v1/dashboard/*", dashboardCors, dbMiddleware, supabaseAuthMiddleware);
  app.route("/", dashboardRoutes);

  return app;
}
