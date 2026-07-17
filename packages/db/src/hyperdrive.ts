import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

/**
 * Deliberately has NO side-effecting imports (no dotenv/env.js) — this file is imported directly
 * by the Cloudflare Worker (apps/api) via the `@notify-engine/db/hyperdrive` subpath, and
 * dotenv's `import.meta.url`-based path resolution breaks when bundled for the Workers runtime.
 * Importing anything from the root `@notify-engine/db` package (which re-exports client.ts,
 * Node-only) from Worker code will crash the Worker at startup — always import from this
 * subpath instead.
 */
export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Per-invocation factory for Cloudflare Workers, where env bindings (including Hyperdrive)
 * are only available inside a request/scheduled handler, never at module load time — so this
 * cannot be a module-level singleton the way packages/db's Node client is. Call once per
 * invocation with `env.HYPERDRIVE.connectionString`. Options follow Cloudflare's postgres.js +
 * Hyperdrive guidance: a small pool (Hyperdrive pools upstream already) and skipping the
 * pg_type introspection query on connect, which costs an extra round trip at the edge.
 */
export function createDb(connectionString: string): { db: Database; client: Sql } {
  const client = postgres(connectionString, { max: 5, fetch_types: false });
  return { db: drizzle(client, { schema }), client };
}
