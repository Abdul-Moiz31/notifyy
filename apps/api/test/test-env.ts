import "@notify-engine/db"; // loads root .env as a side effect
import type { Bindings } from "../src/types.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set in .env for this test`);
  }
  return value;
}

/**
 * Fake Worker bindings for tests: HYPERDRIVE.connectionString points at the real Supabase
 * DATABASE_URL directly, since vitest runs in plain Node, never inside a Worker — this is the
 * "fall back to a direct connection string outside Workers" path.
 */
export function testEnv(): Bindings {
  return {
    HYPERDRIVE: { connectionString: required("DATABASE_URL") } as unknown as Hyperdrive,
    SMTP_HOST: required("SMTP_HOST"),
    SMTP_PORT: required("SMTP_PORT"),
    SMTP_SECURE: process.env["SMTP_SECURE"] ?? "false",
    SMTP_USER: process.env["SMTP_USER"] ?? "",
    SMTP_PASS: process.env["SMTP_PASS"] ?? "",
    NOTIFY_FROM_EMAIL: required("NOTIFY_FROM_EMAIL"),
    SUPABASE_URL: required("SUPABASE_URL"),
    SUPABASE_ANON_KEY: required("SUPABASE_ANON_KEY"),
    DASHBOARD_ORIGIN: process.env["DASHBOARD_ORIGIN"] ?? "http://localhost:3001",
  };
}
