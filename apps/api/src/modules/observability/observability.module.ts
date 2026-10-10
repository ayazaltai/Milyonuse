import { Global, Module } from '@nestjs/common';
import { AlertService } from './alert.service.js';
import { OperationsWorker } from './operations.worker.js';
import { SystemLogService } from './system-log.service.js';

/**
 * What the team sees of its own running system: the kept log (0005), the
 * alerts mailed from it, and the upkeep of every table that only grows. Global because a log is written
 * from everywhere and an alert can be raised from anywhere.
 */
@Global()
@Module({
  providers: [SystemLogService, AlertService, OperationsWorker],
  exports: [SystemLogService, AlertService, OperationsWorker],
})
export class ObservabilityModule {}
