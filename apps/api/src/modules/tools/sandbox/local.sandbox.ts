import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeEnv } from '@milyonuse/security';
import {
  MAX_OUTPUT_FILES,
  MAX_OUTPUT_FILE_BYTES,
  type Sandbox,
  type SandboxResult,
  type SandboxRun,
  cap,
  sandboxName,
} from './sandbox.port.js';

/**
 * Development only (config/env.ts refuses it in production): the code runs as
 * a child process of the API in a fresh temporary directory, with an
 * environment stripped of every secret and a hard time limit. It is NOT
 * isolated — no network or file-system sandbox — which is exactly why it never
 * runs where real people's work does.
 */
export class LocalSandbox implements Sandbox {
  readonly name = 'local';

  async run(input: SandboxRun): Promise<SandboxResult> {
    const dir = await mkdtemp(join(tmpdir(), 'milyonuse-run-'));
    try {
      await mkdir(join(dir, 'in'));
      await mkdir(join(dir, 'out'));
      for (const f of input.files) await writeFile(join(dir, 'in', sandboxName(f.name)), f.bytes);
      const main = input.runtime === 'python' ? 'main.py' : 'main.mjs';
      await writeFile(join(dir, main), input.code, 'utf8');
      const [command, args] = input.runtime === 'python' ? ['python3', ['-I', main]] : [process.execPath, [main]];
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
        const child = spawn(command, args, {
          cwd: dir,
          env: { ...safeEnv(process.env), HOME: dir, TMPDIR: dir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < 200_000) stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 200_000) stderr += chunk.toString('utf8');
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, input.timeoutMs);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, timedOut });
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
        });
      });
      const files: { name: string; bytes: Buffer }[] = [];
      for (const name of (await readdir(join(dir, 'out'))).slice(0, MAX_OUTPUT_FILES)) {
        const path = join(dir, 'out', name);
        const info = await stat(path);
        if (!info.isFile() || info.size === 0 || info.size > MAX_OUTPUT_FILE_BYTES) continue;
        files.push({ name: sandboxName(name), bytes: await readFile(path) });
      }
      return { exitCode: result.code, stdout: cap(result.stdout), stderr: cap(result.stderr), timedOut: result.timedOut, files };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
