import { z } from 'zod';
import { type AgentTool, ToolError, tool } from '../../agent/tools/tool.js';
import type { FileStore } from './file.store.js';
import { CONTENT_TYPES, FILE_FORMATS, csv, docx, xlsx } from './writers.js';

/**
 * file_create (F3 §2): the agent writes a file into the person's own space —
 * a report, a table, a document — to download. It changes nothing outside the
 * conversation, so it is `safe` and runs as it is asked.
 */
export function fileTools(files: FileStore): AgentTool[] {
  return [
    tool({
      name: 'file_create',
      source: false,
      summary: 'Made a file',
      description:
        'Make a file for the person to download: md, txt, html or json from `content`; csv or xlsx from `rows` (the first row is the header); ' +
        'docx from `content` (lines starting with # are headings, - are bullets). Answers a download link; give it to the person. ' +
        'Write the data itself, never a formula.',
      schema: z
        .object({
          name: z.string().trim().min(1).max(100).describe('The file name, without folders; the extension is added from the format.'),
          format: z.enum(FILE_FORMATS),
          content: z.string().max(1_000_000).optional(),
          rows: z.array(z.array(z.string().max(5000)).max(200)).max(20_000).optional(),
          title: z.string().trim().max(200).optional(),
        })
        .refine((v) => (v.format === 'csv' || v.format === 'xlsx' ? v.rows !== undefined : v.content !== undefined), {
          message: 'csv and xlsx take `rows`; every other format takes `content`',
        }),
      run: async (context, args) => {
        const bytes = render(args);
        if (bytes.length === 0) throw new ToolError('The file would be empty.');
        const extension = `.${args.format}`;
        const name = args.name.toLowerCase().endsWith(extension) ? args.name : `${args.name.replace(/\.[a-z0-9]{1,5}$/i, '')}${extension}`;
        const saved = await files.save(context.principal, {
          conversationId: context.conversationId,
          name,
          contentType: CONTENT_TYPES[args.format],
          bytes,
          source: 'file_create',
        });
        return {
          kind: 'data',
          data: { file: saved, note: `Give the person the link: [${saved.name}](${saved.url}). It is kept for 30 days.` },
        };
      },
    }),
  ];
}

function render(args: { format: (typeof FILE_FORMATS)[number]; content?: string | undefined; rows?: string[][] | undefined; title?: string | undefined }): Buffer {
  switch (args.format) {
    case 'csv':
      return csv(args.rows!);
    case 'xlsx':
      return xlsx(args.rows!, args.title);
    case 'docx':
      return docx(args.content!, args.title);
    case 'json': {
      try {
        return Buffer.from(JSON.stringify(JSON.parse(args.content!), null, 2), 'utf8');
      } catch {
        throw new ToolError('`content` is not valid JSON.');
      }
    }
    default:
      return Buffer.from(args.content!, 'utf8');
  }
}
