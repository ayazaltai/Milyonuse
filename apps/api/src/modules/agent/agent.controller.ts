import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import {
  type AgentAttachmentView,
  type AgentCompaction,
  type AgentConversationSummary,
  type AgentConversationView,
  type AgentSearchHit,
  type AgentStatus,
  type AgentStreamEvent,
  type AgentTurn,
  type Principal,
  agentConversationCreateSchema,
  agentConversationUpdateSchema,
  agentExportSchema,
  agentFeedbackSchema,
  agentMessageSchema,
  agentPastedTableSchema,
  agentSearchSchema,
  ulidSchema,
} from '@milyonuse/contracts';
import type { FastifyReply } from 'fastify';
import { AppError } from '../../common/app-error.js';
import { AppLogger } from '../../common/logging/logger.js';
import { RateLimit } from '../../common/rate-limit.js';
import { SessionGuard } from '../identity/session.guard.js';
import { RequirePermission, PermissionGuard } from '../tenancy/guards/permission.guard.js';
import { CurrentPrincipal } from '../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../tenancy/guards/principal.guard.js';
import { IdempotencyExempt, Idempotent } from '../tenancy/idempotency.js';
import { AgentAttachmentService } from './agent-attachment.service.js';
import { AgentExportService } from './agent.export.js';
import { AgentService } from './agent.service.js';

/**
 * The agent (ported from App-Milyonus `modules/agent/agent.controller.ts`).
 *
 * A person's own surface: conversations, messages and attachments are read
 * in the person's scope, so anyone else gets a 404. No route here changes
 * anything outside the conversation. What spends model tokens is limited per
 * member.
 */
@Controller('agent')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class AgentController {
  /**
   * How often a stream says it is still there while nothing else is sent —
   * well inside the idle timeouts of proxies. Tests shorten it.
   */
  static keepAliveMs = 15_000;

  constructor(
    private readonly agent: AgentService,
    private readonly attachments: AgentAttachmentService,
    private readonly exporter: AgentExportService,
    private readonly logger: AppLogger,
  ) {}

  /** Whether the agent is set up here, its models, today's allowance and the limits. */
  @Get()
  async status(@CurrentPrincipal() principal: Principal): Promise<AgentStatus> {
    return this.agent.status(principal);
  }

  /** Words inside the person's conversations. */
  @Get('search')
  async search(@CurrentPrincipal() principal: Principal, @Query('q') q: unknown): Promise<{ items: AgentSearchHit[] }> {
    return { items: await this.agent.search(principal, agentSearchSchema.parse({ q }).q) };
  }

  @Get('conversations')
  async list(@CurrentPrincipal() principal: Principal): Promise<{ items: AgentConversationSummary[] }> {
    return { items: await this.agent.list(principal) };
  }

  @Post('conversations')
  @Idempotent()
  async create(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<AgentConversationSummary> {
    return this.agent.create(principal, agentConversationCreateSchema.parse(body ?? {}));
  }

  @Get('conversations/:conversationId')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<AgentConversationView> {
    return this.agent.get(principal, ulidSchema.parse(conversationId));
  }

  @Patch('conversations/:conversationId')
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<AgentConversationSummary> {
    return this.agent.update(principal, ulidSchema.parse(conversationId), agentConversationUpdateSchema.parse(body));
  }

  @Delete('conversations/:conversationId')
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<{ deleted: true }> {
    return this.agent.remove(principal, ulidSchema.parse(conversationId));
  }

  /** The conversation as a Markdown document; audited. */
  @Get('conversations/:conversationId/export')
  async exportConversation(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Query('format') format: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    agentExportSchema.parse({ format: format ?? undefined });
    const file = await this.exporter.export(principal, ulidSchema.parse(conversationId));
    await reply
      .header('content-type', file.contentType)
      // An ASCII fallback and the UTF-8 name, so a Turkish title survives the download.
      .header(
        'content-disposition',
        `attachment; filename="${file.filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      )
      .header('cache-control', 'no-store')
      .send(file.body);
  }

  /** One turn: the person's message, the agent's steps and its answer. */
  @Post('conversations/:conversationId/messages')
  @Idempotent()
  @RateLimit({ limit: 20, windowSec: 60, per: 'member' })
  async send(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<AgentTurn> {
    return this.agent.send(principal, ulidSchema.parse(conversationId), agentMessageSchema.parse(body));
  }

  /**
   * The same turn, told as it happens (server-sent events): each message,
   * each step the agent takes, the answer's text as it is written, then the
   * whole turn.
   *
   * It may run as long as the function does, and a comment line every few
   * seconds keeps the connection from looking idle to a proxy while a model
   * call runs. A reader who leaves does not stop the turn: it finishes, and
   * what it did is in the conversation when they come back.
   */
  @Post('conversations/:conversationId/messages/stream')
  @IdempotencyExempt('A stream cannot be replayed; the plain messages route takes an Idempotency-Key.')
  @RateLimit({ limit: 20, windowSec: 60, per: 'member' })
  async stream(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = ulidSchema.parse(conversationId);
    const input = agentMessageSchema.parse(body);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...Object.fromEntries(Object.entries(reply.getHeaders()).map(([k, v]) => [k, String(v)])),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    let gone = false;
    raw.on('close', () => {
      gone = true;
    });
    const write = (text: string) => {
      if (!gone && !raw.writableEnded) raw.write(text);
    };
    const send = (event: AgentStreamEvent) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const beat = setInterval(() => write(': keep-alive\n\n'), AgentController.keepAliveMs);
    try {
      const turn = await this.agent.send(principal, id, input, send, { streamed: true });
      send({ type: 'done', turn });
    } catch (error) {
      if (!(error instanceof AppError)) {
        this.logger.error('agent stream failed', { err: error instanceof Error ? error.message : String(error) });
      }
      send({
        type: 'error',
        code: error instanceof AppError ? error.code : 'internal_error',
        message: error instanceof AppError ? error.message : 'Something went wrong. Try again.',
      });
    } finally {
      clearInterval(beat);
      if (!raw.writableEnded) raw.end();
    }
  }

  /** Asks the turn this conversation is running to stop. Asking again changes nothing. */
  @Post('conversations/:conversationId/stop')
  @HttpCode(202)
  @IdempotencyExempt('Asking to stop again is the same request; nothing is created.')
  async stop(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<{ stopping: true }> {
    return this.agent.stop(principal, ulidSchema.parse(conversationId));
  }

  /**
   * /compact: the agent summarises the conversation so far and reads that
   * summary from now on. The transcript is untouched. A summary is a model
   * call, metered and limited like a message.
   */
  @Post('conversations/:conversationId/compact')
  @Idempotent()
  @RateLimit({ limit: 10, windowSec: 60, per: 'member' })
  async compact(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<AgentCompaction> {
    return this.agent.compact(principal, ulidSchema.parse(conversationId));
  }

  /**
   * A table or a document for the agent: the file as the body (its name in
   * the query — common/uploads.ts), or `{ name, text }` for a table pasted
   * from a spreadsheet.
   */
  @Post('conversations/:conversationId/attachments')
  @Idempotent()
  @RateLimit({ limit: 30, windowSec: 600, per: 'member' })
  async attach(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Query('fileName') fileName: string | undefined,
    @Body() body: unknown,
  ): Promise<AgentAttachmentView> {
    const id = ulidSchema.parse(conversationId);
    if (Buffer.isBuffer(body)) {
      return this.attachments.fromFile(principal, id, (fileName ?? 'File').slice(0, 255), body);
    }
    const pasted = agentPastedTableSchema.parse(body);
    return this.attachments.fromText(principal, id, pasted.name, pasted.text);
  }

  /** The person's rating of an answer: up or down, and why. Rating again replaces it. */
  @Put('messages/:messageId/feedback')
  @IdempotencyExempt('Rating again sets the same rating; nothing is created twice.')
  async feedback(
    @CurrentPrincipal() principal: Principal,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ): Promise<{ messageId: string; rating: 1 | -1; note: string }> {
    return this.agent.rate(principal, ulidSchema.parse(messageId), agentFeedbackSchema.parse(body));
  }
}
