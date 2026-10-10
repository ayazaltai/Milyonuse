'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Monitor } from 'lucide-react';
import type { Locale, SessionSummary } from '@milyonuse/contracts';
import { Button, Notice, Panel, Tag } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';

/** A browser and system read from a user agent, in a few words. */
function deviceOf(userAgent: string | null, unknown: string): string {
  if (!userAgent) return unknown;
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : null;
  const system = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return [browser, system].filter(Boolean).join(' · ') || unknown;
}

export function SessionList({ locale, sessions }: { locale: Locale; sessions: SessionSummary[] }) {
  const t = getDictionary(locale);
  const s = t.app.settings.security;
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const when = new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  async function end(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    const result = await request(`/me/sessions/${id}`, { method: 'DELETE' });
    setBusy(null);
    if (!result.ok) setError(messageFor(result.error, t));
    else router.refresh();
  }

  return (
    <Panel title={s.sessionsTitle}>
      {error && <Notice tone="danger">{error}</Notice>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
        {sessions.map((session) => (
          <li
            key={session.id}
            style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 0', borderTop: '1px solid var(--w-06)' }}
          >
            <Monitor size={18} strokeWidth={1.6} style={{ color: 'var(--w-50)', flex: 'none' }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                {deviceOf(session.userAgent, s.unknownDevice)}
                {session.current && <Tag tone="pass">{s.thisDevice}</Tag>}
              </span>
              <span style={{ display: 'block', fontSize: 12.5, color: 'var(--w-50)', marginTop: 4 }}>
                {s.lastActive}: {when.format(new Date(session.lastSeenAt))} · {s.signedInAt}:{' '}
                {when.format(new Date(session.createdAt))}
                {session.ip ? ` · ${session.ip}` : ''}
              </span>
            </span>
            {!session.current && (
              <Button size="sm" variant="ghost" disabled={busy === session.id} onClick={() => void end(session.id)}>
                {s.endSession}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
