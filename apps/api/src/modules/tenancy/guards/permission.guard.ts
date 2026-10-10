import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, type Permission, can } from '@milyonuse/contracts';
import { AppError } from '../../../common/app-error.js';
import type { RequestWithPrincipal } from './principal.decorator.js';

// Exported for the route inventory, which reads what each route requires from
// the same metadata this guard enforces.
export const PERMISSION_KEY = 'milyonuse:permission';

/** Requires `permission` in the caller's organization (`can()`, contracts/tenancy.ts). */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;
    if (!principal) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in to continue.');
    }

    const permission = this.reflector.getAllAndOverride<Permission>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (permission && !can(principal, permission)) {
      throw AppError.permissionDenied();
    }
    return true;
  }
}
