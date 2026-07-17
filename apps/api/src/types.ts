import type { Database } from "@notify-engine/db/hyperdrive";

export interface Bindings {
  HYPERDRIVE: Hyperdrive;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_SECURE: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  NOTIFY_FROM_EMAIL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  DASHBOARD_ORIGIN: string;
  LOG_LEVEL?: string;
}

export interface Variables {
  db: Database;
  tenantId: string;
  authUserId: string;
  authUserEmail: string;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
