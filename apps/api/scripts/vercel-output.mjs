// Builds the API's Vercel Build Output (https://vercel.com/docs/build-output-api)
// after `pnpm build` has compiled it. Run by apps/api/vercel.json's build command.
//
// Vercel's own Node builder is not used, deliberately: it recompiles every ESM
// file it traces into CommonJS, and the workspace packages are ESM. What ships
// instead is the artifact the container image ships — `pnpm deploy --prod` —
// with a flat node_modules, so there are no links to resolve in the function.
//
//   .vercel/output/config.json            routes: files first, then the function; the crons
//   .vercel/output/static/                apps/api/public (robots.txt)
//   .vercel/output/functions/index.func/  the deployed package, entered at serverless/vercel.js

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const api = resolve(import.meta.dirname, '..');
const root = resolve(api, '../..');
const output = join(api, '.vercel/output');
const fn = join(output, 'functions/index.func');

/** Seconds a scheduled pass may run (CronService stops starting batches well before). */
const MAX_DURATION = 300;

/**
 * Where the function runs: Frankfurt, beside the database (Neon eu-central-1, DECISIONS D-05)
 * and near Turkey. Every request makes several database
 * round trips in sequence, and each one pays the distance. Also in
 * vercel.json, so the project and the output agree.
 */
const REGIONS = ['fra1'];

// Deployed outside the package, then moved in: deploying into a directory
// inside the package being deployed would copy the output into itself.
const staging = mkdtempSync(join(tmpdir(), 'milyonuse-api-'));
execFileSync(
  'pnpm',
  ['--filter', '@milyonuse/api', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', join(staging, 'api')],
  { cwd: root, stdio: 'inherit' },
);

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'functions'), { recursive: true });
cpSync(join(staging, 'api'), fn, { recursive: true, verbatimSymlinks: true });
rmSync(staging, { recursive: true, force: true });

// Sources, tooling and host configuration have no business in the function.
for (const path of ['src', 'scripts', 'public', 'vercel.json', 'node_modules/.bin', '.vercel']) {
  rmSync(join(fn, path), { recursive: true, force: true });
}

cpSync(join(api, 'public'), join(output, 'static'), { recursive: true });

writeFileSync(
  join(fn, '.vc-config.json'),
  JSON.stringify({
    runtime: 'nodejs24.x',
    handler: 'serverless/vercel.js',
    launcherType: 'Nodejs',
    // The raw request reaches Fastify: a webhook signature is checked against
    // the unparsed body, which a helper that parses it first would consume.
    shouldAddHelpers: false,
    maxDuration: MAX_DURATION,
    regions: REGIONS,
  }),
);

writeFileSync(
  join(output, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [{ handle: 'filesystem' }, { src: '/(.*)', dest: '/index' }],
      // WORKER_MODE=cron: the workers run when these call (modules/cron).
      crons: [
        { path: '/api/v1/cron/minute', schedule: '* * * * *' },
        { path: '/api/v1/cron/quarter-hour', schedule: '*/15 * * * *' },
        { path: '/api/v1/cron/hour', schedule: '7 * * * *' },
      ],
    },
    null,
    2,
  ),
);

process.stdout.write(`vercel output written to ${output}\n`);
