/**
 * `pnpm dev` for the API: compile, serve, and do both again on every change.
 *
 * Node cannot run these sources directly. Nest resolves constructor
 * dependencies from decorator metadata that only the compiler emits, and the
 * sources import one another by their compiled `.js` names — type stripping
 * starts a process that cannot find its own modules. So development runs what
 * production runs, the compiler's output: `tsc --watch` rebuilds dist/, and
 * `node --watch` restarts the server when it does. The server starts only
 * after a clean compile, so it never boots from a half-written dist/.
 *
 * The repository's `.env.local` is loaded when present; variables already set
 * in the shell win, the way Node's --env-file always behaves.
 *
 * One process owns both children, so stopping it stops them. A watcher left
 * running in the background is how an old build ends up answering on :4000.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(packageRoot, '..', '..', '.env.local');
const tsc = join(packageRoot, 'node_modules', '.bin', 'tsc');

const children = new Set();

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: packageRoot, ...options });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
  return child;
}

let stopping = false;
function stop(code) {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const compiler = run(tsc, ['-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});

let server = null;
compiler.stdout.setEncoding('utf8');
compiler.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  const clean = /Found 0 errors\. Watching for file changes/.test(chunk);
  if (clean && !server && !stopping) {
    server = run(
      process.execPath,
      [...(existsSync(envFile) ? [`--env-file=${envFile}`] : []), '--watch', 'dist/main.js'],
      { stdio: 'inherit' },
    );
  }
});
