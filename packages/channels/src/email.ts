import { createHash } from 'node:crypto';
import { asRecord, asString, commandOf, header, same } from './common.js';
import type { ChannelAdapter, ChannelRequest, InboundEvent, OutboundMessage, OutgoingCall } from './types.js';

/**
 * Mail to the agent's own address. The inbound provider forwards each mail as
 * JSON with its own bearer, and says whether the sender's domain signed it
 * (DKIM). An unsigned mail is not read: anyone can write any From line, and a
 * From line is all a mail identity is. Replies go out through the mail port;
 * a button becomes a link, as mail has no buttons.
 */
export interface EmailConfig {
  inboundSecret: string;
  /** The agent's address, e.g. `agent@in.milyonuse.com`. */
  address: string;
}

const LIMIT = 20_000;

export class EmailAdapter implements ChannelAdapter {
  readonly provider = 'email' as const;

  constructor(private readonly config: EmailConfig) {}

  verify(request: ChannelRequest): boolean {
    const given = header(request.headers, 'authorization');
    return Boolean(this.config.inboundSecret) && given !== undefined && same(given, `Bearer ${this.config.inboundSecret}`);
  }

  immediate(): null {
    return null;
  }

  parse(body: unknown): InboundEvent[] {
    const mail = asRecord(body);
    if (asString(mail['dkim']).toLowerCase() !== 'pass') return [];
    const from = addressOf(asString(mail['from']));
    if (!from) return [];
    const subject = asString(mail['subject']).trim();
    const text = replyOnly(asString(mail['text'])).slice(0, LIMIT);
    const said = text || subject;
    if (!said) return [];
    const id = asString(mail['messageId']).trim();
    return [
      {
        kind: 'message',
        provider: 'email',
        eventId: id ? id.slice(0, 200) : createHash('sha256').update(`${from}\n${subject}\n${text}`).digest('hex'),
        senderId: from,
        chatId: from,
        displayName: nameOf(asString(mail['from'])),
        text: said,
        isGroup: false,
        command: commandOf(subject) ?? commandOf(said.split('\n')[0] ?? ''),
      },
    ];
  }

  send(message: OutboundMessage): OutgoingCall[] {
    const links = (message.buttons ?? []).filter((b) => b.url).map((b) => `${b.label}: ${b.url}`);
    const first = message.text.split('\n').find((l) => l.trim()) ?? 'Milyonuse';
    return [
      {
        kind: 'mail',
        to: message.chatId,
        subject: `Milyonuse — ${first.replace(/[*_`#>]/g, '').slice(0, 80)}`,
        text: links.length ? `${message.text}\n\n${links.join('\n')}` : message.text,
      },
    ];
  }

  ack(): null {
    return null;
  }
}

/** `Ada <ada@example.com>` → `ada@example.com`. */
export function addressOf(from: string): string | null {
  const m = /<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/.exec(from) ?? /([^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+)/.exec(from);
  return m ? m[1]!.toLowerCase() : null;
}

function nameOf(from: string): string {
  return from.replace(/<[^>]*>/, '').replace(/"/g, '').trim().slice(0, 120);
}

/** What the person wrote, without the quoted mail it answers. */
function replyOnly(text: string): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^On .+ wrote:$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) || /^.+ şunu yazdı:$/.test(line.trim())) break;
    if (line.startsWith('>')) continue;
    lines.push(line);
  }
  return lines.join('\n').trim();
}
