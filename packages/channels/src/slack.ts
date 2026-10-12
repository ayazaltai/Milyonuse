import { asArray, asRecord, asString, chunks, commandOf, header, hmacHex, same } from './common.js';
import type { ChannelAdapter, ChannelRequest, ImmediateAnswer, InboundEvent, OutboundMessage, OutgoingCall } from './types.js';

/**
 * Slack (ported from Agent 5.5 `gateway/adapters/slack.py`). Every request is
 * signed `v0=HMAC-SHA256("v0:<timestamp>:<body>")` with the app's signing
 * secret, and a timestamp more than five minutes away is a replay. Events
 * arrive as JSON; button presses as a form field `payload` holding JSON —
 * the API hands either here as the parsed body.
 */
export interface SlackConfig {
  botToken: string;
  signingSecret: string;
}

const SKEW_SECONDS = 300;
const LIMIT = 3000;

export class SlackAdapter implements ChannelAdapter {
  readonly provider = 'slack' as const;

  constructor(private readonly config: SlackConfig) {}

  verify(request: ChannelRequest): boolean {
    const ts = Number(header(request.headers, 'x-slack-request-timestamp'));
    const given = header(request.headers, 'x-slack-signature');
    if (!this.config.signingSecret || !given || !Number.isInteger(ts)) return false;
    if (Math.abs((request.now ?? Date.now()) / 1000 - ts) > SKEW_SECONDS) return false;
    return same(given, `v0=${hmacHex(this.config.signingSecret, `v0:${ts}:${request.rawBody}`)}`);
  }

  immediate(body: unknown): ImmediateAnswer | null {
    const b = this.payload(body);
    if (b['type'] === 'url_verification') return { status: 200, contentType: 'application/json', body: JSON.stringify({ challenge: asString(b['challenge']) }) };
    return null;
  }

  parse(body: unknown): InboundEvent[] {
    const b = this.payload(body);
    if (b['type'] === 'event_callback') {
      const event = asRecord(b['event']);
      const team = asString(b['team_id']);
      const user = asString(event['user']);
      const type = asString(event['type']);
      // The bot's own posts, edits and joins are not messages to answer.
      if ((type !== 'message' && type !== 'app_mention') || event['subtype'] || event['bot_id'] || !user) return [];
      const text = asString(event['text']).replace(/^<@[A-Z0-9]+>\s*/, '');
      if (!text) return [];
      return [
        {
          kind: 'message',
          provider: 'slack',
          eventId: asString(b['event_id']) || `${asString(event['channel'])}:${asString(event['ts'])}`,
          senderId: `${team}:${user}`,
          chatId: asString(event['channel']),
          displayName: '',
          text,
          isGroup: asString(event['channel_type']) !== 'im',
          command: commandOf(text),
        },
      ];
    }
    if (b['type'] === 'block_actions') {
      const action = asRecord(asArray(b['actions'])[0]);
      const user = asRecord(b['user']);
      const team = asString(asRecord(b['team'])['id']) || asString(user['team_id']);
      const data = asString(action['value']);
      if (!data || !asString(user['id'])) return [];
      return [
        {
          kind: 'button',
          provider: 'slack',
          eventId: `${asString(asRecord(b['container'])['message_ts'])}:${asString(action['action_ts'])}`,
          senderId: `${team}:${asString(user['id'])}`,
          chatId: asString(asRecord(b['channel'])['id']),
          displayName: asString(user['name']),
          data,
          ackId: null,
        },
      ];
    }
    return [];
  }

  send(message: OutboundMessage): OutgoingCall[] {
    const pieces = chunks(message.text, LIMIT);
    return pieces.map((text, i) => {
      const buttons = i === pieces.length - 1 ? (message.buttons ?? []) : [];
      const blocks = buttons.length
        ? [
            { type: 'section', text: { type: 'mrkdwn', text } },
            {
              type: 'actions',
              elements: buttons.slice(0, 5).map((b, n) =>
                b.url
                  ? { type: 'button', text: { type: 'plain_text', text: b.label.slice(0, 75) }, url: b.url, action_id: `open_${n}` }
                  : { type: 'button', text: { type: 'plain_text', text: b.label.slice(0, 75) }, value: b.data, action_id: `act_${n}` },
              ),
            },
          ]
        : undefined;
      return {
        kind: 'http' as const,
        method: 'POST' as const,
        url: 'https://slack.com/api/chat.postMessage',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${this.config.botToken}` },
        body: JSON.stringify({ channel: message.chatId, text, ...(blocks ? { blocks } : {}) }),
      };
    });
  }

  ack(): null {
    // Slack takes the webhook's own 200 as the acknowledgement.
    return null;
  }

  /** An interaction arrives as `payload=<json>`; an event as JSON itself. */
  private payload(body: unknown): Record<string, unknown> {
    const b = asRecord(body);
    if (typeof b['payload'] === 'string') {
      try {
        return asRecord(JSON.parse(b['payload']));
      } catch {
        return {};
      }
    }
    return b;
  }
}
