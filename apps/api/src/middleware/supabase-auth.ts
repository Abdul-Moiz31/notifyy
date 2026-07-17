import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";

function extractBearerToken(header: string | undefined | null): string | null {
  if (!header) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function verifySupabaseToken(
  supabaseUrl: string,
  supabaseAnonKey: string,
  token: string,
): Promise<{ id: string; email: string } | null> {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: supabaseAnonKey, authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    return null;
  }

  const user = (await response.json()) as { id: string; email?: string };
  return { id: user.id, email: user.email ?? "" };
}

/**
 * Authenticates the dashboard's browser sessions by verifying a Supabase access token against
 * Supabase's own REST endpoint (no service-role key needed). Distinct from api-key-auth.ts —
 * scoped only to /v1/dashboard/*.
 */
export const supabaseAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = extractBearerToken(c.req.header("authorization"));

  if (!token) {
    return c.json({ error: "Missing session token" }, 401);
  }

  const user = await verifySupabaseToken(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY, token);

  if (!user) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  c.set("authUserId", user.id);
  c.set("authUserEmail", user.email);

  await next();
};
