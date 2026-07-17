import type { MiddlewareHandler } from "hono";
import { hashApiKey } from "@notify-engine/shared";
import { resolveTenantByApiKeyHash, touchApiKeyLastUsed } from "../services/api-keys.service.js";
import type { AppEnv } from "../types.js";

function extractApiKey(header: string | undefined | null): string | null {
  if (!header) {
    return null;
  }

  const trimmed = header.trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);

  return bearerMatch?.[1] ?? trimmed;
}

/**
 * Authenticates external integrators (server-to-server) by API key. Distinct from
 * supabase-auth.ts, which authenticates the dashboard's browser sessions — scoped only to
 * /v1/events*.
 */
export const apiKeyAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const rawKey = extractApiKey(c.req.header("authorization"));

  if (!rawKey) {
    return c.json({ error: "Missing API key" }, 401);
  }

  const db = c.get("db");
  const keyHash = hashApiKey(rawKey);
  const tenantId = await resolveTenantByApiKeyHash(db, keyHash);

  if (!tenantId) {
    return c.json({ error: "Invalid or revoked API key" }, 401);
  }

  c.set("tenantId", tenantId);
  await touchApiKeyLastUsed(db, keyHash);

  await next();
};
