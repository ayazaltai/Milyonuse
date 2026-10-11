import type { Env } from '../../../config/env.js';
import { decodeEntities } from './html.js';
import { type WebFetcher, bodyText } from './fetcher.js';

/**
 * Web search behind one port (ported from Agent 5.5 `research/search.py`):
 * Brave or Tavily with a key, and a keyless fallback that reads
 * DuckDuckGo's HTML results — so the agent can search on a deployment with no
 * provider at all, and better with one.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

export class SearchFailed extends Error {
  override name = 'SearchFailed';
}

export function searchProviderFor(env: Env, fetcher: WebFetcher): SearchProvider {
  if (env.WEB_SEARCH_PROVIDER === 'brave' && env.BRAVE_API_KEY) return new BraveSearch(env.BRAVE_API_KEY, fetcher);
  if (env.WEB_SEARCH_PROVIDER === 'tavily' && env.TAVILY_API_KEY) return new TavilySearch(env.TAVILY_API_KEY, fetcher);
  return new DuckDuckGoSearch(fetcher);
}

export class BraveSearch implements SearchProvider {
  readonly name = 'brave';
  constructor(
    private readonly key: string,
    private readonly fetcher: WebFetcher,
  ) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const response = await this.fetcher(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
      { headers: { accept: 'application/json', 'x-subscription-token': this.key }, timeoutMs: 10_000, maxBytes: 1_000_000 },
    );
    if (response.status !== 200) throw new SearchFailed(`The search provider answered ${response.status}.`);
    const data = JSON.parse(bodyText(response)) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (data.web?.results ?? [])
      .filter((r) => r.url)
      .slice(0, limit)
      .map((r) => ({ title: strip(r.title ?? r.url!), url: r.url!, snippet: strip(r.description ?? '') }));
  }
}

export class TavilySearch implements SearchProvider {
  readonly name = 'tavily';
  constructor(
    private readonly key: string,
    private readonly fetcher: WebFetcher,
  ) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const response = await this.fetcher('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
      timeoutMs: 15_000,
      maxBytes: 1_000_000,
    });
    if (response.status !== 200) throw new SearchFailed(`The search provider answered ${response.status}.`);
    const data = JSON.parse(bodyText(response)) as { results?: { title?: string; url?: string; content?: string }[] };
    return (data.results ?? [])
      .filter((r) => r.url)
      .slice(0, limit)
      .map((r) => ({ title: strip(r.title ?? r.url!), url: r.url!, snippet: strip(r.content ?? '').slice(0, 400) }));
  }
}

/** The keyless fallback: DuckDuckGo's HTML results page. */
export class DuckDuckGoSearch implements SearchProvider {
  readonly name = 'duckduckgo';
  constructor(private readonly fetcher: WebFetcher) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const response = await this.fetcher(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { accept: 'text/html' },
      timeoutMs: 10_000,
      maxBytes: 1_500_000,
    });
    if (response.status !== 200) throw new SearchFailed(`The search page answered ${response.status}.`);
    return parseDuckDuckGo(bodyText(response)).slice(0, limit);
  }
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchors = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!);
  anchors.forEach((m, i) => {
    let url = decodeEntities(m[1]!);
    // Results link through a redirect: the destination is its `uddg` parameter.
    const redirect = /[?&]uddg=([^&]+)/.exec(url);
    if (redirect) url = decodeURIComponent(redirect[1]!);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) return;
    results.push({ title: strip(m[2]!), url, snippet: strip(snippets[i] ?? '') });
  });
  return results;
}

function strip(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}
