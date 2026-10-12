import { asArray, asRecord, asString, chunks, commandOf, header, hmacHex, same } from './common.js';
import type { ChannelAdapter, ChannelRequest, ImmediateAnswer, InboundEvent, OutboundMessage, OutgoingCall } from './types.js';

/**
 * WhatsApp Cloud API (ported from Agent 5.5 `gateway/adapters/whatsapp.py`).
 * Meta signs each POST with the app secret (`X-Hub-Signature-256`); unlike
 * the original, a missing secret refuses everything rather than trusting it.
 * Reply buttons are interactive messages: at most three, labels of twenty
 * characters; a link cannot be a reply button, so it goes in the text.
 */
export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
}

const GRAPH = 'https://graph.facebook.com/v21.0';
const TEXT_LIMIT = 4000;
const INTERACTIVE_BODY = 1024;

export class WhatsAppAdapter implements ChannelAdapter {
  readonly provider = 'whatsapp' as const;

  constructor(private readonly config: WhatsAppConfig) {}

  verify(request: ChannelRequest): boolean {
    const given = header(request.headers, 'x-hub-signature-256');
    if (!this.config.appSecret || !given) return false;
    return same(given, `sha256=${hmacHex(this.config.appSecret, request.rawBody)}`);
  }

  /** Meta's subscription handshake (GET): the challenge echoed for the right token. */
  handshake(query: Record<string, string | undefined>): ImmediateAnswer {
    const ok = query['hub.mode'] === 'subscribe' && Boolean(this.config.verifyToken) && same(query['hub.verify_token'] ?? '', this.config.verifyToken);
    return ok
      ? { status: 200, contentType: 'text/plain', body: query['hub.challenge'] ?? '' }
      : { status: 403, contentType: 'text/plain', body: 'forbidden' };
  }

  parse(body: unknown): InboundEvent[] {
    const out: InboundEvent[] = [];
    for (const entry of asArray(asRecord(body)['entry'])) {
      for (const change of asArray(asRecord(entry)['changes'])) {
        const value = asRecord(asRecord(change)['value']);
        const names = new Map(
          asArray(value['contacts']).map((c) => [asString(asRecord(c)['wa_id']), asString(asRecord(asRecord(c)['profile'])['name'])] as const),
        );
        for (const raw of asArray(value['messages'])) {
          const msg = asRecord(raw);
          const from = asString(msg['from']);
          const id = asString(msg['id']);
          if (!from || !id) continue;
          const base = { provider: 'whatsapp' as const, eventId: id, senderId: from, chatId: from, displayName: names.get(from) ?? '' };
          if (msg['type'] === 'text') {
            const text = asString(asRecord(msg['text'])['body']);
            if (text) out.push({ kind: 'message', ...base, text, isGroup: false, command: commandOf(text) });
          } else if (msg['type'] === 'interactive') {
            const reply = asRecord(asRecord(msg['interactive'])['button_reply']);
            const data = asString(reply['id']);
            if (data) out.push({ kind: 'button', ...base, data, ackId: null });
          } else if (msg['type'] === 'button') {
            // A template's quick reply carries its payload here.
            const data = asString(asRecord(msg['button'])['payload']);
            if (data) out.push({ kind: 'button', ...base, data, ackId: null });
          }
        }
      }
    }
    return out;
  }

  immediate(): null {
    return null;
  }

  send(message: OutboundMessage): OutgoingCall[] {
    const replies = (message.buttons ?? []).filter((b) => b.data).slice(0, 3);
    const links = (message.buttons ?? []).filter((b) => b.url);
    const text = links.length ? `${message.text}\n\n${links.map((b) => `${b.label}: ${b.url}`).join('\n')}` : message.text;
    if (replies.length === 0) return chunks(text, TEXT_LIMIT).map((piece) => this.text(message.chatId, piece));
    // The buttons ride on the last part; a long text goes before them as plain messages.
    const pieces = chunks(text, TEXT_LIMIT);
    const tail = pieces.pop()!;
    const calls = pieces.map((piece) => this.text(message.chatId, piece));
    const body = tail.length > INTERACTIVE_BODY ? tail.slice(0, INTERACTIVE_BODY - 1) + '…' : tail;
    calls.push(
      this.call({
        messaging_product: 'whatsapp',
        to: message.chatId,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: { buttons: replies.map((b) => ({ type: 'reply', reply: { id: b.data!.slice(0, 256), title: b.label.slice(0, 20) } })) },
        },
      }),
    );
    return calls;
  }

  ack(): null {
    return null;
  }

  private text(to: string, body: string): OutgoingCall {
    return this.call({ messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } });
  }

  private call(payload: Record<string, unknown>): OutgoingCall {
    return {
      kind: 'http',
      method: 'POST',
      url: `${GRAPH}/${this.config.phoneNumberId}/messages`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.accessToken}` },
      body: JSON.stringify(payload),
    };
  }
}
