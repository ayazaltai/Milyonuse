import { type LookupAddress, lookup as dnsLookup } from 'node:dns';
import { request } from 'node:https';
import { destinationProblem as checkDestination, isPublicAddress } from '@milyonuse/security';

/**
 * Requests to addresses a tenant typed in — a webhook receiver — must not reach
 * inside our own network. The address is checked as the connection is made,
 * not only when it is saved: a DNS answer that changes between the two
 * (rebinding) cannot slip through, and redirects are never followed. The
 * address rules are @milyonuse/security's, shared with the agent's web tools.
 */

export { isPublicAddress };

export class OutboundRefused extends Error {
  override name = 'OutboundRefused';
}

/** Why this URL cannot be sent to, or null: public HTTPS only. */
export function destinationProblem(raw: string): string | null {
  return checkDestination(raw);
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
