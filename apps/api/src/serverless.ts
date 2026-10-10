import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { attachDatabasePool } from '@vercel/functions/db-connections';
import type pg from 'pg';
import { createApp } from './app.factory.js';
import { APP_POOL, PLATFORM_POOL } from './database/database.module.js';

type Serve = (req: IncomingMessage, res: ServerResponse) => void;

let booting: Promise<Serve> | null = null;

/**
 * The application, built once per instance and kept for every request after.
 *
 * A failed boot is not cached: the preflights refuse to serve when isolation
 * or the region is wrong, and the next request tries again rather than the
 * instance answering 503 until it is recycled.
 */
function boot(): Promise<Serve> {
  booting ??= (async () => {
    const { app } = await createApp();
    await app.init();
    // The host suspends an instance between requests. A pooled connection
    // left open across that pause can be dead on the other side when the
    // instance wakes, and the next request would find out. Attached, each
    // pool keeps the instance awake until its idle connections have closed.
    for (const token of [APP_POOL, PLATFORM_POOL]) {
      attachDatabasePool(app.get<pg.Pool>(token));
    }
    const fastify = app.getHttpAdapter().getInstance();
    await fastify.ready();
    const serve: Serve = (req, res) => void fastify.server.emit('request', req, res);
    return serve;
  })().catch((error: unknown) => {
    booting = null;
    throw error;
  });
  return booting;
}

/**
 * Entry for a host that invokes a function per request instead of running a
 * server (apps/api/serverless/vercel.js, on Vercel). The request goes to Fastify as it
 * would from a listening socket, so routing, the raw body a webhook signature
 * needs, cookies and the error contract are the long-lived server's own.
 *
 * Workers do not run on timers here — the host freezes an idle instance — so
 * the deployment sets WORKER_MODE=cron and schedules `/api/v1/cron/:cadence`.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let serve: Serve;
  try {
    serve = await boot();
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'bootstrap failed',
        err: error instanceof Error ? error.message : String(error),
      }) + '\n',
    );
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: 'service_unavailable', message: 'The service is not available. Try again shortly.' },
      }),
    );
    return;
  }

  await new Promise<void>((resolve) => {
    res.once('close', resolve);
    serve(req, res);
  });
}
