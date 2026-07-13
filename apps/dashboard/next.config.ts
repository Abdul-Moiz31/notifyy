import type { NextConfig } from "next";
import { config } from "dotenv";
import { resolve } from "node:path";

// Env vars (Supabase URL/anon key, API base URL) live in the monorepo-root .env,
// not a dashboard-local one — this loads it before Next reads process.env.
config({ path: resolve(__dirname, "../../.env") });

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
