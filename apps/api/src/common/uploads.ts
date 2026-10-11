import { AGENT_LIMITS, ErrorCode } from '@milyonuse/contracts';
import type { FastifyInstance } from 'fastify';
import { AppError } from './app-error.js';

/**
 * Accepts a file as the raw request body (ported from App-Milyonus
 * `common/uploads.ts`).
 *
 * The file travels as itself — its own content type, the bytes as the body,
 * the name in the query string — rather than inside a multipart form or as
 * base64 in JSON: no parser for a format this API has no other use for, and
 * no third larger copy of the file in memory.
 *
 * Only the agent's attachment route takes these types, and only it gets the
 * larger body limit; every other route keeps the global one (app.factory.ts).
 */
const FILE_TYPES = [
  'text/csv',
  'text/plain',
  'text/markdown',
  'text/tab-separated-values',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
];

const ATTACHMENT_ROUTE = /^\/api\/v1\/agent\/conversations\/[^/]+\/attachments(?:\?|$)/;

export function registerUploads(app: FastifyInstance): void {
  app.addContentTypeParser(
    FILE_TYPES,
    // A little room over the file's own limit, so an oversized file is refused in words by the service.
    { parseAs: 'buffer', bodyLimit: AGENT_LIMITS.attachmentBytes + 1024 },
    (request, body, done) => {
      if (!ATTACHMENT_ROUTE.test(request.url)) {
        // An AppError, so the refusal reaches the caller as one, not as a server fault.
        done(new AppError(ErrorCode.MALFORMED_REQUEST, 'This route does not accept files.'), undefined);
        return;
      }
      done(null, body);
    },
  );
}
