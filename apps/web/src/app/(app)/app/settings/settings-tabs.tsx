'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SettingsTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="segmented" style={{ marginBottom: 28 }} aria-label="Settings">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={pathname === tab.href ? 'page' : undefined}
          className={`segmented-item${pathname === tab.href ? ' segmented-item-active' : ''}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
