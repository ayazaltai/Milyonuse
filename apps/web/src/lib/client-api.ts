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

/** A file's type from its name, for a browser that does not say (some do not, for .md or .csv). */
const TYPES_BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Sends a file as the request body, its type as the content type and its name
 * in the query string — the shape the attachment route takes (apps/api
 * common/uploads.ts). No multipart form and no base64 copy of the file.
 */
export async function upload<T>(
  path: string,
  file: File | Blob,
  name: string,
): Promise<{ ok: true; data: T } | { ok: false; error: ClientError }> {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const type = file.type || TYPES_BY_EXTENSION[extension] || 'application/octet-stream';
  const separator = path.includes('?') ? '&' : '?';
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}${separator}fileName=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': type },
      body: file,
    });
  } catch {
    return { ok: false, error: { code: 'network', message: '' } };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null;
    return {
      ok: false,
      error: {
        code: body?.error.code ?? (response.status === 413 ? 'file_too_large' : 'internal_error'),
        message: body?.error.details?.[0]?.message ?? body?.error.message ?? '',
      },
    };
  }
  return { ok: true, data: (await response.json()) as T };
}

/**
 * A POST answered with server-sent events: each event's JSON is handed to
 * `onEvent` as it arrives. A refusal before the stream opens comes back as an
 * error, the same shape `request` gives; `opened` says whether anything came.
 */
export async function stream<E>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
): Promise<{ ok: true } | { ok: false; opened: boolean; error: ClientError }> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, opened: false, error: { code: 'network', message: '' } };
  }
  if (!response.ok || !response.body) {
    const failed = (await response.json().catch(() => null)) as ErrorResponse | null;
    return {
      ok: false,
      opened: false,
      error: {
        code: failed?.error.code ?? 'internal_error',
        message: failed?.error.details?.[0]?.message ?? failed?.error.message ?? '',
      },
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let opened = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        if (!data) continue;
        opened = true;
        onEvent(JSON.parse(data) as E);
      }
    }
  } catch {
    return { ok: false, opened, error: { code: 'stream_interrupted', message: '' } };
  }
  return { ok: true };
}
