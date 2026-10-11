import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { type Principal, ulidSchema } from '@milyonuse/contracts';
import type { FastifyReply } from 'fastify';
import { SessionGuard } from '../../identity/session.guard.js';
import { PermissionGuard, RequirePermission } from '../../tenancy/guards/permission.guard.js';
import { CurrentPrincipal } from '../../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../../tenancy/guards/principal.guard.js';
import { FileStore } from './file.store.js';

/** A file the agent made, downloaded by the person it was made for — never shown inline. */
@Controller('agent/files')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class FileController {
  constructor(private readonly files: FileStore) {}

  @Get(':fileId')
  async download(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string, @Res() reply: FastifyReply): Promise<void> {
    const file = await this.files.read(principal, ulidSchema.parse(fileId));
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(file.bytes);
  }
}
