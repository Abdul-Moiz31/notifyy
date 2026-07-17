import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@notify-engine/db/hyperdrive";
import { apiKeys } from "@notify-engine/db/schema";

export async function resolveTenantByApiKeyHash(db: Database, keyHash: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: apiKeys.tenantId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);

  return row?.tenantId ?? null;
}

export async function touchApiKeyLastUsed(db: Database, keyHash: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.keyHash, keyHash));
}
