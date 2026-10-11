import { randomBytes } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter.js';
import { AppLogger } from '../common/logging/logger.js';
import { registerRawBody } from '../common/raw-body.js';
import { registerRequestContext } from '../common/request-context.plugin.js';
import { registerUploads } from '../common/uploads.js';
import { API_PREFIX, UNPREFIXED_ROUTES } from '../config/routing.js';
import { APP_URL, PLATFORM_URL } from '../database/database.testing.js';
import { MAILER, type Mailer, type MailMessage } from '../modules/notifications/mail.port.js';

/**
 * The API, assembled for an end-to-end suite: the real module graph against
 * the real database, as the application role and the platform role, with mail
 * caught in an outbox the way the recipient would read it.
 *
 * Every request carries an address of the suite's own: rate-limit windows are
 * counted in the database and outlive a run, so a second run within the hour
 * would otherwise start over its limit.
 */
export interface TestApp {
  app: NestFastifyApplication;
  outbox: MailMessage[];
  address: string;
  request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options?: { payload?: unknown; cookie?: string; headers?: Record<string, string> },
  ): ReturnType<NestFastifyApplication['inject']>;
  close(): Promise<void>;
}

export const SESSION_COOKIE = 'mu_session';

/** A provider swapped for the suite's own — a scripted model in place of the router. */
export interface ProviderOverride {
  provide: unknown;
  useValue: unknown;
}

export async function createTestApp(
  env: Record<string, string> = {},
  overrides: ProviderOverride[] = [],
): Promise<TestApp> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: APP_URL,
    DATABASE_URL_PLATFORM: PLATFORM_URL,
    APP_BASE_URL: 'http://127.0.0.1:3000',
    LOG_LEVEL: 'error',
    ...env,
  });

  const outbox: MailMessage[] = [];
  const mailer: Mailer = {
    name: 'capturing',
    send: (message) => {
      outbox.push(message);
      return Promise.resolve();
    },
  };

  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAILER).useValue(mailer);
  for (const override of overrides) builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ trustProxy: true }), {
    logger: new AppLogger('error'),
    bodyParser: false,
  });
  const fastify = app.getHttpAdapter().getInstance();
  registerRequestContext(fastify);
  registerRawBody(fastify);
  registerUploads(fastify);
  app.useGlobalFilters(new AllExceptionsFilter(new AppLogger('error')));
  await app.register(fastifyCookie);
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
  await app.init();
  await fastify.ready();

  const address = `10.${randomBytes(3).join('.')}`;

  return {
    app,
    outbox,
    address,
    request: (method, url, options = {}) =>
      app.inject({
        method,
        url: url.startsWith('/health') ? url : `/${API_PREFIX}${url}`,
        headers: { 'x-forwarded-for': address, ...options.headers },
        ...(options.payload !== undefined ? { payload: options.payload as Record<string, unknown> } : {}),
        ...(options.cookie ? { cookies: { [SESSION_COOKIE]: options.cookie } } : {}),
      }),
    close: () => app.close(),
  };
}

/** The last mail to `to`. */
export function lastMail(outbox: MailMessage[], to: string): MailMessage {
  const mail = [...outbox].reverse().find((m) => m.to === to);
  if (!mail) throw new Error(`no mail to ${to}`);
  return mail;
}

/** The `token` query parameter of the link to `path` in a mail. */
export function tokenIn(mail: MailMessage, path: 'verify' | 'reset'): string {
  const match = new RegExp(`/${path}\\?token=([A-Za-z0-9_-]+)`).exec(mail.text);
  if (!match) throw new Error(`no ${path} link in "${mail.subject}"`);
  return match[1]!;
}

/** The session cookie a response set, if it set one. */
export function sessionOf(response: { cookies: { name: string; value: string }[] }): string | undefined {
  return response.cookies.find((c) => c.name === SESSION_COOKIE && c.value !== '')?.value;
}
