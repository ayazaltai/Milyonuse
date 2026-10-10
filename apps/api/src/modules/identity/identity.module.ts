import { Global, Module } from '@nestjs/common';
import { AccountService } from './account.service.js';
import { AuthController } from './auth.controller.js';
import { MeController } from './me.controller.js';
import { ProfileService } from './profile.service.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

@Global()
@Module({
  controllers: [AuthController, MeController],
  providers: [SessionService, AccountService, ProfileService, SessionGuard],
  exports: [SessionService, AccountService, ProfileService, SessionGuard],
})
export class IdentityModule {}
