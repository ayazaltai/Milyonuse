import { Sandbox as VercelSdkSandbox } from '@vercel/sandbox';
import type { Env } from '../../../config/env.js';
import {
  MAX_OUTPUT_FILES,
  MAX_OUTPUT_FILE_BYTES,
  type Sandbox,
  type SandboxResult,
  type SandboxRun,
  SandboxUnavailable,
  cap,
  sandboxName,
} from './sandbox.port.js';

/**
 * Vercel Sandbox (F3 §4): each run is a fresh micro-VM — created, given the
 * code and its files, run with no network at all, read back, and stopped.
 * Nothing carries over between runs. On Vercel the OIDC token authenticates;
 * elsewhere a token with its team and project.
 */
export class VercelSandbox implements Sandbox {
  readonly name = 'vercel';

  constructor(private readonly env: Env) {}

  private credentials(): { token: string; teamId: string; projectId: string } | Record<string, never> {
    if (this.env.VERCEL_TOKEN && this.env.VERCEL_TEAM_ID && this.env.VERCEL_PROJECT_ID) {
      return { token: this.env.VERCEL_TOKEN, teamId: this.env.VERCEL_TEAM_ID, projectId: this.env.VERCEL_PROJECT_ID };
    }
    if (!this.env.VERCEL_OIDC_TOKEN && !process.env['VERCEL_OIDC_TOKEN']) {
      throw new SandboxUnavailable('Vercel Sandbox has no credentials on this deployment.');
    }
    return {};
  }

  async run(input: SandboxRun): Promise<SandboxResult> {
    const sandbox = await VercelSdkSandbox.create({
      ...this.credentials(),
      runtime: input.runtime === 'python' ? 'python3.13' : 'node22',
      timeout: input.timeoutMs + 30_000,
      resources: { vcpus: 1 },
      networkPolicy: 'deny-all',
      region: 'fra1',
    });
    try {
      const main = input.runtime === 'python' ? 'main.py' : 'main.mjs';
      await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', 'in', 'out'] });
      await sandbox.writeFiles([
        { path: main, content: Buffer.from(input.code, 'utf8') },
        ...input.files.map((f) => ({ path: `in/${sandboxName(f.name)}`, content: f.bytes })),
      ]);
      const signal = AbortSignal.timeout(input.timeoutMs);
      let timedOut = false;
      let finished;
      try {
        finished = await sandbox.runCommand({ cmd: input.runtime === 'python' ? 'python3' : 'node', args: [main], signal });
      } catch (error) {
        if (!signal.aborted) throw error;
        timedOut = true;
      }
      const files: { name: string; bytes: Buffer }[] = [];
      const listing = await sandbox.runCommand({ cmd: 'find', args: ['out', '-maxdepth', '1', '-type', 'f', '-size', `-${MAX_OUTPUT_FILE_BYTES}c`] });
      for (const path of (await listing.stdout()).split('\n').filter(Boolean).slice(0, MAX_OUTPUT_FILES)) {
        const bytes = await sandbox.readFileToBuffer({ path });
        if (bytes && bytes.length > 0) files.push({ name: sandboxName(path), bytes });
      }
      return {
        exitCode: finished?.exitCode ?? null,
        stdout: cap(finished ? await finished.stdout() : ''),
        stderr: cap(finished ? await finished.stderr() : ''),
        timedOut,
        files,
        externalId: sandbox.name,
      };
    } finally {
      await sandbox.stop().catch(() => undefined);
    }
  }
}
