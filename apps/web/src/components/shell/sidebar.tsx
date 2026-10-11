'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  BookOpenCheck,
  Bot,
  BrainCircuit,
  House,
  Link2,
  LogOut,
  Menu,
  Settings,
  Sparkles,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import type { Locale, Me } from '@milyonuse/contracts';
import { Lockup } from '@/components/brand/lockup';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';

type Icon = React.ComponentType<{ size?: number; strokeWidth?: number }>;

interface Item {
  href: string;
  label: string;
  Icon: Icon;
  /** Not built yet: shown so the shape of the product is visible, marked "soon", not a link. */
  soon?: boolean;
}

/**
 * The signed-in shell's navigation. The sections arrive phase by phase
 * (PLAN.md §4); until a section exists it is listed and marked, never linked
 * to a page that is not there.
 */
export function Sidebar({ me, locale }: { me: Me; locale: Locale }) {
  const t = getDictionary(locale);
  const n = t.app.nav;
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const groups: { label?: string; items: Item[] }[] = [
    {
      items: [
        { href: '/app', label: n.home, Icon: House },
        { href: '/app/agent', label: n.agent, Icon: Sparkles },
      ],
    },
    {
      label: n.groupBuild,
      items: [
        { href: '/app/agents', label: n.agents, Icon: Bot },
        { href: '/app/skills', label: n.skills, Icon: BookOpenCheck },
        { href: '/app/teams', label: n.teams, Icon: Users, soon: true },
        { href: '/app/memory', label: n.memory, Icon: BrainCircuit },
      ],
    },
    {
      label: n.groupRun,
      items: [
        { href: '/app/automations', label: n.automations, Icon: Workflow, soon: true },
        { href: '/app/connections', label: n.connections, Icon: Link2 },
      ],
    },
    {
      label: n.groupAccount,
      items: [{ href: '/app/settings/profile', label: n.settings, Icon: Settings }],
    },
  ];

  // Whole segments: /app/agent is not active on /app/agents.
  const isActive = (href: string): boolean => {
    if (href === '/app') return pathname === '/app';
    const base = href.replace(/\/profile$/, '');
    return pathname === base || pathname.startsWith(`${base}/`);
  };

  async function signOut(): Promise<void> {
    setBusy(true);
    await request('/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  }

  return (
    <>
      <button className="sidebar-toggle" onClick={() => setOpen((v) => !v)} aria-label={open ? t.common.closeMenu : t.common.menu}>
        {open ? <X size={18} strokeWidth={2} /> : <Menu size={18} strokeWidth={2} />}
      </button>

      <aside className={`sidebar${open ? ' sidebar-open' : ''}`}>
        <div>
          <Link href="/app" className="brand" onClick={() => setOpen(false)} style={{ textDecoration: 'none' }}>
            <Lockup size={28} byline={t.common.byline} />
          </Link>

          <nav className="nav">
            {groups.map((group, index) => (
              <div key={group.label ?? index}>
                {group.label && <p className="nav-group-label">{group.label}</p>}
                {group.items.map((item) =>
                  item.soon ? (
                    <span key={item.href} className="nav-item" aria-disabled="true" style={{ opacity: 0.45, cursor: 'default' }}>
                      <item.Icon size={16} strokeWidth={1.8} />
                      <span style={{ flex: 1 }}>{item.label}</span>
                      <span className="tag">{t.common.soon}</span>
                    </span>
                  ) : (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      aria-current={isActive(item.href) ? 'page' : undefined}
                      className={`nav-item${isActive(item.href) ? ' nav-item-active' : ''}`}
                    >
                      <item.Icon size={16} strokeWidth={1.8} />
                      <span>{item.label}</span>
                    </Link>
                  ),
                )}
              </div>
            ))}
          </nav>
        </div>

        <div className="sidebar-foot">
          <div style={{ padding: '0 4px 12px' }}>
            <p style={{ fontSize: 13, color: 'var(--w-80)', margin: 0 }}>{me.user.name}</p>
            <p style={{ fontSize: 11.5, color: 'var(--w-35)', margin: '3px 0 0' }}>
              {me.organization.kind === 'personal' ? t.app.personal : me.organization.name}
            </p>
          </div>
          <button onClick={() => void signOut()} disabled={busy} className="nav-item">
            <LogOut size={16} strokeWidth={1.8} />
            {t.common.signOut}
          </button>
        </div>
      </aside>

      {open && <div className="scrim" onClick={() => setOpen(false)} />}
    </>
  );
}
