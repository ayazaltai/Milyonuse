import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { PLATFORM_POOL } from '../../database/database.module.js';
import { WEB_FETCHER, type WebFetcher, bodyText } from '../tools/web/fetcher.js';
import { htmlToText } from '../tools/web/html.js';
import { type AutomationRow, AutomationsStore, type Owner } from './automations.store.js';
import { draftFrom } from './draft.js';
import { AutomationLauncher } from './launcher.js';

/** What a monitor keeps of a page, and hands a run of what changed. */
const EXCERPT_CHARS = 4000;

interface Due {
  id: string;
  organization_id: string;
  member_id: string;
  kind: AutomationRow['kind'];
  due_at: Date;
}

export interface PassCounts {
  due: number;
  accepted: number;
  checked: number;
  changed: number;
  ended: number;
}

/**
 * The proactive side of automations (F6 §1): the minute pass and the hourly
 * suggestions.
 *
 * The minute pass claims what is due by moving its next run forward in one
 * statement — SKIP LOCKED, so two processes never claim the same automation —
 * and then, in the owner's scope: a schedule or a goal is given an event keyed
 * by the instant it was due, so a pass run twice starts one run; a monitor
 * reads its page and starts a run only when the page changed (a check with no
 * change costs no model call); a goal past its last day stops with a notice.
 *
 * The suggestions read what a person keeps asking for — the same words on
 * three days in a month — and offer an automation in their Inbox. Nothing is
 * made until they say so.
 */
@Injectable()
export class AutomationScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly store: AutomationsStore,
    private readonly launcher: AutomationLauncher,
    @Inject(WEB_FETCHER) private readonly fetcher: WebFetcher,
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {}

  /** Where no scheduler calls the cron route (WORKER_MODE=interval). Tests drive the passes by hand. */
  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test' || this.env.WORKER_MODE === 'cron') return;
    const every = (ms: number, work: () => Promise<unknown>, name: string) => {
      const timer = setInterval(() => {
        work().catch((error: unknown) => this.logger.error(`${name} failed`, { err: error instanceof Error ? error.message : String(error) }));
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(60_000, () => this.tick(), 'automation pass');
    every(60 * 60_000, () => this.suggest(), 'automation suggestions');
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  // ──────────────────────────────────────────────────────────── minute pass

  async tick(now = new Date()): Promise<PassCounts> {
    const counts: PassCounts = { due: 0, accepted: 0, checked: 0, changed: 0, ended: 0 };
    const due = await this.claim(now);
    counts.due = due.length;
    for (const item of due) {
      try {
        const outcome = await this.handle(item, now);
        if (outcome === 'accepted') counts.accepted += 1;
        if (outcome === 'checked' || outcome === 'changed') counts.checked += 1;
        if (outcome === 'changed') {
          counts.changed += 1;
          counts.accepted += 1;
        }
        if (outcome === 'ended') counts.ended += 1;
      } catch (error) {
        this.logger.error('automation not handled', { automationId: item.id, err: error instanceof Error ? error.message : String(error) });
      }
    }
    if (counts.accepted > 0) this.launcher.kick();
    return counts;
  }

  /**
   * Claims what is due by moving its next run past now. A pass that missed
   * several runs — the process was down — starts one, not the backlog.
   */
  private async claim(now: Date): Promise<Due[]> {
    // PLATFORM_POOL: what is due spans tenants; the work on each is done in its owner's scope.
    const { rows } = await this.platform.query<Due>(
      `WITH due AS (
         SELECT id, next_run_at FROM automations
          WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1
          ORDER BY next_run_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED)
       UPDATE automations a
          SET next_run_at = app.automation_next(a.cadence, a.weekdays, a.month_day, a.local_time, a.every_hours, a.time_zone, $1)
         FROM due
        WHERE a.id = due.id
       RETURNING a.id, a.organization_id, a.member_id, a.kind::text AS kind, due.next_run_at AS due_at`,
      [now, this.env.MONITOR_BATCH],
    );
    return rows;
  }

  private async handle(item: Due, now: Date): Promise<'accepted' | 'checked' | 'changed' | 'ended' | 'none'> {
    const principal = await this.launcher.principalOf(item.organization_id, item.member_id);
    if (!principal) return 'none';
    const owner: Owner = principal;
    const at = item.due_at.toISOString();
    if (item.kind === 'monitor') return this.check(owner, item.id, at);
    return this.store.run(owner, async (client) => {
      const automation = await this.store.get(client, item.id, true);
      if (!automation.enabled) return 'none';
      if (automation.kind === 'goal' && automation.goal_until) {
        const { rows } = await client.query<{ past: boolean }>(`SELECT ($1::date < ($2::timestamptz AT TIME ZONE $3)::date) AS past`, [
          automation.goal_until,
          now,
          automation.time_zone,
        ]);
        if (rows[0]!.past) {
          await this.store.update(client, automation.id, { enabled: false, paused_reason: `Its goal period ended on ${automation.goal_until}.` });
          await this.store.addInboxItem(client, owner, {
            kind: 'notice',
            title: `${automation.name}: the goal period ended`,
            body: `It ran until ${automation.goal_until} and has stopped. Turn it on again with a later date to keep going.`,
            link: `/app/automations/${automation.id}`,
            automationId: automation.id,
            dedupeKey: `goal-ended:${automation.id}:${automation.goal_until}`,
          });
          return 'ended';
        }
      }
      const trigger = await this.launcher.accept(client, owner, automation, {
        source: automation.kind === 'goal' ? 'goal' : 'schedule',
        dedupeKey: `${automation.kind}:${at}`,
        payload: automation.kind === 'goal' ? { goalUntil: automation.goal_until, dueAt: at } : {},
      });
      return trigger ? 'accepted' : 'none';
    });
  }

  /**
   * Reads a monitor's page and compares it with the last reading. The first
   * reading is the baseline; a change starts a run, given the page before and
   * after; no change starts nothing.
   */
  private async check(owner: Owner, automationId: string, at: string): Promise<'checked' | 'changed' | 'none'> {
    const automation = await this.store.run(owner, (client) => this.store.get(client, automationId));
    if (!automation.enabled || !automation.monitor_url) return 'none';
    let text: string;
    try {
      const response = await this.fetcher(automation.monitor_url, { timeoutMs: 15_000, maxBytes: 2_000_000 });
      if (response.status >= 400) throw new Error(`the page answered ${response.status}`);
      const body = bodyText(response);
      const html = /html/i.test(response.headers['content-type'] ?? '') || /<html[\s>]/i.test(body.slice(0, 2000));
      text = (html ? htmlToText(body, response.url).text : body).replace(/\s+/g, ' ').trim();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.store.run(owner, (client) =>
        this.store.addInboxItem(client, owner, {
          kind: 'alert',
          title: `${automation.name} could not read its page`,
          body: `${automation.monitor_url}: ${reason}`.slice(0, 2000),
          link: `/app/automations/${automation.id}`,
          automationId: automation.id,
          dedupeKey: `monitor-unread:${automation.id}:${at.slice(0, 10)}`,
        }),
      );
      return 'none';
    }
    const hash = createHash('sha256').update(text).digest('hex');
    const excerpt = text.slice(0, EXCERPT_CHARS);
    return this.store.run(owner, async (client) => {
      const previous = await this.store.monitor(client, automation.id);
      const changed = typeof previous?.last_hash === 'string' && previous.last_hash !== hash;
      await this.store.observe(client, owner, automation.id, hash, excerpt, changed);
      if (!changed) return 'checked';
      const trigger = await this.launcher.accept(client, owner, automation, {
        source: 'monitor',
        dedupeKey: `monitor:${hash}`,
        payload: {
          url: automation.monitor_url,
          condition: automation.monitor_condition,
          before: (previous?.last_excerpt ?? '').slice(0, 6000),
          now: excerpt,
        },
      });
      return trigger ? 'changed' : 'checked';
    });
  }

  // ────────────────────────────────────────────────────────── suggestions

  /** Offers an automation for what a person asked on three different days this month. */
  async suggest(): Promise<number> {
    // PLATFORM_POOL: which people were active spans tenants; what they asked is read in their own scope.
    const { rows: people } = await this.platform.query<{ organization_id: string; member_id: string }>(
      `SELECT DISTINCT organization_id, member_id FROM agent_conversations WHERE last_message_at > now() - interval '1 day' LIMIT 500`,
    );
    let offered = 0;
    for (const person of people) {
      const owner: Owner = { organizationId: person.organization_id, memberId: person.member_id };
      try {
        offered += await this.store.run(owner, async (client) => {
          const { rows } = await client.query<{ sample: string }>(
            `SELECT min(m.content) AS sample
               FROM agent_messages m
               JOIN agent_conversations c ON c.id = m.conversation_id
              WHERE c.member_id = $1 AND m.role = 'user' AND m.created_at > now() - interval '30 days'
                AND char_length(m.content) BETWEEN 12 AND 600
                AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.automation_id IS NOT NULL)
              GROUP BY lower(regexp_replace(btrim(m.content), '\\s+', ' ', 'g'))
             HAVING count(DISTINCT (m.created_at AT TIME ZONE 'UTC')::date) >= 3
                AND NOT EXISTS (SELECT 1 FROM automations a WHERE lower(a.prompt) = lower(regexp_replace(btrim(min(m.content)), '\\s+', ' ', 'g')))
              LIMIT 3`,
            [person.member_id],
          );
          for (const row of rows) {
            const draft = draftFrom(row.sample);
            if (draft.kind === 'manual') {
              draft.kind = 'schedule';
              draft.cadence = 'daily';
              draft.localTime = '09:00';
              draft.understood.unshift('every day at 09:00 — change it if you ask on other days');
            }
            const key = createHash('sha256').update(row.sample.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
            await this.store.addInboxItem(client, owner, {
              kind: 'suggestion',
              title: `Automate “${draft.name.slice(0, 80)}”?`,
              body: 'You asked this on three different days this month. An automation could do it for you — look it over first.',
              link: '/app/automations',
              payload: draft,
              dedupeKey: `suggest:${key}`,
            });
          }
          return rows.length;
        });
      } catch (error) {
        this.logger.warn('automation suggestions skipped', { memberId: person.member_id, err: error instanceof Error ? error.message : String(error) });
      }
    }
    return offered;
  }
}
