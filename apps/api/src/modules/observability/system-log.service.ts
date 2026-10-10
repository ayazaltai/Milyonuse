import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type pg from 'pg';
import { REQUEST_REJECTED } from '../../common/filters/all-exceptions.filter.js';
import { type LogEntry, type LogSink, setLogSink } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { PLATFORM_POOL } from '../../database/database.module.js';

/** Lines held between writes. Past it the oldest go, and the next write says how many. */
const BUFFER_LIMIT = 500;
/** How often lines logged outside any request (a worker's timer) are written. */
const FLUSH_INTERVAL_MS = 5_000;
/** A line's context beyond this is cut: a stack trace is useful, a megabyte of one is not. */
const CONTEXT_LIMIT = 8_000;
const MSG_LIMIT = 500;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * The kept half of the log (system_log, 0005).
 *
 * Every warning and error still goes to standard error, where the host shows it
 * for hours. The ones worth reading next week also come here: held in memory as
 * they are logged, and written in one statement — before the response of the
 * request that logged them goes out (app.factory.ts), or every few seconds for
 * what a worker logged on its own timer. A host that suspends an instance once
 * a response is sent never strands a line that was logged while serving it.
 *
 * What is kept: every error, and every warning except a refused request — a
 * 401 or a 404 is the answer the caller got, and a log of every one would bury
 * the lines that matter. A 429 is kept: someone is being held back.
 */
@Injectable()
export class SystemLogService
  implements LogSink, OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  private buffer: LogEntry[] = [];
  private dropped = 0;
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    setLogSink(this);
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flush();
    setLogSink(null);
  }

  accept(entry: LogEntry): void {
    if (!this.keeps(entry)) return;
    this.buffer.push(entry);
    if (this.buffer.length > BUFFER_LIMIT) {
      this.buffer.shift();
      this.dropped += 1;
    }
  }

  /** How many lines wait to be written. */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Writes what is held. Calls queue behind each other, so two requests ending
   * together never write the same line twice.
   */
  flush(): Promise<void> {
    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  private keeps(entry: LogEntry): boolean {
    if (entry.level === 'error') return true;
    if (entry.msg !== REQUEST_REJECTED) return true;
    const status = Number(entry.context['status']);
    return status === 429 || status >= 500;
  }

  private async write(): Promise<void> {
    if (this.buffer.length === 0 && this.dropped === 0) return;
    const batch = this.buffer;
    const dropped = this.dropped;
    this.buffer = [];
    this.dropped = 0;

    const rows = batch.map((e) => this.row(e));
    if (dropped > 0) {
      rows.push({
        at: new Date().toISOString(),
        level: 'warn',
        msg: `${dropped} log line(s) were dropped: more arrived than could be held between writes`,
        request_id: null,
        method: null,
        path: null,
        status: null,
        organization_id: null,
        context: {},
      });
    }

    try {
      await this.platform.query(
        `INSERT INTO system_log
           (at, level, msg, request_id, method, path, status, organization_id, context)
         SELECT at, level, msg, request_id, method, path, status, organization_id, context
           FROM jsonb_to_recordset($1::jsonb) AS x(
             at timestamptz, level text, msg text, request_id text, method text,
             path text, status smallint, organization_id text, context jsonb)`,
        [JSON.stringify(rows)],
      );
    } catch (error) {
      // Not through the logger: a line about failing to keep lines would be
      // one more line to keep, and the loop would never end.
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: 'system log write failed; lines kept on standard error only',
          lines: rows.length,
          err: error instanceof Error ? error.message : String(error),
        }) + '\n',
      );
    }
  }

  private row(e: LogEntry) {
    const status = Number(e.context['status']);
    let context = e.context;
    const serialised = JSON.stringify(context);
    if (serialised.length > CONTEXT_LIMIT) {
      context = { truncated: true, excerpt: serialised.slice(0, CONTEXT_LIMIT) };
    }
    return {
      at: e.at.toISOString(),
      level: e.level,
      msg: e.msg.slice(0, MSG_LIMIT) || '(empty)',
      request_id: e.requestId?.slice(0, 128) ?? null,
      method: e.method?.slice(0, 10) ?? null,
      path: e.route?.slice(0, 300) ?? null,
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      organization_id: e.organizationId && ULID.test(e.organizationId) ? e.organizationId : null,
      context,
    };
  }

  /** Deletes what is past the retention, a batch at a time. Returns how many went. */
  async purge(budgetMs = 20_000): Promise<number> {
    const started = Date.now();
    let total = 0;
    while (Date.now() - started < budgetMs) {
      const { rowCount } = await this.platform.query(
        `DELETE FROM system_log
          WHERE id IN (SELECT id FROM system_log
                        WHERE at < now() - make_interval(days => $1)
                        ORDER BY id LIMIT 5000)`,
        [this.env.LOG_RETENTION_DAYS],
      );
      total += rowCount ?? 0;
      if (!rowCount) break;
    }
    return total;
  }
}
