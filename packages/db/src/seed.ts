import "./env.js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { generateApiKey, hashApiKey } from "@notify-engine/shared";
import { tenants, apiKeys } from "./schema.js";

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
