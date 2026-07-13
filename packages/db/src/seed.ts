import "./env.js";
import { randomBytes, createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { tenants, apiKeys } from "./schema.js";

function generateApiKey(): string {
  return `ntfy_${randomBytes(32).toString("base64url")}`;
}

function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

async function seed(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];

  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  try {
    const [tenant] = await db
      .insert(tenants)
      .values({ name: "Local Test Tenant" })
      .returning({ id: tenants.id, name: tenants.name });

    if (!tenant) {
      throw new Error("Failed to create test tenant");
    }

    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);

    await db.insert(apiKeys).values({
      tenantId: tenant.id,
      keyHash,
    });

    console.log("Seed complete.");
    console.log(`Tenant:  ${tenant.name} (${tenant.id})`);
    console.log(`API key: ${rawKey}`);
    console.log("This key is shown once — only its hash is stored. Save it now.");
  } finally {
    await client.end();
  }
}

await seed();
