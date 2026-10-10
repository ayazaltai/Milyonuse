import { Injectable } from '@nestjs/common';
import type pg from 'pg';

/**
 * The durable queue's vocabulary (jobs, 0005).
 *
 * A job is a row. Handlers are registered by kind by the modules that own the
 * work, and the worker knows nothing about what any of them do. A kind is a
 * lower_snake_case name; the database refuses any other.
 */

const KIND = /^[a-z][a-z0-9_]*$/;

export interface ClaimedJob {
  id: string;
  organizationId: string;
  kind: string;
  payload: Record<string, unknown>;
  /** Including this one. */
  attempts: number;
  maxAttempts: number;
}

export type JobOutcome =
  | { status: 'succeeded' }
  /** Nothing to do by the time it ran — recorded, not retried. */
  | { status: 'skipped'; reason: string };

export interface JobHandler {
  /**
   * Does the work. Resolves with what happened; rejects to be retried with
   * backoff, or with a PermanentJobError to fail without retrying — an address
   * that does not exist will not exist in ten minutes either.
   */
  handle(job: ClaimedJob): Promise<JobOutcome>;
}

export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

export interface EnqueueInput {
  organizationId: string;
  kind: string;
  payload?: Record<string, unknown>;
  /** The same piece of work has the same key; a second enqueue of it is a no-op. */
  dedupeKey: string;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Puts work in the queue, inside the caller's transaction — so the work exists
 * exactly when the change that asked for it does. Returns false when the same
 * work was already queued.
 */
export async function enqueue(client: pg.PoolClient, input: EnqueueInput): Promise<boolean> {
  if (!KIND.test(input.kind)) throw new Error(`Not a job kind: ${input.kind}`);
  const { rowCount } = await client.query(
    `INSERT INTO jobs (organization_id, kind, payload, dedupe_key, run_at, max_attempts)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), COALESCE($6, 5))
     ON CONFLICT (organization_id, dedupe_key) DO NOTHING`,
    [
      input.organizationId,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey,
      input.runAt ?? null,
      input.maxAttempts ?? null,
    ],
  );
  return (rowCount ?? 0) > 0;
}

@Injectable()
export class JobRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(kind: string, handler: JobHandler): void {
    if (!KIND.test(kind)) throw new Error(`Not a job kind: ${kind}`);
    if (this.handlers.has(kind)) throw new Error(`A handler for ${kind} is already registered`);
    this.handlers.set(kind, handler);
  }

  handlerFor(kind: string): JobHandler | undefined {
    return this.handlers.get(kind);
  }
}
