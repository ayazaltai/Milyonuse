import { createHash, timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Inject, Param, Res } from '@nestjs/common';
import { ErrorCode } from '@milyonuse/contracts';
import type { FastifyReply } from 'fastify';
import { AppError } from '../../common/app-error.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CADENCES, type Cadence, CronService } from './cron.service.js';

/**
 * The host's scheduler calling the workers (WORKER_MODE=cron).
 *
 * GET because that is what the scheduler sends. The bearer secret is the whole
 * authentication, compared in constant time; under WORKER_MODE=interval the
 * route does not exist as far as any caller can tell. A pass with a failed
 * step answers 500, so the scheduler's own log shows it.
 */
@Controller('cron')
export class CronController {
  constructor(
    private readonly cron: CronService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get(':cadence')
  async run(
    @Param('cadence') cadence: string,
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (this.env.WORKER_MODE !== 'cron' || !this.env.CRON_SECRET) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Not found.');
    }
    if (!matches(authorization, `Bearer ${this.env.CRON_SECRET}`)) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Not authorised to run the workers.');
    }
    if (!(CADENCES as readonly string[]).includes(cadence)) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Not found.');
    }

    const result = await this.cron.run(cadence as Cadence);
    void reply.status(Object.keys(result.failed).length > 0 ? 500 : 200).send(result);
  }
}

/** Constant-time over digests, so neither the content nor the length leaks. */
function matches(given: string | undefined, expected: string): boolean {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(given ?? ''), digest(expected));
}
