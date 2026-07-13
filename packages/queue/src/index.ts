import { and, eq, inArray, lte } from "drizzle-orm";
import { db, jobs, type Database, type Job } from "@notify-engine/db";

/** Structural subset of Database/transaction that enqueue needs — lets callers pass either the db singleton or a transaction. */
type Enqueuer = Pick<Database, "insert">;

export interface EnqueueJobInput {
  eventId: string;
  tenantId: string;
  runAfter?: Date;
}

export interface ClaimNextOptions {
  workerId: string;
  batchSize: number;
  now?: Date;
}

/**
 * Postgres-backed queue over the `jobs` table (ADR-001/ADR-007). This is the only place
 * that should issue raw queries against `jobs` — callers go through enqueue/claimNext so a
 * later swap to a dedicated broker only touches this class.
 */
export class PgQueue {
  constructor(private readonly database: Database) {}

  async enqueue(input: EnqueueJobInput, executor: Enqueuer = this.database): Promise<Job> {
    const [job] = await executor
      .insert(jobs)
      .values({
        eventId: input.eventId,
        tenantId: input.tenantId,
        status: "queued",
        ...(input.runAfter ? { runAfter: input.runAfter } : {}),
      })
      .returning();

    if (!job) {
      throw new Error("Failed to enqueue job");
    }

    return job;
  }

  async claimNext(options: ClaimNextOptions): Promise<Job[]> {
    const now = options.now ?? new Date();

    return this.database.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.status, "queued"), lte(jobs.runAfter, now)))
        .orderBy(jobs.runAfter)
        .limit(options.batchSize)
        .for("update", { skipLocked: true });

      if (candidates.length === 0) {
        return [];
      }

      const ids = candidates.map((candidate) => candidate.id);

      return tx
        .update(jobs)
        .set({ status: "locked", lockedAt: now, lockedBy: options.workerId })
        .where(inArray(jobs.id, ids))
        .returning();
    });
  }
}

export const queue = new PgQueue(db);
