import { asRecord, asString, chunks, commandOf, header, same } from './common.js';
import type { ButtonPress, ChannelAdapter, ChannelRequest, InboundEvent, OutboundMessage, OutgoingCall } from './types.js';

/**
 * Telegram (ported from Agent 5.5 `gateway/adapters/telegram.py`, polling
 * replaced by a webhook). `setWebhook` is given a secret token; Telegram sends
 * it back in `X-Telegram-Bot-Api-Secret-Token` on every update.
 */
export interface TelegramConfig {
  botToken: string;
  webhookSecret: string;
}

const LIMIT = 4096;

export class TelegramAdapter implements ChannelAdapter {
  readonly provider = 'telegram' as const;

  constructor(private readonly config: TelegramConfig) {}

  verify(request: ChannelRequest): boolean {
    const given = header(request.headers, 'x-telegram-bot-api-secret-token');
    return Boolean(this.config.webhookSecret) && given !== undefined && same(given, this.config.webhookSecret);
  }

  parse(body: unknown): InboundEvent[] {
    const update = asRecord(body);
    const updateId = asString(update['update_id']);
    if (!updateId) return [];
    const message = asRecord(update['message'] ?? update['edited_message']);
    if (Object.keys(message).length > 0 && update['message']) {
      const text = asString(message['text'] ?? message['caption']);
      const from = asRecord(message['from']);
      const chat = asRecord(message['chat']);
      if (!text || !asString(from['id']) || from['is_bot'] === true) return [];
      return [
        {
          kind: 'message',
          provider: 'telegram',
          eventId: updateId,
          senderId: asString(from['id']),
          chatId: asString(chat['id']),
          displayName: [asString(from['first_name']), asString(from['last_name'])].filter(Boolean).join(' ') || asString(from['username']),
          text,
          isGroup: asString(chat['type']) !== 'private',
          command: commandOf(text),
        },
      ];
    }
    const callback = asRecord(update['callback_query']);
    if (Object.keys(callback).length > 0) {
      const from = asRecord(callback['from']);
      const chat = asRecord(asRecord(callback['message'])['chat']);
      const data = asString(callback['data']);
      if (!data || !asString(from['id'])) return [];
      return [
        {
          kind: 'button',
          provider: 'telegram',
          eventId: updateId,
          senderId: asString(from['id']),
          chatId: asString(chat['id']) || asString(from['id']),
          displayName: asString(from['first_name']),
          data,
          ackId: asString(callback['id']) || null,
        },
      ];
    }
    return [];
  }

  immediate(): null {
    return null;
  }

  send(message: OutboundMessage): OutgoingCall[] {
    const pieces = chunks(message.text, LIMIT);
    return pieces.map((text, i) => {
      const last = i === pieces.length - 1;
      const keyboard =
        last && message.buttons?.length
          ? { inline_keyboard: [message.buttons.map((b) => (b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: b.data }))] }
          : undefined;
      return this.call('sendMessage', { chat_id: message.chatId, text, disable_web_page_preview: true, ...(keyboard ? { reply_markup: keyboard } : {}) });
    });
  }

  ack(press: ButtonPress, note?: string): OutgoingCall | null {
    if (!press.ackId) return null;
    return this.call('answerCallbackQuery', { callback_query_id: press.ackId, ...(note ? { text: note.slice(0, 200) } : {}) });
  }

  private call(method: string, payload: Record<string, unknown>): OutgoingCall {
    return {
      kind: 'http',
      method: 'POST',
      url: `https://api.telegram.org/bot${this.config.botToken}/${method}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }
}
