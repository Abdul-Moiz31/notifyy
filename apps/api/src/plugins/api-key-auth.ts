import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { hashApiKey } from "@notify-engine/shared";
import { resolveTenantByApiKeyHash, touchApiKeyLastUsed } from "../services/api-keys.service.js";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

function extractApiKey(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const trimmed = header.trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);

  return bearerMatch?.[1] ?? trimmed;
}

/**
 * Scoped to whatever context it's registered in (via fastify-plugin, which
 * hoists this hook into the parent's encapsulation instead of its own) — so
 * routes registered as siblings share it, and routes registered elsewhere
 * (e.g. /health) are unaffected.
 */
export default fp(async function apiKeyAuthPlugin(app: FastifyInstance) {
  app.decorateRequest("tenantId", "");

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawKey = extractApiKey(request.headers.authorization);

    if (!rawKey) {
      return reply.code(401).send({ error: "Missing API key" });
    }

    const keyHash = hashApiKey(rawKey);
    const tenantId = await resolveTenantByApiKeyHash(keyHash);

    if (!tenantId) {
      return reply.code(401).send({ error: "Invalid or revoked API key" });
    }

    request.tenantId = tenantId;
    await touchApiKeyLastUsed(keyHash);
  });
});
