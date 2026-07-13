import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import "@notify-engine/db"; // ensures root .env is loaded before reading SUPABASE_* below

declare module "fastify" {
  interface FastifyRequest {
    authUserId: string;
    authUserEmail: string;
  }
}

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseAnonKey = process.env["SUPABASE_ANON_KEY"];

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required");
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Calls Supabase's REST auth endpoint directly instead of instantiating the
 * @supabase/supabase-js client, which eagerly spins up a Realtime websocket
 * client that requires native WebSocket (Node 22+) — this repo targets Node 20.
 */
async function verifySupabaseToken(token: string): Promise<{ id: string; email: string } | null> {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey ?? "",
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const user = (await response.json()) as { id: string; email?: string };
  return { id: user.id, email: user.email ?? "" };
}

/**
 * Verifies a Supabase session access token (issued to the dashboard on login) and
 * stamps request.authUserId/authUserEmail. Distinct from api-key-auth.ts, which
 * authenticates external integrators — this plugin is scoped only to /v1/dashboard*.
 */
export default fp(async function supabaseAuthPlugin(app: FastifyInstance) {
  app.decorateRequest("authUserId", "");
  app.decorateRequest("authUserEmail", "");

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      return reply.code(401).send({ error: "Missing session token" });
    }

    const user = await verifySupabaseToken(token);

    if (!user) {
      return reply.code(401).send({ error: "Invalid or expired session" });
    }

    request.authUserId = user.id;
    request.authUserEmail = user.email;
  });
});
