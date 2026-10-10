import 'reflect-metadata';
import type pg from 'pg';
import { createApp } from './app.factory.js';
import { APP_POOL, PLATFORM_POOL } from './database/database.module.js';

async function bootstrap(): Promise<void> {
  const { app, env, logger } = await createApp();

  await app.listen({ port: env.PORT, host: env.HOST });

  logger.log('api listening', { port: env.PORT, env: env.NODE_ENV });

  // Drain in order: stop accepting connections, let in-flight requests finish,
  // then close the pool. Closing the pool first would fail those requests.
  const shutdown = async (signal: string): Promise<void> => {
    logger.log('shutting down', { signal });
    try {
      await app.close();
      await app.get<pg.Pool>(APP_POOL).end();
      await app.get<pg.Pool>(PLATFORM_POOL).end();
      process.exit(0);
    } catch (error) {
      logger.error('shutdown failed', { err: String(error) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'bootstrap failed',
      err: error instanceof Error ? error.message : String(error),
    }) + '\n',
  );
  process.exit(1);
});
