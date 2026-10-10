import { Global, Module } from '@nestjs/common';
import { AppLogger } from '../common/logging/logger.js';
import { type Env, loadEnv } from './env.js';

export const ENV = Symbol('ENV');

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: (): Env => loadEnv() },
    { provide: AppLogger, inject: [ENV], useFactory: (env: Env) => new AppLogger(env.LOG_LEVEL) },
  ],
  exports: [ENV, AppLogger],
})
export class ConfigModule {}
