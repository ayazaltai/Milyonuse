import { ErrorCode } from '@milyonuse/contracts';
import { z } from 'zod';
import { AppError } from '../../../common/app-error.js';
import type { Env } from '../../../config/env.js';
import type { AgentStore } from '../../agent/agent.store.js';
import { type AgentTool, ToolError, tool } from '../../agent/tools/tool.js';
import type { TenantScope } from '../../tenancy/tenant-scope.service.js';
import type { UsageMeter } from '../../usage/usage.meter.js';
import type { FileStore } from '../files/file.store.js';
import { csv } from '../files/writers.js';
import { type Sandbox, SandboxUnavailable } from './sandbox.port.js';

/**
 * code_run (F3 §2): Python or Node in a sandbox with no network — for
 * analysis, conversion, charts. `caution` and reversible: it changes nothing
 * outside the sandbox, so in auto mode it runs as asked; in ask mode the
 * person sees the code first; code the pre-execution scanner blocks never
 * runs, and code it warns about is always shown first (RiskEngine).
 *
 * The person's attachments can go in as files; what the code writes to
 * `out/` comes back as files to download. Every run is recorded
 * (sandbox_sessions) and counted against the person's daily minutes.
 */
export function codeTools(deps: {
  sandbox: Sandbox;
  store: AgentStore;
  scope: TenantScope;
  files: FileStore;
  usage: UsageMeter;
  env: Env;
}): AgentTool[] {
  const { sandbox, store, scope, files, usage, env } = deps;
  return [
    tool({
      name: 'code_run',
      source: false,
      risk: 'caution',
      reversible: true,
      summary: 'Ran code in the sandbox',
      description:
        'Run Python 3.13 or Node 22 in a fresh sandbox with no network. Attachments named in `attachments` are placed under in/ ' +
        '(tables as CSV, documents as .txt); whatever the code writes to out/ comes back as files to download. Print what you need to read. ' +
        `Runs at most ${env.SANDBOX_TIMEOUT_SECONDS} seconds. Python has the standard library only unless the deployment image adds more.`,
      schema: z.object({
        language: z.enum(['python', 'node']),
        code: z.string().min(1).max(100_000),
        attachments: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).max(10).optional(),
        purpose: z.string().trim().max(200).optional().describe('One line on what the code is for — shown to the person.'),
      }),
      preview: (_context, args) => ({
        title: args.purpose ? `Run code: ${args.purpose}` : `Run ${args.language === 'python' ? 'Python' : 'Node'} code`,
        summary: `In a sandbox with no network, for at most ${env.SANDBOX_TIMEOUT_SECONDS} seconds`,
        fields: args.attachments?.length ? [{ label: 'Files', value: `${args.attachments.length} attachment(s) under in/` }] : undefined,
        body: args.code,
      }),
      run: async (context, args) => {
        if (sandbox.name === 'none') throw new ToolError('Running code is not set up on this deployment. Offer the code for the person to run instead.');
        const who = { organizationId: context.principal.organizationId, memberId: context.principal.memberId };
        const usedSeconds = await usage.today(who, 'sandbox.seconds');
        if (usedSeconds >= env.SANDBOX_DAILY_MINUTES * 60) {
          throw new AppError(ErrorCode.AGENT_BUDGET_EXCEEDED, `Today’s ${env.SANDBOX_DAILY_MINUTES} sandbox minutes are used. They start again at midnight UTC.`);
        }
        const inputs = await scope.run(who, async (client) => {
          const out: { name: string; bytes: Buffer }[] = [];
          for (const id of args.attachments ?? []) {
            const table = await store.table(client, context.conversationId, id);
            if (table) {
              out.push({ name: table.name.replace(/\.(xlsx|csv|tsv)$/i, '') + '.csv', bytes: csv(table.rows) });
              continue;
            }
            const document = await store.document(client, context.conversationId, id);
            if (!document) throw new ToolError(`There is no attachment ${id} in this conversation.`);
            out.push({ name: document.name.replace(/\.[a-z0-9]{1,5}$/i, '') + '.txt', bytes: Buffer.from(document.text, 'utf8') });
          }
          return out;
        });
        const session = await scope.run(who, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO sandbox_sessions (organization_id, member_id, conversation_id, action_id, provider, runtime)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [who.organizationId, who.memberId, context.conversationId, context.actionId ?? null, sandbox.name, args.language],
          );
          return rows[0]!.id;
        });
        const started = Date.now();
        let result;
        try {
          result = await sandbox.run({ runtime: args.language, code: args.code, files: inputs, timeoutMs: env.SANDBOX_TIMEOUT_SECONDS * 1000 });
        } catch (error) {
          await scope.run(who, (client) => client.query(`UPDATE sandbox_sessions SET status = 'failed' WHERE id = $1`, [session]));
          await usage.sandboxRun(who, (Date.now() - started) / 1000);
          if (error instanceof SandboxUnavailable) throw new ToolError(error.message);
          throw new ToolError('The sandbox could not run the code. Try again in a moment.');
        }
        await scope.run(who, (client) =>
          client.query(`UPDATE sandbox_sessions SET status = $2, exit_code = $3, external_id = $4 WHERE id = $1`, [
            session,
            result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'succeeded' : 'failed',
            result.exitCode,
            result.externalId ?? null,
          ]),
        );
        await usage.sandboxRun(who, (Date.now() - started) / 1000);
        const saved = [];
        for (const f of result.files) {
          saved.push(await files.save(context.principal, { conversationId: context.conversationId, name: f.name, contentType: typeOf(f.name), bytes: f.bytes, source: 'code_run' }));
        }
        return {
          kind: 'data',
          data: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout,
            stderr: result.stderr,
            files: saved.map((f) => ({ name: f.name, url: f.url, size: f.size })),
            note: saved.length > 0 ? 'Give the person the file links.' : undefined,
          },
        };
      },
    }),
  ];
}

const TYPES: Record<string, string> = {
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json', html: 'text/html', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function typeOf(name: string): string {
  return TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}
