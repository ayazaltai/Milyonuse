import { Global, Module } from '@nestjs/common';
import { JobRegistry } from './job.js';
import { JobWorker } from './job.worker.js';

/**
 * The durable queue (0005): a table, a worker, and a registry the
 * modules that own the work fill with handlers. Global, so any module can
 * register a kind or kick the worker without a dependency cycle.
 */
@Global()
@Module({
  providers: [JobRegistry, JobWorker],
  exports: [JobRegistry, JobWorker],
})
export class QueueModule {}
