import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AgentModule } from './modules/agent/agent.module.js';
import { ConnectionsModule } from './modules/connections/connections.module.js';
import { CronModule } from './modules/cron/cron.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { MemoryModule } from './modules/memory/memory.module.js';
import { ModelModule } from './modules/model/model.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { ObservabilityModule } from './modules/observability/observability.module.js';
import { QueueModule } from './modules/queue/queue.module.js';
import { StudioModule } from './modules/studio/studio.module.js';
import { TenancyModule } from './modules/tenancy/tenancy.module.js';
import { ToolsModule } from './modules/tools/tools.module.js';
import { UsageModule } from './modules/usage/usage.module.js';

/**
 * Feature modules are added here as the phases land (PLAN.md §4):
 *   F0  config, database, notifications, observability, queue, tenancy,
 *       identity, cron, health
 *   F1  usage, model, agent · F2 memory · F3 connections, sandbox · F4 studio, skills
 *   F5  teams · F6 automations · F7 channels · F8 billing · F9 mcp, compliance
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    NotificationsModule,
    ObservabilityModule,
    QueueModule,
    TenancyModule,
    UsageModule,
    ModelModule,
    IdentityModule,
    MemoryModule,
    AgentModule,
    ToolsModule,
    ConnectionsModule,
    StudioModule,
    CronModule,
    HealthModule,
  ],
})
export class AppModule {}
