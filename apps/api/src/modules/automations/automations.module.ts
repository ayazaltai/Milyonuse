import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { TeamsModule } from '../teams/teams.module.js';
import { ToolsModule } from '../tools/tools.module.js';
import { AutomationsController, HooksController, InboxController } from './automations.controller.js';
import { AutomationsService } from './automations.service.js';
import { AutomationsStore } from './automations.store.js';
import { HookIntake } from './hook-intake.js';
import { InboxService } from './inbox.service.js';
import { AutomationLauncher } from './launcher.js';
import { AutomationScheduler } from './scheduler.js';

/**
 * Automations — Phase 6 (docs/phases/F6-automations.md): agents and teams
 * working without the person at the screen, and the Inbox where everything
 * that waits for them is answered.
 */
@Module({
  imports: [AgentModule, MemoryModule, TeamsModule, ToolsModule],
  controllers: [AutomationsController, InboxController, HooksController],
  providers: [AutomationsStore, AutomationsService, AutomationLauncher, AutomationScheduler, HookIntake, InboxService],
  exports: [AutomationsService, AutomationScheduler, AutomationLauncher, InboxService],
})
export class AutomationsModule {}
