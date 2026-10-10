import { z } from 'zod';

/**
 * Readiness is deliberately separate from liveness: the process can be alive
 * while a dependency is not reachable, and a load balancer needs to tell those
 * apart rather than restarting a healthy process.
 */
export const dependencyStatusSchema = z.enum(['up', 'down', 'degraded']);

/**
 * When each scheduled pass last finished (worker_heartbeats, 0005). It does
 * not decide readiness — an instance can serve requests while the scheduler
 * has stopped calling it — but a scheduler that stops fails nothing, so the
 * probe from outside reads it here.
 */
export const workerCadenceSchema = z.object({
  finishedAt: z.string().nullable(),
  ageSeconds: z.number().nullable(),
  ok: z.boolean().nullable(),
  stale: z.boolean(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unavailable']),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  dependencies: z.record(z.string(), dependencyStatusSchema),
  workers: z
    .object({
      mode: z.enum(['interval', 'cron']),
      cadences: z.record(z.string(), workerCadenceSchema).optional(),
    })
    .optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
