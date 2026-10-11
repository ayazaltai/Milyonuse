import { type FetchPublicOptions, type PublicResponse, fetchPublic } from '@milyonuse/security';

/**
 * How the tools reach the web: always through the SSRF guard
 * (@milyonuse/security fetchPublic). A token so a suite can answer in its place.
 */
export type WebFetcher = (url: string, options?: FetchPublicOptions) => Promise<PublicResponse>;

export const WEB_FETCHER = Symbol('WEB_FETCHER');

export const publicFetcher: WebFetcher = (url, options) => fetchPublic(url, options);

/** The body as text, in the charset the response names (UTF-8 otherwise). */
export function bodyText(response: PublicResponse): string {
  const charset = /charset=([\w-]+)/i.exec(response.headers['content-type'] ?? '')?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset && charset !== 'utf8' ? charset : 'utf-8').decode(response.body);
  } catch {
    return response.body.toString('utf8');
  }
}
