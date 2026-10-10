import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import type { ErrorResponse } from '@milyonuse/contracts';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Calls the API from a Server Component.
 *
 * Server-side fetches do not carry the browser's cookies automatically, so the
 * session is forwarded explicitly. Everything is `no-store`: this is per-person
 * data, and a cached response is a response served to the wrong person.
 *
 * A read is made once per render, however many components ask for it. React's
 * `cache` is scoped to one server request, so this shares an answer between
 * the parts of one page for one person and never across requests or people.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!init || ((init.method ?? 'GET') === 'GET' && !init.headers && !init.body)) {
    return readOnce(path) as Promise<T>;
  }
  return call<T>(path, init);
}

const readOnce = cache((path: string): Promise<unknown> => call(path));

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const requestId = requestHeaders.get('x-request-id');

  const response = await fetch(`${API_ORIGIN}/api/v1${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      cookie: cookieStore.toString(),
      ...(requestId ? { 'x-request-id': requestId } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null;
    throw new ApiError(response.status, body?.error.code ?? 'internal_error', body?.error.message ?? 'Request failed');
  }

  return response.json() as Promise<T>;
}

/** Returns null instead of throwing when the caller is not signed in. */
export async function apiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}
