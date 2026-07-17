import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@notify-engine/db/hyperdrive";
import { tenants, apiKeys } from "@notify-engine/db/schema";
import { generateApiKey, hashApiKey, getApiKeyLastFour } from "@notify-engine/shared";

export async function getTenantByAuthUserId(db: Database, authUserId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.authUserId, authUserId)).limit(1);
  return tenant ?? null;
}

async function createApiKeyForTenant(db: Database, tenantId: string) {
  const rawKey = generateApiKey();

  await db.insert(apiKeys).values({
    tenantId,
    keyHash: hashApiKey(rawKey),
    lastFour: getApiKeyLastFour(rawKey),
  });

  return rawKey;
}

/** Idempotent: if a tenant already exists for this Supabase user, returns it without minting a new key. */
export async function ensureTenantForAuthUser(db: Database, authUserId: string, name: string) {
  const existing = await getTenantByAuthUserId(db, authUserId);

  if (existing) {
    return { tenant: existing, apiKey: null };
  }

  const [tenant] = await db.insert(tenants).values({ name, authUserId }).returning();

  if (!tenant) {
    throw new Error("Failed to create tenant");
  }

  const apiKey = await createApiKeyForTenant(db, tenant.id);

  return { tenant, apiKey };
}

export async function getActiveApiKeyMeta(db: Database, tenantId: string) {
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)))
    .limit(1);

  return key ?? null;
}

/** Revokes any active key and mints a new one; the raw value is only ever returned here, once. */
export async function regenerateApiKey(db: Database, tenantId: string) {
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)));

  return createApiKeyForTenant(db, tenantId);
}
