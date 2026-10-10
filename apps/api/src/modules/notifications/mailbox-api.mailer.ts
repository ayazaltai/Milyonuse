import type { Mailer, MailMessage } from './mail.port.js';

export interface MailboxApiConfig {
  /** e.g. https://api.mail.hostinger.com */
  baseUrl: string;
  token: string;
  /** "Name <address>" or a bare address; the address picks the mailbox. */
  from: string;
  /** Per request, so a stalled provider fails a send instead of holding it. */
  timeoutMs?: number;
}

/**
 * Mail sent through a hosted mailbox's HTTP API (Hostinger's Mailbox API).
 *
 * The sender is a real mailbox, found by the address in MAIL_FROM among the
 * mailboxes the token may manage (`GET /api/v1/me`) — looked up on the first
 * send and kept, so there is no second identifier to configure and get
 * wrong. The provider saves a copy of every message in that mailbox's Sent
 * folder.
 *
 * A failure throws with the provider's status and error code, never its body
 * or the recipient: callers log what they catch, and a mail error is no
 * place for an address.
 */
export class MailboxApiMailer implements Mailer {
  readonly name = 'mailbox-api';
  private mailboxId: Promise<string> | null = null;
  private readonly sender: { name: string | null; address: string };

  constructor(private readonly config: MailboxApiConfig) {
    this.sender = parseFrom(config.from);
  }

  async send(message: MailMessage): Promise<void> {
    const mailbox = await this.mailbox();
    await this.call('POST', `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/send`, {
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(this.sender.name ? { displayName: this.sender.name } : {}),
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              content: Buffer.from(a.content, 'utf8').toString('base64'),
              encoding: 'base64',
            })),
          }
        : {}),
    });
  }

  /** The mailbox MAIL_FROM names. A failed lookup is not kept: the next send asks again. */
  private mailbox(): Promise<string> {
    this.mailboxId ??= (async () => {
      const body = (await this.call('GET', '/api/v1/me')) as {
        data?: { mailboxes?: { resourceId: string; address: string }[] };
      };
      const match = body.data?.mailboxes?.find(
        (m) => m.address.toLowerCase() === this.sender.address.toLowerCase(),
      );
      if (!match) {
        throw new Error(
          `MAIL_FROM names ${this.sender.address}, which is not a mailbox this API token can send from.`,
        );
      }
      return match.resourceId;
    })().catch((error: unknown) => {
      this.mailboxId = null;
      throw error;
    });
    return this.mailboxId;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.config.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        accept: 'application/json',
        // Named, because the provider's edge turns some client signatures away
        // outright (Cloudflare 1010) — a bare library default is a guess.
        'user-agent': 'Milyonus/1.0 (+https://platform.milyonus.com)',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
    });

    if (!response.ok) {
      // The error envelope's code is the provider's contract; its message and
      // params may echo the payload.
      const code = await response
        .json()
        .then((e: unknown) => (e as { code?: unknown }).code)
        .catch(() => undefined);
      throw new Error(`Mailbox API answered ${response.status}${typeof code === 'string' ? ` ${code}` : ''}.`);
    }

    return response.status === 204 ? null : response.json();
  }
}

/** "Milyonus <no-reply@milyonus.com>" → name and address; a bare address has no name. */
export function parseFrom(from: string): { name: string | null; address: string } {
  const match = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  if (match) return { name: match[1]!.replace(/^"|"$/g, '') || null, address: match[2]! };
  return { name: null, address: from.trim() };
}
