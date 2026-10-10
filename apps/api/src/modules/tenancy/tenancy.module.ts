import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { PrincipalService } from './principal.service.js';
import { TenantScope } from './tenant-scope.service.js';
import { PermissionGuard } from './guards/permission.guard.js';
import { PrincipalGuard } from './guards/principal.guard.js';

@Global()
@Module({
  providers: [TenantScope, AuditService, PrincipalService, PrincipalGuard, PermissionGuard],
  exports: [TenantScope, AuditService, PrincipalService, PrincipalGuard, PermissionGuard],
})
export class TenancyModule {}
