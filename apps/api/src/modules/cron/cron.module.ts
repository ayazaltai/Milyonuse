import { Module } from '@nestjs/common';
import { CronController } from './cron.controller.js';
import { CronService } from './cron.service.js';

/**
 * Scheduled passes for a host that pauses idle processes (WORKER_MODE=cron).
 * The workers stay in their own modules; this reaches them through the module
 * graph rather than widening what each module exports.
 */
@Module({ controllers: [CronController], providers: [CronService] })
export class CronModule {}
