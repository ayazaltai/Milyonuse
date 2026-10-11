'use client';

import { useEffect, useRef, useState } from 'react';
import type { ConnectionAppView, ConnectionStartResult, ConnectionView, Locale } from '@milyonuse/contracts';
import { Button, Field, Notice, PageHead, Panel, Tag } from '@/components/ui/primitives';
import { type Dictionary, getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';

type Tone = 'pass' | 'danger';

export function ConnectionsBoard({
  locale,
  apps,
  initial,
  notice,
}: {
  locale: Locale;
  apps: ConnectionAppView[];
  initial: ConnectionView[];
  notice: { tone: Tone; text: string } | null;
}) {
  const t = getDictionary(locale);
  const c = t.app.connections;
  const [connections, setConnections] = useState(initial);
  const [message, setMessage] = useState(notice);
  const [connecting, setConnecting] = useState<ConnectionAppView | null>(null);

  // The page came back from an app's consent screen: the query has done its job.
  useEffect(() => {
    if (notice) window.history.replaceState(null, '', '/app/connections');
  }, [notice]);

  const replace = (next: ConnectionView) => setConnections((list) => list.map((x) => (x.id === next.id ? next : x)));
  const byProvider = new Map(connections.map((x) => [x.provider, x]));

  return (
    <>
      <PageHead eyebrow={c.eyebrow} title={c.titleTop} accent={c.titleAccent} lead={c.lead} />
      <div className="flex flex-col gap-6">
        {message && <Notice tone={message.tone}>{message.text}</Notice>}

        <Panel title={c.yours}>
          {connections.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--w-50)' }}>{c.none}</p>
          ) : (
            <div className="app-cards">
              {connections.map((x) => (
                <Connected key={x.id} t={t} connection={x} onChange={replace} onGone={(id) => setConnections((l) => l.filter((y) => y.id !== id))} onMessage={setMessage} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title={c.available}>
          <div className="app-cards">
            {apps.map((app) => {
              const existing = app.custom ? undefined : byProvider.get(app.provider);
              return (
                <article key={app.provider} className="app-card">
                  <p className="app-card-name">{app.name}</p>
                  <p className="app-card-text">{app.description}</p>
                  <div className="app-card-actions">
                    {app.available ? (
                      <Button size="sm" variant={existing ? 'ghost' : 'primary'} onClick={() => setConnecting(app)}>
                        {existing ? c.reconnect : c.connect}
                      </Button>
                    ) : (
                      <Tag>{c.notAvailable}</Tag>
                    )}
                    {existing && <Tag tone="pass">{c.connected}</Tag>}
                  </div>
                </article>
              );
            })}
          </div>
        </Panel>
      </div>

      {connecting && (
        <ConnectDialog
          t={t}
          app={connecting}
          onClose={() => setConnecting(null)}
          onConnected={(x) => {
            setConnections((list) => [...list.filter((y) => y.provider !== x.provider || x.provider === 'custom'), x]);
            setMessage({ tone: 'pass', text: c.justConnected });
            setConnecting(null);
          }}
        />
      )}
    </>
  );
}

function Connected({
  t,
  connection,
  onChange,
  onGone,
  onMessage,
}: {
  t: Dictionary;
  connection: ConnectionView;
  onChange: (x: ConnectionView) => void;
  onGone: (id: string) => void;
  onMessage: (m: { tone: Tone; text: string }) => void;
}) {
  const c = t.app.connections;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function call(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<void> {
    setBusy(true);
    const response = await request<ConnectionView>(`/connections/${connection.id}${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    setBusy(false);
    if (!response.ok) {
      onMessage({ tone: 'danger', text: messageFor(response.error, t) });
      return;
    }
    if (method === 'DELETE') onGone(connection.id);
    else onChange(response.data);
  }

  const tone = connection.status === 'active' ? 'pass' : connection.status === 'error' ? 'review' : 'neutral';
  return (
    <article className="app-card" data-connected>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
        <p className="app-card-name">{connection.name}</p>
        <Tag tone={tone}>{c.statuses[connection.status]}</Tag>
      </div>
      {connection.accountLabel && <p className="app-card-text" style={{ flex: 'none' }}>{c.account(connection.accountLabel)}</p>}
      {connection.lastError && <p className="app-card-text" style={{ color: 'var(--review)', flex: 'none' }}>{connection.lastError}</p>}
      {connection.tools.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--w-60)' }}>{c.tools(connection.tools.length)}</summary>
          <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'grid', gap: 6 }}>
            {connection.tools.map((tool) => (
              <li key={tool.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
                <span style={{ color: 'var(--w-80)' }}>{tool.title}</span>
                <span style={{ color: tool.risk === 'safe' ? 'var(--w-50)' : 'var(--review)' }}>{c.risks[tool.risk]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {confirming ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <p className="app-card-text" style={{ flex: 'none' }}>{c.disconnectConfirm(connection.name)}</p>
          <div className="app-card-actions">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {c.cancel}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void call('', 'DELETE')}>
              {c.disconnect}
            </Button>
          </div>
        </div>
      ) : (
        <div className="app-card-actions">
          {connection.transport === 'mcp_http' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void call('/refresh', 'POST')}>
              {c.refresh}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void call('', 'PATCH', { enabled: connection.status === 'disabled' })}>
            {connection.status === 'disabled' ? c.enable : c.disable}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            {c.disconnect}
          </Button>
        </div>
      )}
    </article>
  );
}

/** Connecting one app: its address for a custom server, a token where it takes one — or straight to its consent page. */
function ConnectDialog({ t, app, onClose, onConnected }: { t: Dictionary; app: ConnectionAppView; onClose: () => void; onConnected: (x: ConnectionView) => void }) {
  const c = t.app.connections;
  const dialog = useRef<HTMLDialogElement>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takesToken = app.provider === 'github' || app.custom;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function connect(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await request<ConnectionStartResult>('/connections', {
      method: 'POST',
      body: JSON.stringify({
        provider: app.provider,
        ...(app.custom ? { serverUrl: serverUrl.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(token.trim() ? { token: token.trim() } : {}),
      }),
    });
    if (!response.ok) {
      setBusy(false);
      setError(messageFor(response.error, t));
      return;
    }
    if (response.data.authorizeUrl) {
      // To the app's own consent page; it sends the browser back to /api/v1/connections/callback.
      window.location.assign(response.data.authorizeUrl);
      return;
    }
    setBusy(false);
    if (response.data.connection) onConnected(response.data.connection);
  }

  const needsToken = app.provider === 'github';
  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="connect-title">
      <div className="dialog-head">
        <div>
          <p className="eyebrow">{c.title}</p>
          <h2 id="connect-title" className="dialog-title">
            {app.name}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()}>
          {c.cancel}
        </Button>
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--w-60)', lineHeight: 1.6, margin: '0 0 16px' }}>{app.description}</p>
      <form onSubmit={(e) => void connect(e)} style={{ display: 'grid', gap: 14 }}>
        {app.custom && (
          <>
            <Field label={c.serverUrl}>
              <input className="control" type="url" required placeholder="https://" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            </Field>
            <Field label={c.name}>
              <input className="control" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
          </>
        )}
        {takesToken && (
          <Field label={c.token} hint={c.tokenHint}>
            <input className="control" type="password" autoComplete="off" required={needsToken} value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" disabled={busy || (app.custom && !serverUrl.trim()) || (needsToken && !token.trim())}>
            {busy ? c.connecting : c.connect}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
