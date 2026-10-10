import { type LookupAddress, lookup as dnsLookup } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Requests to addresses a tenant typed in — a webhook receiver — must not reach
 * inside our own network. The address is checked as the connection is made,
 * not only when it is saved: a DNS answer that changes between the two
 * (rebinding) cannot slip through, and redirects are never followed.
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

export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, 'ipv4');
  if (family === 6) return !nonPublic.check(address, 'ipv6');
  return false;
}

export class OutboundRefused extends Error {
  override name = 'OutboundRefused';
}

/** Why this URL cannot be sent to, or null. */
export function destinationProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'only https is allowed';
  if (url.username || url.password) return 'credentials in the URL are not allowed';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPublicAddress(host) ? null : `${host} is not a public address`;
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost is not reachable from outside';
  if (!host.includes('.')) return `${host} is not a public host name`;
  return null;
}

export interface OutboundRequest {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export type Sender = (url: string, init: OutboundRequest) => Promise<{ status: number }>;

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function publicLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const refused = addresses.find((a) => !isPublicAddress(a.address));
    if (refused) return callback(new OutboundRefused(`${hostname} resolves to ${refused.address}, not a public address`), '');
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}

/** POSTs to a public HTTPS address. The body of the answer is not read; its status is. */
export const postToPublicHttps: Sender = (url, init) =>
  new Promise((resolve, reject) => {
    const problem = destinationProblem(url);
    if (problem) {
      reject(new OutboundRefused(problem));
      return;
    }
    const req = request(
      url,
      {
        method: 'POST',
        headers: { ...init.headers, 'content-length': String(Buffer.byteLength(init.body)) },
        lookup: publicLookup as never,
        timeout: init.timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer within ${init.timeoutMs} ms`)));
    req.on('error', reject);
    req.end(init.body);
  });
