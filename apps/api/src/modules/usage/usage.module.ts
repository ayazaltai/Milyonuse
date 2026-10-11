import { Global, Module } from '@nestjs/common';
import { UsageMeter } from './usage.meter.js';

/** What is spent, counted where it happens; every module that spends may count. */
@Global()
@Module({
  providers: [UsageMeter],
  exports: [UsageMeter],
})
export class UsageModule {}
