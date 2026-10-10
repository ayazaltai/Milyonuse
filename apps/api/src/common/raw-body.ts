import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

/**
 * Keeps the untouched request body for routes that verify a signature.
 *
 * A webhook signature covers the exact bytes that were sent. Parsing JSON and
 * re-serialising it changes key order and whitespace, so the signature stops
 * matching — and the usual reaction to that is to weaken the check rather than
 * to keep the bytes. This keeps the bytes.
 *
 * Applied only to webhook paths: holding a raw copy of every request body would
 * double the memory cost of large uploads for no benefit.
 */
const RAW_BODY_PREFIXES = ['/api/v1/hooks/'];
/** Where a form-encoded body is read: the OAuth server's own routes (App-Milyonus MCP D-80). */
const FORM_PREFIXES = ['/api/v1/oauth/token', '/api/v1/oauth/revoke', '/api/v1/oauth/register'];

export function registerRawBody(app: FastifyInstance): void {
  // This is the application's only JSON parser: Nest is started with
  // bodyParser disabled so nothing registers a second one for the same media
  // type, which Fastify treats as an error rather than an override.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request: RawBodyRequest, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');

      if (RAW_BODY_PREFIXES.some((prefix) => request.url.startsWith(prefix))) {
        request.rawBody = text;
      }

      if (text.length === 0) {
        done(null, undefined);
        return;
      }

      try {
        done(null, JSON.parse(text));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  // OAuth's token and revocation requests are form-encoded by the standard
  // (RFC 6749 §4.1.3); every MCP client sends them that way. Read there only:
  // anywhere else a form body is refused as before, so no other route starts
  // accepting what a cross-site form could post.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (request, body: string | Buffer, done) => {
      if (!FORM_PREFIXES.some((prefix) => request.url.startsWith(prefix))) {
        done(new UnsupportedMediaTypeException('Send JSON.'), undefined);
        return;
      }
      const text = typeof body === 'string' ? body : body.toString('utf8');
      done(null, Object.fromEntries(new URLSearchParams(text)));
    },
  );
}
