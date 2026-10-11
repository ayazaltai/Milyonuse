import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AgentModule } from '../agent/agent.module.js';
import { AgentStore } from '../agent/agent.store.js';
import { AgentToolbox } from '../agent/agent.toolbox.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';
import { UsageMeter } from '../usage/usage.meter.js';
import { FileController } from './files/file.controller.js';
import { FileStore } from './files/file.store.js';
import { fileTools } from './files/file.tools.js';
import { codeTools } from './sandbox/code.tools.js';
import { LocalSandbox } from './sandbox/local.sandbox.js';
import { SANDBOX, type Sandbox, UnconfiguredSandbox } from './sandbox/sandbox.port.js';
import { VercelSandbox } from './sandbox/vercel.sandbox.js';
import { WEB_FETCHER, type WebFetcher, publicFetcher } from './web/fetcher.js';
import { searchProviderFor } from './web/search.js';
import { webTools } from './web/web.tools.js';

export function sandboxFor(env: Env): Sandbox {
  if (env.SANDBOX_PROVIDER === 'vercel') return new VercelSandbox(env);
  if (env.SANDBOX_PROVIDER === 'local' && env.NODE_ENV !== 'production') return new LocalSandbox();
  return new UnconfiguredSandbox();
}

/**
 * The tools everyone has beyond the core (F3 §2): the web, files, and code in
 * a sandbox — registered into the agent's toolbox when the module starts.
 */
@Module({
  imports: [AgentModule],
  controllers: [FileController],
  providers: [
    FileStore,
    { provide: WEB_FETCHER, useValue: publicFetcher },
    { provide: SANDBOX, inject: [ENV], useFactory: sandboxFor },
  ],
  exports: [FileStore, WEB_FETCHER, SANDBOX],
})
export class ToolsModule implements OnModuleInit {
  constructor(
    private readonly toolbox: AgentToolbox,
    private readonly store: AgentStore,
    private readonly files: FileStore,
    private readonly scope: TenantScope,
    private readonly usage: UsageMeter,
    @Inject(WEB_FETCHER) private readonly fetcher: WebFetcher,
    @Inject(SANDBOX) private readonly sandbox: Sandbox,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.toolbox.add([
      ...webTools(this.fetcher, () => searchProviderFor(this.env, this.fetcher), this.usage),
      ...fileTools(this.files),
      ...codeTools({ sandbox: this.sandbox, store: this.store, scope: this.scope, files: this.files, usage: this.usage, env: this.env }),
    ]);
    if (this.sandbox.name === 'local') this.logger.warn('code_run uses the local sandbox: development only, not isolated');
  }
}
