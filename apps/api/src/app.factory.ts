import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type pg from 'pg';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { AppLogger } from './common/logging/logger.js';
import { registerRawBody } from './common/raw-body.js';
import { registerRequestContext } from './common/request-context.plugin.js';
import { ENV } from './config/config.module.js';
import type { Env } from './config/env.js';
import { loadEnv } from './config/env.js';
import { API_PREFIX, UNPREFIXED_ROUTES } from './config/routing.js';
import { APP_POOL } from './database/database.module.js';
import { registerLogFlush } from './modules/observability/log-flush.hook.js';
import { SystemLogService } from './modules/observability/system-log.service.js';
import { assertRlsEnforced, runRlsPreflight } from './database/rls-preflight.js';

/**
 * The application, assembled and proven safe to serve — but not yet serving.
 *
 * Shared by the long-lived server (main.ts), which listens on a port, and the
 * serverless entry (serverless.ts), which hands the host's requests straight
 * to Fastify. Both get the same plugins, the same filters and the same
 * preflights, so neither can serve an API the other would refuse.
 */
export async function createApp(): Promise<{ app: NestFastifyApplication; env: Env; logger: AppLogger }> {
  // Validated before Nest starts, so a configuration mistake fails in the first
  // second of a deploy rather than on the first request that needs the value.
  const bootEnv = loadEnv();
  const logger = new AppLogger(bootEnv.LOG_LEVEL);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      // Cap request bodies globally; individual routes that accept uploads
      // raise their own limit rather than every route carrying the risk.
      bodyLimit: 1 * 1024 * 1024,
    }),
    {
      logger,
      bufferLogs: true,
      // Nest installs its own JSON body parser during init, which would collide
      // with the one registered below. Ours has to be the one in place, because
      // webhook signature verification needs the unparsed bytes.
      bodyParser: false,
    },
  );

  const env = app.get<Env>(ENV);

  const fastify = app.getHttpAdapter().getInstance();
  registerRequestContext(fastify);
  registerRawBody(fastify);
  registerLogFlush(fastify, app.get(SystemLogService));
  app.useGlobalFilters(new AllExceptionsFilter(logger));

  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    // This API serves JSON, never HTML, so the browser-facing directives that
    // matter live on the web app (apps/web/src/proxy.ts). What is useful here
    // is the transport and sniffing protection.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-request-id'],
    maxAge: 600,
  });

  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });

  app.enableShutdownHooks();

  // Before accepting a single request, prove that tenant isolation is on.
  // In development this is a warning so a fresh checkout still runs; anywhere
  // else it is fatal, because serving traffic without RLS is worse than not
  // serving traffic.
  const preflight = await runRlsPreflight(app.get<pg.Pool>(APP_POOL));
  try {
    assertRlsEnforced(preflight);
    logger.log('rls preflight passed', { role: preflight.role });
  } catch (error) {
    if (env.NODE_ENV === 'production') throw error;
    logger.warn('rls preflight failed — development only', {
      role: preflight.role,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return { app, env, logger };
}
