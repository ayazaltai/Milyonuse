/**
 * Where code runs (F3 §4): a port with one call — run this code, with these
 * files, and give back what it printed and the files it wrote to `out/`.
 * The code never runs on the API's own host in production: Vercel Sandbox
 * (a micro-VM, no network) there, a child process in development only, and
 * nothing at all where neither is configured.
 */

export type SandboxRuntime = 'python' | 'node';

export interface SandboxRun {
  runtime: SandboxRuntime;
  code: string;
  /** Files placed beside the code under `in/`, by name. */
  files: { name: string; bytes: Buffer }[];
  timeoutMs: number;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** What the code wrote into `out/`. */
  files: { name: string; bytes: Buffer }[];
  /** The provider's id for the run, when it has one. */
  externalId?: string | undefined;
}

export interface Sandbox {
  readonly name: 'vercel' | 'local' | 'none';
  run(input: SandboxRun): Promise<SandboxResult>;
}

export const SANDBOX = Symbol('SANDBOX');

/** Bytes a run's output may bring back to the model, per stream. */
export const OUTPUT_CHARS = 30_000;
export const MAX_OUTPUT_FILES = 10;
export const MAX_OUTPUT_FILE_BYTES = 10 * 1024 * 1024;

export class SandboxUnavailable extends Error {
  override name = 'SandboxUnavailable';
}

/** No sandbox on this deployment: code_run says so and runs nothing. */
export class UnconfiguredSandbox implements Sandbox {
  readonly name = 'none';
  run(): Promise<SandboxResult> {
    return Promise.reject(new SandboxUnavailable('Running code is not set up on this deployment.'));
  }
}

export function cap(text: string): string {
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n… (${text.length - OUTPUT_CHARS} more characters cut)` : text;
}

/** A file name as a sandbox may take it: one segment, nothing hidden or climbing out. */
export function sandboxName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(0, 100);
  return base || 'file';
}
