'use client';

import type { ErrorResponse } from '@milyonuse/contracts';

export interface ClientError {
  code: string;
  message: string;
}

/**
 * Calls the API from the browser.
 *
 * Same-origin thanks to the rewrite in next.config.ts, so the session cookie
 * travels without any cross-site handling.
 *
 * Failures come back as a value rather than a thrown exception. Every caller
 * here is a form handler that has to render the message next to the field —
 * a rejected promise just moves that work somewhere less convenient.
 */
export async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: ClientError }> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    return { ok: false, error: { code: 'network', message: '' } };
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null;
    // A validation refusal's own sentence is generic; the field's is the one worth reading.
    const detail = body?.error.details?.[0]?.message;
    return {
      ok: false,
      error: { code: body?.error.code ?? 'internal_error', message: detail ?? body?.error.message ?? '' },
    };
  }

  return { ok: true, data: (await response.json().catch(() => ({}))) as T };
}
