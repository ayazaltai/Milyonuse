import { describe, expect, it } from 'vitest';
import { EmailAdapter, addressOf } from './email.js';

const mail = new EmailAdapter({ inboundSecret: 's'.repeat(40), address: 'agent@in.milyonuse.com' });
const inbound = (extra: Record<string, unknown> = {}) => ({
  from: 'Ada Lovelace <Ada@Example.com>',
  to: 'agent@in.milyonuse.com',
  subject: 'Weekly plan',
  text: 'Plan my week.\n\nOn Mon, Grace wrote:\n> old text',
  messageId: '<m1@example.com>',
  dkim: 'pass',
  ...extra,
});

describe('Email', () => {
  it('trusts only the provider’s bearer', () => {
    expect(mail.verify({ headers: { Authorization: `Bearer ${'s'.repeat(40)}` }, rawBody: '' })).toBe(true);
    expect(mail.verify({ headers: { authorization: 'Bearer x' }, rawBody: '' })).toBe(false);
  });

  it('reads a signed mail: its sender, and what they wrote above the quote', () => {
    expect(mail.parse(inbound())).toEqual([
      {
        kind: 'message',
        provider: 'email',
        eventId: '<m1@example.com>',
        senderId: 'ada@example.com',
        chatId: 'ada@example.com',
        displayName: 'Ada Lovelace',
        text: 'Plan my week.',
        isGroup: false,
        command: null,
      },
    ]);
  });

  it('does not read a mail its domain did not sign', () => {
    expect(mail.parse(inbound({ dkim: 'fail' }))).toEqual([]);
    expect(mail.parse(inbound({ dkim: undefined }))).toEqual([]);
  });

  it('reads a command from the subject', () => {
    expect(mail.parse(inbound({ subject: '/report', text: '' }))[0]).toMatchObject({ command: { name: 'report', args: '' }, text: '/report' });
  });

  it('replies by mail, with buttons as links', () => {
    expect(mail.send({ chatId: 'ada@example.com', text: '**Done.** Here it is.', buttons: [{ label: 'Confirm', data: 'a:c:1' }, { label: 'Open', url: 'https://milyonuse.com/app/inbox' }] })).toEqual([
      { kind: 'mail', to: 'ada@example.com', subject: 'Milyonuse — Done. Here it is.', text: '**Done.** Here it is.\n\nOpen: https://milyonuse.com/app/inbox' },
    ]);
  });

  it('finds the address in a From line', () => {
    expect(addressOf('"Ada" <ada@example.com>')).toBe('ada@example.com');
    expect(addressOf('ada@example.com')).toBe('ada@example.com');
    expect(addressOf('nobody')).toBeNull();
  });
});
