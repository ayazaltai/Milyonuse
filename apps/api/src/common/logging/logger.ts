import { Injectable, type LoggerService, Scope } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { redact, scrub } from './redact.js';

export interface RequestContext {
  requestId: string;
  organizationId?: string;
  userId?: string;
  method?: string;
  /** The route's pattern (`/api/v1/me/sessions/:sessionId`), never the values in it. */
  route?: string;
}

/** Carries request identity to every log line without threading it through calls. */
export const requestContext = new AsyncLocalStorage<RequestContext>();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/** A warning or an error, masked exactly as the line written to standard error. */
export interface LogEntry {
  at: Date;
  level: 'warn' | 'error';
  msg: string;
  requestId?: string;
  organizationId?: string;
  method?: string;
  route?: string;
  context: Record<string, unknown>;
}

/** Somewhere warnings and errors are kept beyond the process (modules/observability). */
export interface LogSink {
  accept(entry: LogEntry): void;
}

/**
 * One per process, like standard error. Logger instances are built in more
 * than one place — at boot before Nest exists, and by the config module — and
 * every one of them has to reach the same destination.
 */
let sink: LogSink | null = null;

export function setLogSink(next: LogSink | null): void {
  sink = next;
}

/**
 * Structured JSON logging.
 *
 * One object per line so a log pipeline can index fields rather than parse
 * prose. Every line passes through `redact` (./redact.ts) before it is written.
 */
@Injectable({ scope: Scope.DEFAULT })
export class AppLogger implements LoggerService {
  constructor(private readonly minLevel: LogLevel = 'info') {}

  /**
   * Nest's LoggerService calls these with a trailing *string* context name
   * ("NestFactory", "RoutesResolver"), while our own call sites pass a metadata
   * object. Spreading without checking turns a string into {"0":"N","1":"e",...}
   * and corrupts every framework log line, so the two shapes are separated here.
   */
  private normalise(meta: unknown): Record<string, unknown> {
    if (meta === undefined || meta === null) return {};
    if (typeof meta === 'string') return { context: meta };
    if (typeof meta === 'object' && !Array.isArray(meta)) return meta as Record<string, unknown>;
    return { detail: String(meta) };
  }

  private write(level: LogLevel, message: unknown, meta?: unknown): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;

    const ctx = requestContext.getStore();
    const at = new Date();
    const msg = scrub(typeof message === 'string' ? message : String(message));
    const fields = redact(this.normalise(meta)) as Record<string, unknown>;
    const line = JSON.stringify({
      ts: at.toISOString(),
      level,
      msg,
      ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx?.organizationId ? { organizationId: ctx.organizationId } : {}),
      ...(ctx?.userId ? { userId: ctx.userId } : {}),
      ...fields,
    });

    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
      if (sink) {
        try {
          sink.accept({
            at,
            level,
            msg,
            ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
            ...(ctx?.organizationId ? { organizationId: ctx.organizationId } : {}),
            ...(ctx?.method ? { method: ctx.method } : {}),
            ...(ctx?.route ? { route: ctx.route } : {}),
            context: fields,
          });
        } catch {
          // Keeping a line must never be what breaks the code that logged it.
        }
      }
    } else process.stdout.write(line + '\n');
  }

  log(message: unknown, meta?: unknown): void {
    this.write('info', message, meta);
  }
  debug(message: unknown, meta?: unknown): void {
    this.write('debug', message, meta);
  }
  warn(message: unknown, meta?: unknown): void {
    this.write('warn', message, meta);
  }
  error(message: unknown, meta?: unknown): void {
    this.write('error', message, meta);
  }
}
