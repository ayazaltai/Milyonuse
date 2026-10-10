import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return this.health.live();
  }

  @Get('ready')
  async ready(@Res() reply: FastifyReply): Promise<void> {
    const result = await this.health.ready();
    // 503 while a dependency is down, so a load balancer drains this instance
    // instead of sending it traffic it cannot serve.
    void reply.status(result.status === 'ok' ? 200 : 503).send(result);
  }
}
