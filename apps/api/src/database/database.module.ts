import { Global, Module } from '@nestjs/common';
import { createPool } from '@milyonuse/db';
import { AppLogger } from '../common/logging/logger.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/**
 * Two pools, because two roles.
 *
 * APP_POOL connects as milyonuse_app and is subject to row-level security.
 * Every request-scoped query goes through it, inside a tenant scope.
 *
 * PLATFORM_POOL connects as milyonuse_platform, which has BYPASSRLS, and exists
 * for the handful of operations that run before a tenant is known:
 * registration, resolving a session cookie, rate limits, the queue's
 * bookkeeping. Injecting it is a visible act — that is the point.
 */
export const APP_POOL = Symbol('APP_POOL');
export const PLATFORM_POOL = Symbol('PLATFORM_POOL');

@Global()
@Module({
  providers: [
    {
      provide: APP_POOL,
      inject: [ENV, AppLogger],
      useFactory: (env: Env, logger: AppLogger) =>
        createPool({
          connectionString: env.DATABASE_URL,
          max: env.DATABASE_POOL_MAX,
          ssl: env.DATABASE_SSL,
          onError: (error) =>
            logger.warn('idle database connection failed', { pool: 'app', err: error.message }),
        }),
    },
    {
      provide: PLATFORM_POOL,
      inject: [ENV, AppLogger],
      useFactory: (env: Env, logger: AppLogger) =>
        createPool({
          // Falls back to the app connection when no platform role is
          // configured, which is the right default for a quick look and wrong
          // for production — where loadEnv() refuses to start without it.
          connectionString: env.DATABASE_URL_PLATFORM ?? env.DATABASE_URL,
          // Every signed-in request reads its session here, so this pool sees
          // one query per request — half the app pool, never fewer than four.
          max: Math.max(4, Math.ceil(env.DATABASE_POOL_MAX / 2)),
          ssl: env.DATABASE_SSL,
          onError: (error) =>
            logger.warn('idle database connection failed', {
              pool: 'platform',
              err: error.message,
            }),
        }),
    },
  ],
  exports: [APP_POOL, PLATFORM_POOL],
})
export class DatabaseModule {}
