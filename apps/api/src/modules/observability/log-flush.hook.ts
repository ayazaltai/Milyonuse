import type { FastifyInstance } from 'fastify';
import type { SystemLogService } from './system-log.service.js';

/**
 * Writes the lines a request logged before its response leaves.
 *
 * On a host that may suspend the instance once the response is sent, this is
 * the last moment the process is sure to be running. It costs nothing when the
 * request logged nothing worth keeping — nearly always.
 */
export function registerLogFlush(app: FastifyInstance, systemLog: SystemLogService): void {
  app.addHook('onSend', async (_request, _reply, payload) => {
    if (systemLog.pending > 0) await systemLog.flush();
    return payload;
  });
}
