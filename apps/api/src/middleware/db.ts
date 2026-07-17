import type { MiddlewareHandler } from "hono";
import { createDb } from "@notify-engine/db/hyperdrive";
import type { AppEnv } from "../types.js";

/**
 * Creates a fresh db client from the Hyperdrive binding for this invocation and stamps it
 * on context. Must run before any handler that needs `c.get("db")`. A fresh client per
 * invocation is required — Workers don't have a module-level singleton the way a long-running
 * Node process does, since `env` (and therefore the Hyperdrive connection string) is only
 * available inside a request/scheduled handler.
 *
 * Closes the connection once the request finishes (Cloudflare's recommended pattern for
 * postgres.js + Hyperdrive): Hyperdrive pools the connection to the origin database for us, so
 * the Worker-side client doesn't need to stay open across invocations — and in local/test runs
 * without Hyperdrive in front, leaving these open exhausts Supabase's session-pooler connection
 * limit within a handful of requests.
 */
export const dbMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { db, client } = createDb(c.env.HYPERDRIVE.connectionString);
  c.set("db", db);
  try {
    await next();
  } finally {
    await client.end();
  }
};
