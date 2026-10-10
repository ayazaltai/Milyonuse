import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { PLATFORM_POOL } from '../../database/database.module.js';
import { MAILER, type Mailer } from '../notifications/mail.port.js';

/** At most one error digest in this window, however many errors arrive. */
const DIGEST_INTERVAL_MINUTES = 15;
/** Lines one digest takes; the rest wait for the next one, and the mail says so. */
const DIGEST_LIMIT = 1_000;
/** Distinct messages a digest spells out. */
const GROUPS_SHOWN = 15;

export interface DigestResult {
  sent: boolean;
  errors: number;
  reason?: 'no_recipients' | 'nothing_new' | 'too_soon' | 'send_failed';
}

/**
 * Tells the team when something breaks (ALERT_EMAILS).
 *
 * Errors in the system log go out as a digest: grouped by message, counted,
 * with the number of accounts affected and the most recent request id for
 * each. One digest in fifteen minutes at the most, so an outage is one
 * mail and not a thousand. Lines are claimed as they are mailed (alerted_at)
 * and released again if the mail could not be sent, so the next pass tries.
 */
@Injectable()
export class AlertService {
  constructor(
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {}

  get recipients(): readonly string[] {
    return this.env.ALERT_EMAILS;
  }

  /** Sends one message to every recipient. True when at least one got it. */
  async notify(subject: string, text: string): Promise<boolean> {
    let delivered = 0;
    for (const to of this.recipients) {
      try {
        await this.mailer.send({ to, subject: `[Milyonuse] ${subject}`, text });
        delivered += 1;
      } catch (error) {
        // A warning, not an error: an error here would be one more line for
        // the next digest that cannot be sent either.
        this.logger.warn('alert mail failed', {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return delivered > 0;
  }

  /** One pass: mail new errors, if any, if the last digest is old enough. */
  async digest(): Promise<DigestResult> {
    if (this.recipients.length === 0) return { sent: false, errors: 0, reason: 'no_recipients' };

    const recent = await this.platform.query<{ recent: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM system_log
          WHERE alerted_at > now() - make_interval(mins => $1)
       ) AS recent`,
      [DIGEST_INTERVAL_MINUTES],
    );
    if (recent.rows[0]?.recent) return { sent: false, errors: 0, reason: 'too_soon' };

    const claimed = await this.platform.query<{
      id: string;
      at: Date;
      msg: string;
      path: string | null;
      status: number | null;
      organization_id: string | null;
      request_id: string | null;
    }>(
      `UPDATE system_log SET alerted_at = now()
        WHERE id IN (SELECT id FROM system_log
                      WHERE level = 'error' AND alerted_at IS NULL
                      ORDER BY id
                      LIMIT $1
                      FOR UPDATE SKIP LOCKED)
        RETURNING id, at, msg, path, status, organization_id, request_id`,
      [DIGEST_LIMIT],
    );
    const lines = claimed.rows;
    if (lines.length === 0) return { sent: false, errors: 0, reason: 'nothing_new' };

    const waiting = await this.platform.query<{ n: string }>(
      `SELECT count(*) AS n FROM system_log WHERE level = 'error' AND alerted_at IS NULL`,
    );
    const { subject, text } = this.compose(lines, Number(waiting.rows[0]?.n ?? 0));

    if (await this.notify(subject, text)) return { sent: true, errors: lines.length };

    await this.platform.query(
      `UPDATE system_log SET alerted_at = NULL WHERE id = ANY($1::bigint[])`,
      [lines.map((l) => l.id)],
    );
    return { sent: false, errors: lines.length, reason: 'send_failed' };
  }

  private compose(
    lines: {
      at: Date;
      msg: string;
      path: string | null;
      status: number | null;
      organization_id: string | null;
      request_id: string | null;
    }[],
    stillWaiting: number,
  ): { subject: string; text: string } {
    const groups = new Map<
      string,
      { count: number; last: Date; orgs: Set<string>; requestId: string | null; where: string }
    >();
    for (const l of lines) {
      const where = l.path ? `${l.path}${l.status ? ` → ${l.status}` : ''}` : 'a background pass';
      const key = `${l.msg}\u0000${where}`;
      const g = groups.get(key) ?? {
        count: 0,
        last: l.at,
        orgs: new Set(),
        requestId: null,
        where,
      };
      g.count += 1;
      if (l.at >= g.last) {
        g.last = l.at;
        g.requestId = l.request_id ?? g.requestId;
      }
      if (l.organization_id) g.orgs.add(l.organization_id.trim());
      groups.set(key, g);
    }

    const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
    const first = lines[0]!.at;
    const last = lines[lines.length - 1]!.at;
    const subject = `${lines.length} error${lines.length === 1 ? '' : 's'} since ${first.toISOString().slice(11, 16)} UTC`;

    const body = [
      `${lines.length} error(s) were logged between ${first.toISOString()} and ${last.toISOString()}.`,
      '',
      ...sorted
        .slice(0, GROUPS_SHOWN)
        .flatMap(([key, g]) => [
          `• ${g.count}×  ${key.split('\u0000')[0]}`,
          `    where: ${g.where}`,
          `    accounts affected: ${g.orgs.size}`,
          ...(g.requestId ? [`    latest request id: ${g.requestId}`] : []),
          `    last seen: ${g.last.toISOString()}`,
          '',
        ]),
      ...(sorted.length > GROUPS_SHOWN
        ? [`…and ${sorted.length - GROUPS_SHOWN} other message(s).`, '']
        : []),
      ...(stillWaiting > 0
        ? [`${stillWaiting} more error(s) are waiting for the next digest.`, '']
        : []),
      'Every line is in system_log, by request id.',
      '',
      `At most one digest is sent every ${DIGEST_INTERVAL_MINUTES} minutes. Recipients: ALERT_EMAILS.`,
    ];

    return { subject, text: body.join('\n') };
  }
}
