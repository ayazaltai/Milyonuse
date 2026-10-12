import { describe, expect, it } from 'vitest';
import { TelegramAdapter } from './telegram.js';
import type { ButtonPress } from './types.js';

const tg = new TelegramAdapter({ botToken: '123:abc', webhookSecret: 'tg-secret' });
const update = (extra: Record<string, unknown>) => ({ update_id: 991, ...extra });
const message = (text: string, chat: Record<string, unknown> = { id: 42, type: 'private' }) =>
  update({ message: { message_id: 5, from: { id: 42, first_name: 'Ada', last_name: 'Lovelace' }, chat, text } });

describe('Telegram', () => {
  it('trusts only the secret token it was given', () => {
    expect(tg.verify({ headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' }, rawBody: '{}' })).toBe(true);
    expect(tg.verify({ headers: { 'x-telegram-bot-api-secret-token': 'nope' }, rawBody: '{}' })).toBe(false);
    expect(tg.verify({ headers: {}, rawBody: '{}' })).toBe(false);
    expect(new TelegramAdapter({ botToken: 'x', webhookSecret: '' }).verify({ headers: { 'x-telegram-bot-api-secret-token': '' }, rawBody: '' })).toBe(false);
  });

  it('reads a private message with its sender, chat and command', () => {
    expect(tg.parse(message('/report this week'))).toEqual([
      {
        kind: 'message',
        provider: 'telegram',
        eventId: '991',
        senderId: '42',
        chatId: '42',
        displayName: 'Ada Lovelace',
        text: '/report this week',
        isGroup: false,
        command: { name: 'report', args: 'this week' },
      },
    ]);
  });

  it('marks a group message as a group’s', () => {
    expect(tg.parse(message('hello', { id: -100, type: 'supergroup' }))[0]).toMatchObject({ isGroup: true, chatId: '-100' });
  });

  it('reads a button press with what it carried', () => {
    const [press] = tg.parse(update({ callback_query: { id: 'cb1', from: { id: 42, first_name: 'Ada' }, message: { chat: { id: 42 } }, data: 'a:c:X' } }));
    expect(press).toMatchObject({ kind: 'button', data: 'a:c:X', ackId: 'cb1', senderId: '42' });
  });

  it('ignores bots, edits, stickers and anything without an update id', () => {
    expect(tg.parse(update({ message: { from: { id: 1, is_bot: true }, chat: { id: 1, type: 'private' }, text: 'hi' } }))).toEqual([]);
    expect(tg.parse(update({ edited_message: { from: { id: 1 }, chat: { id: 1 }, text: 'hi' } }))).toEqual([]);
    expect(tg.parse(update({ message: { from: { id: 1 }, chat: { id: 1 }, sticker: {} } }))).toEqual([]);
    expect(tg.parse({ message: { text: 'x' } })).toEqual([]);
  });

  it('sends text, with buttons on the last piece of a long one', () => {
    const calls = tg.send({ chatId: '42', text: 'x'.repeat(5000), buttons: [{ label: 'Confirm', data: 'a:c:1' }, { label: 'Open', url: 'https://milyonuse.com/app/inbox' }] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ kind: 'http', url: 'https://api.telegram.org/bot123:abc/sendMessage' });
    const first = JSON.parse((calls[0] as { body: string }).body);
    const last = JSON.parse((calls[1] as { body: string }).body);
    expect(first.reply_markup).toBeUndefined();
    expect(last.reply_markup.inline_keyboard[0]).toEqual([
      { text: 'Confirm', callback_data: 'a:c:1' },
      { text: 'Open', url: 'https://milyonuse.com/app/inbox' },
    ]);
  });

  it('acknowledges a button press', () => {
    const press: ButtonPress = { kind: 'button', provider: 'telegram', eventId: '1', senderId: '42', chatId: '42', displayName: '', data: 'x', ackId: 'cb1' };
    const call = tg.ack(press, 'Done');
    expect(call).toMatchObject({ url: 'https://api.telegram.org/bot123:abc/answerCallbackQuery' });
    expect(JSON.parse((call as { body: string }).body)).toEqual({ callback_query_id: 'cb1', text: 'Done' });
  });
});
