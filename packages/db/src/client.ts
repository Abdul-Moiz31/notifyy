import "./env.js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import type { Database } from "./hyperdrive.js";

const connectionString = process.env["DATABASE_URL"];

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

/** Node-context singleton: migrate.ts, seed.ts, and vitest all run in plain Node, never inside a Worker. */
export const client = postgres(connectionString);

export const db: Database = drizzle(client, { schema });

export type { Database };
