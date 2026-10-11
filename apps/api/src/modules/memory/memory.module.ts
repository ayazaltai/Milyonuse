import { Module } from "@nestjs/common";
import { AppLogger } from "../../common/logging/logger.js";
import { ENV } from "../../config/config.module.js";
import type { Env } from "../../config/env.js";
import { MEMORY_EMBEDDER, embedderFor } from "./embedder.js";
import { MemoryController } from "./memory.controller.js";
import { MemoryService } from "./memory.service.js";
import { MemoryStore } from "./memory.store.js";
import { MemoryWorker } from "./memory.worker.js";
import { OperatorController } from "./operator.controller.js";

/**
 * Verified memory — Phase 2 (docs/phases/F2-verified-memory.md): the pipeline
 * every memory passes, recall, the Memory page's routes, the operator's signed
 * T0, and the hourly consolidation.
 */
@Module({
  controllers: [MemoryController, OperatorController],
  providers: [
    {
      provide: MEMORY_EMBEDDER,
      inject: [ENV, AppLogger],
      useFactory: (env: Env, logger: AppLogger) => embedderFor(env, logger),
    },
    MemoryStore,
    MemoryService,
    MemoryWorker,
  ],
  exports: [MemoryService, MemoryWorker],
})
export class MemoryModule {}
