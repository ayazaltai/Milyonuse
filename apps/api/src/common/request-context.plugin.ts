import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requestContext } from './logging/logger.js';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Opens an AsyncLocalStorage scope for every request so logs, errors and (later)
 * traces correlate without passing a context object down each call.
 *
 * An inbound x-request-id is honoured so a trace survives across services, but
 * it is length-capped and sanitised first: it is attacker-controlled input that
 * ends up in log lines.
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const inbound = request.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const requestId =
      candidate && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : randomUUID();

    void reply.header(REQUEST_ID_HEADER, requestId);
    // The route's pattern, not the path: a path can carry a credential — a
    // one-time token, say — and this goes into kept logs.
    const route = request.routeOptions.url;
    requestContext.run({ requestId, method: request.method, ...(route ? { route } : {}) }, done);
  });
}
