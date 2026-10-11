import { Injectable } from '@nestjs/common';
import { AGENT_LIMITS, type AgentAttachmentView, ErrorCode, type Principal } from '@milyonuse/contracts';
import { AppError } from '../../common/app-error.js';
import { AgentStore, attachmentView } from './agent.store.js';
import { readCsv } from './files/csv-reader.js';
import { decodeText } from './files/decode-text.js';
import { DocumentError, extractDocument, isDocx, isPdf } from './files/documents.js';
import { SpreadsheetError, isXlsx, readXlsx } from './files/xlsx-reader.js';

/** A cell longer than this is not a cell anyone meant for a field. */
const MAX_CELL = 2000;

/**
 * What a person hands the agent (ported from App-Milyonus
 * `modules/agent/agent-attachment.service.ts`): tables — pasted from a
 * spreadsheet, or a CSV or .xlsx file — kept as cells; documents — PDF,
 * .docx, plain text or Markdown — kept as their text, never the file.
 *
 * Kept on the server for a few days (0006) and never sent whole to the model:
 * it is told what is attached, and reads it with read_table and
 * read_document, a page at a time.
 */
@Injectable()
export class AgentAttachmentService {
  constructor(private readonly store: AgentStore) {}

  async fromText(principal: Principal, conversationId: string, name: string, text: string): Promise<AgentAttachmentView> {
    return this.keepTable(principal, conversationId, name, readCsv(text));
  }

  async fromFile(principal: Principal, conversationId: string, name: string, data: Buffer): Promise<AgentAttachmentView> {
    if (data.length === 0) throw new AppError(ErrorCode.VALIDATION_FAILED, 'The file is empty.');
    if (data.length > AGENT_LIMITS.attachmentBytes) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Files up to 8 MB can be attached. Split this one.');
    }
    // A Word document is a zip too: tell it from a workbook first.
    if (isPdf(data) || isDocx(data)) return this.keepDocument(principal, conversationId, name, data);
    if (isXlsx(data)) {
      try {
        return await this.keepTable(principal, conversationId, name, readXlsx(data).map((row) => row.cells));
      } catch (error) {
        if (error instanceof SpreadsheetError) throw new AppError(ErrorCode.VALIDATION_FAILED, error.message);
        throw error;
      }
    }
    if (/\.(xls|doc)$/i.test(name)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'This is an old Office format. Save it as .xlsx, .docx or CSV and attach that.',
      );
    }
    const text = decodeText(data);
    // Plain text and Markdown are documents; anything else that is text is read as a table.
    if (/\.(txt|md|markdown)$/i.test(name)) return this.keepText(principal, conversationId, name, text, null);
    return this.keepTable(principal, conversationId, name, readCsv(text));
  }

  /** A PDF's or a Word document's text, never the file. */
  private async keepDocument(
    principal: Principal,
    conversationId: string,
    name: string,
    data: Buffer,
  ): Promise<AgentAttachmentView> {
    let read;
    try {
      read = await extractDocument(data);
    } catch (error) {
      if (error instanceof DocumentError) throw new AppError(ErrorCode.VALIDATION_FAILED, error.message);
      throw error;
    }
    return this.keepText(principal, conversationId, name, read.text, read.pages);
  }

  private async keepText(
    principal: Principal,
    conversationId: string,
    name: string,
    raw: string,
    pages: number | null,
  ): Promise<AgentAttachmentView> {
    const text = raw.replace(/\r\n?/g, '\n').trim().slice(0, AGENT_LIMITS.documentChars);
    if (text === '') throw new AppError(ErrorCode.VALIDATION_FAILED, 'The document has no text in it.');
    const title = name.trim().slice(0, 255) || 'Document';
    return this.store.run(principal, async (client) => {
      await this.store.conversation(client, conversationId);
      const { rows } = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO agent_attachments (organization_id, member_id, conversation_id, kind, name, text, pages, expires_at)
         VALUES ($1, $2, $3, 'document', $4, $5, $6, now() + make_interval(days => $7))
         RETURNING id, expires_at`,
        [principal.organizationId, principal.memberId, conversationId, title, text, pages, AGENT_LIMITS.attachmentDays],
      );
      return attachmentView({
        id: rows[0]!.id,
        name: title,
        rows: [],
        row_count: 0,
        column_count: 0,
        expires_at: rows[0]!.expires_at,
        kind: 'document',
        pages,
        text_length: text.length,
      });
    });
  }

  private async keepTable(
    principal: Principal,
    conversationId: string,
    name: string,
    raw: string[][],
  ): Promise<AgentAttachmentView> {
    const grid = raw
      .map((cells) => cells.map((cell) => cell.trim().slice(0, MAX_CELL)))
      .filter((cells) => cells.some((cell) => cell !== ''));
    if (grid.length === 0) throw new AppError(ErrorCode.VALIDATION_FAILED, 'The table has no lines with anything in them.');
    // A header and the table's ten thousand lines.
    if (grid.length > AGENT_LIMITS.attachmentRows + 1) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Tables up to ${AGENT_LIMITS.attachmentRows.toLocaleString('en-US')} lines can be attached. Split this one.`,
      );
    }
    const columns = Math.max(...grid.map((cells) => cells.length));
    if (columns > AGENT_LIMITS.attachmentColumns) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Tables up to ${AGENT_LIMITS.attachmentColumns} columns can be attached.`,
      );
    }
    // Every line the same width, so a column is a column.
    const rows = grid.map((cells) => [...cells, ...Array<string>(columns - cells.length).fill('')]);
    const title = name.trim().slice(0, 255) || 'Table';

    return this.store.run(principal, async (client) => {
      await this.store.conversation(client, conversationId);
      const { rows: created } = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO agent_attachments (organization_id, member_id, conversation_id, kind, name, rows, row_count,
                                        column_count, expires_at)
         VALUES ($1, $2, $3, 'table', $4, $5, $6, $7, now() + make_interval(days => $8))
         RETURNING id, expires_at`,
        [
          principal.organizationId,
          principal.memberId,
          conversationId,
          title,
          JSON.stringify(rows),
          rows.length,
          columns,
          AGENT_LIMITS.attachmentDays,
        ],
      );
      return attachmentView({
        id: created[0]!.id,
        name: title,
        rows,
        row_count: rows.length,
        column_count: columns,
        expires_at: created[0]!.expires_at,
        kind: 'table',
        pages: null,
        text_length: null,
      });
    });
  }
}
