import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { asArray, asRecord, asString, chunks, header } from './common.js';
import type { ChannelAdapter, ChannelRequest, ImmediateAnswer, InboundEvent, OutboundMessage, OutgoingCall } from './types.js';

/**
 * Discord interactions (ported from Agent 5.5 `gateway/adapters/discord.py`,
 * its gateway socket replaced by the interactions endpoint). Each request is
 * signed with Ed25519 over `<timestamp><body>`. An interaction must be
 * answered within three seconds, so the webhook answers "working on it" at
 * once and the reply is posted to the channel by the bot afterwards.
 *
 * The bot's commands: `/ask text:` for the agent, `/pair code:` to bind, and
 * any of the person's automation commands as `/run name:`.
 */
export interface DiscordConfig {
  applicationId: string;
  publicKey: string;
  botToken: string;
}

const LIMIT = 2000;
const PING = 1;
const COMMAND = 2;
const COMPONENT = 3;
/** The DER prefix of an Ed25519 public key, before its 32 raw bytes. */
const ED25519_SPKI = '302a300506032b6570032100';

export class DiscordAdapter implements ChannelAdapter {
  readonly provider = 'discord' as const;

  constructor(private readonly config: DiscordConfig) {}

  verify(request: ChannelRequest): boolean {
    const signature = header(request.headers, 'x-signature-ed25519');
    const timestamp = header(request.headers, 'x-signature-timestamp');
    if (!this.config.publicKey || !signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature) || !/^[0-9a-f]{64}$/i.test(this.config.publicKey)) return false;
    try {
      const key = createPublicKey({ key: Buffer.from(ED25519_SPKI + this.config.publicKey, 'hex'), format: 'der', type: 'spki' });
      return verifySignature(null, Buffer.from(timestamp + request.rawBody), key, Buffer.from(signature, 'hex'));
    } catch {
      return false;
    }
  }

  immediate(body: unknown): ImmediateAnswer | null {
    const type = asRecord(body)['type'];
    const json = (value: unknown): ImmediateAnswer => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (type === PING) return json({ type: 1 });
    // A command: "thinking…", answered later. A button: acknowledged without changing the message.
    if (type === COMMAND) return json({ type: 5 });
    if (type === COMPONENT) return json({ type: 6 });
    return null;
  }

  parse(body: unknown): InboundEvent[] {
    const b = asRecord(body);
    const user = asRecord(asRecord(b['member'])['user'] ?? b['user']);
    const senderId = asString(user['id']);
    const id = asString(b['id']);
    if (!senderId || !id) return [];
    const base = {
      provider: 'discord' as const,
      eventId: id,
      senderId,
      chatId: asString(b['channel_id']),
      displayName: asString(user['global_name']) || asString(user['username']),
    };
    const data = asRecord(b['data']);
    if (b['type'] === COMMAND) {
      const option = (name: string) => asString(asRecord(asArray(data['options']).find((o) => asRecord(o)['name'] === name))['value']);
      const name = asString(data['name']).toLowerCase();
      const isGroup = Boolean(b['guild_id']);
      if (name === 'ask') {
        const text = option('text');
        return text ? [{ kind: 'message', ...base, text, isGroup, command: null }] : [];
      }
      if (name === 'pair') return [{ kind: 'message', ...base, text: option('code'), isGroup, command: null }];
      if (name === 'run' || name === 'new') {
        const command = name === 'new' ? 'new' : option('name').toLowerCase();
        return command ? [{ kind: 'message', ...base, text: `/${command}`, isGroup, command: { name: command, args: option('input') } }] : [];
      }
      return [];
    }
    if (b['type'] === COMPONENT) {
      const custom = asString(data['custom_id']);
      return custom ? [{ kind: 'button', ...base, data: custom, ackId: null }] : [];
    }
    return [];
  }

  send(message: OutboundMessage): OutgoingCall[] {
    const pieces = chunks(message.text, LIMIT);
    return pieces.map((content, i) => {
      const buttons = i === pieces.length - 1 ? (message.buttons ?? []).slice(0, 5) : [];
      const components = buttons.length
        ? [
            {
              type: 1,
              components: buttons.map((b) =>
                b.url ? { type: 2, style: 5, label: b.label.slice(0, 80), url: b.url } : { type: 2, style: 1, label: b.label.slice(0, 80), custom_id: b.data!.slice(0, 100) },
              ),
            },
          ]
        : undefined;
      return {
        kind: 'http' as const,
        method: 'POST' as const,
        url: `https://discord.com/api/v10/channels/${message.chatId}/messages`,
        headers: { 'content-type': 'application/json', authorization: `Bot ${this.config.botToken}` },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) }),
      };
    });
  }

  ack(): null {
    // The webhook's own answer (type 6) is the acknowledgement.
    return null;
  }
}
