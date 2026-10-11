import { type LookupAddress, lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * SSRF protection (ported from Agent 5.5 `security/ssrf.py`, Apache-2.0, with
 * App-Milyonus `common/outbound.ts`'s connection-time check).
 *
 * Always on, fail-closed, not configurable. A URL the agent, a page or a
 * person names must not reach inside our network: private, loopback,
 * link-local (the cloud metadata address 169.254.169.254 among them), CGNAT,
 * documentation and multicast ranges, and the metadata host names.
 *
 * The check is made twice: on the URL as written, and on every address its
 * host resolves to *as the connection is made* — so a DNS answer that changes
 * between the two (rebinding) cannot slip through. A redirect is a new URL,
 * checked again from the start, at most a few times.
 */

const nonPublic = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  nonPublic.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  nonPublic.addSubnet(network, prefix, 'ipv6');
}

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data', 'instance-data.ec2.internal']);

export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, 'ipv4');
  if (family === 6) return !nonPublic.check(address, 'ipv6');
  return false;
}

export class SsrfBlocked extends Error {
  override name = 'SsrfBlocked';
}

/**
 * Why this URL may not be fetched, or null. `https` alone for anything we send
 * data to; reading a page also allows `http`.
 */
export function destinationProblem(raw: string, options: { allowHttp?: boolean } = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  const schemes = options.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!schemes.includes(url.protocol)) {
    return `the ${url.protocol.replace(':', '')} scheme is not allowed — only ${options.allowHttp ? 'http and https' : 'https'}`;
  }
  if (url.username || url.password) return 'credentials in the URL are not allowed';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) return 'no host';
  if (METADATA_HOSTS.has(host)) return `${host} is a cloud metadata host`;
  if (isIP(host)) return isPublicAddress(host) ? null : `${host} is not a public address`;
  // Decimal, octal or hex IPv4 a resolver would read as a number ("2130706433", "0x7f.1").
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) return `${host} is a numeric address`;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return `${host} is not reachable from outside`;
  }
  if (!host.includes('.')) return `${host} is not a public host name`;
  return null;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))));

/** A `lookup` for node:http that refuses a host any of whose addresses is not public. */
export function publicLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) return callback(new SsrfBlocked(`${hostname} has no address`), '');
        const refused = addresses.find((a) => !isPublicAddress(a.address));
        if (refused) return callback(new SsrfBlocked(`${hostname} resolves to ${refused.address}, not a public address`), '');
        if (options.all) return callback(null, addresses);
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      },
      // A host that does not resolve is refused, not retried elsewhere.
      (error: NodeJS.ErrnoException) => callback(error, ''),
    );
  };
}

export interface PublicResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** The body was longer than the limit and was cut there. */
  truncated: boolean;
}

export interface FetchPublicOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowHttp?: boolean;
  /** For tests: how host names resolve. */
  resolve?: Resolver;
}

/**
 * Fetches a public URL: checked as written, checked again at connection time,
 * redirects followed only to URLs that pass the same checks, the body read up
 * to a limit, the whole request bounded in time.
 */
export async function fetchPublic(raw: string, options: FetchPublicOptions = {}): Promise<PublicResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const problem = destinationProblem(url, { allowHttp: options.allowHttp ?? true });
    if (problem) throw new SsrfBlocked(problem);
    const response = await once(url, options);
    if (response.status >= 300 && response.status < 400 && response.headers['location']) {
      if (options.method === 'POST') throw new SsrfBlocked('a POST is never redirected');
      url = new URL(response.headers['location'], url).toString();
      continue;
    }
    return response;
  }
  throw new SsrfBlocked(`more than ${maxRedirects} redirects`);
}

function once(url: string, options: FetchPublicOptions): Promise<PublicResponse> {
  const maxBytes = options.maxBytes ?? 2_000_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const send = url.startsWith('https:') ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    const req = send(
      url,
      {
        method: options.method ?? 'GET',
        headers: {
          'user-agent': 'Milyonuse/1.0 (+https://milyonus.com)',
          'accept-encoding': 'gzip, deflate, br',
          ...options.headers,
          ...(options.body !== undefined ? { 'content-length': String(Buffer.byteLength(options.body)) } : {}),
        },
        lookup: publicLookup(options.resolve) as never,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
        const encoding = headers['content-encoding'];
        let stream: Readable = res;
        if (encoding === 'gzip') stream = res.pipe(createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(createInflate());
        else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            truncated = true;
            res.destroy();
            clearTimeout(timer);
            resolve({ url, status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => {
          clearTimeout(timer);
          resolve({ url, status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated });
        });
        stream.on('error', (error) => {
          clearTimeout(timer);
          if (!truncated) reject(error);
        });
      },
    );
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(options.body);
  });
}
