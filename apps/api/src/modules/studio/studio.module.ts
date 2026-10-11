import { Module, type OnModuleInit } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { AgentToolbox } from '../agent/agent.toolbox.js';
import { MemoryModule } from '../memory/memory.module.js';
import { SkillReplay } from './skill-replay.js';
import { skillTools } from './skill.tools.js';
import { SkillsController } from './skills.controller.js';
import { SkillsService } from './skills.service.js';
import { StudioController } from './studio.controller.js';
import { StudioService } from './studio.service.js';
import { StudioStore } from './studio.store.js';

/**
 * The agent studio and skills — Phase 4 (docs/phases/F4-agent-studio-skills.md):
 * a person's agents and their versions, the skills library, the replay gate
 * in the durable queue, and the skill tools every agent has. A turn reads its
 * agent and skill index itself (modules/agent/profile.ts); this module writes.
 */
@Module({
  imports: [AgentModule, MemoryModule],
  controllers: [StudioController, SkillsController],
  providers: [StudioStore, StudioService, SkillsService, SkillReplay],
  exports: [StudioService, SkillsService],
})
export class StudioModule implements OnModuleInit {
  constructor(
    private readonly toolbox: AgentToolbox,
    private readonly store: StudioStore,
    private readonly skills: SkillsService,
  ) {}

  onModuleInit(): void {
    this.toolbox.add(skillTools({ store: this.store, skills: this.skills }));
  }
}
