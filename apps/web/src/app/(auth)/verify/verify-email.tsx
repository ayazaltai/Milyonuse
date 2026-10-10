'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Locale } from '@milyonuse/contracts';
import { Notice } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { arrive } from '../after-sign-in';

export function VerifyEmail({ locale, token }: { locale: Locale; token: string | null }) {
  const t = getDictionary(locale);
  const [error, setError] = useState<string | null>(token ? null : t.auth.verify.missing);
  // Strict mode mounts twice in development; a link is spent once.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    void request('/auth/verify', { method: 'POST', body: JSON.stringify({ token }) }).then((result) => {
      if (result.ok) void arrive(null);
      else setError(messageFor(result.error, t));
    });
  }, [token, t]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="danger">
          {t.auth.verify.failed} {error}
        </Notice>
        <Link href="/register" className="pill pill-secondary pill-block">
          {t.auth.verify.again}
        </Link>
      </div>
    );
  }

  return (
    <p className="auth-lead" style={{ display: 'flex', alignItems: 'center', gap: 10 }} role="status">
      <span className="spinner" aria-hidden="true" />
      {t.auth.verify.working}
    </p>
  );
}
