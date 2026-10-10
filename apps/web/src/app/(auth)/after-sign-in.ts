'use client';

import type { Me } from '@milyonuse/contracts';
import { rememberLocale } from '@/i18n/client';
import { request } from '@/lib/client-api';
import { safeNext } from '@/lib/next-path';

/**
 * Where a fresh session goes: the page the person was on their way to, or the
 * app. The language they chose for their account becomes the language of the
 * pages too — a full navigation, so the server renders in it.
 */
export async function arrive(next: string | null): Promise<void> {
  const session = await request<Me>('/auth/session');
  if (session.ok) rememberLocale(session.data.user.locale);
  window.location.assign(safeNext(next) ?? '/app');
}
