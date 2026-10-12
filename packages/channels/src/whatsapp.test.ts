import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WhatsAppAdapter } from './whatsapp.js';

const wa = new WhatsAppAdapter({ accessToken: 'wa-token', phoneNumberId: '1001', appSecret: 'app-secret', verifyToken: 'hello-meta' });
const sign = (body: string, secret = 'app-secret') => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const payload = (messages: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { contacts: [{ wa_id: '905551112233', profile: { name: 'Ayşe' } }], messages } }] }],
});

describe('WhatsApp', () => {
  it('trusts only Meta’s signature with the app secret', () => {
    const body = JSON.stringify(payload([]));
    expect(wa.verify({ headers: { 'X-Hub-Signature-256': sign(body) }, rawBody: body })).toBe(true);
    expect(wa.verify({ headers: { 'x-hub-signature-256': sign(body, 'other') }, rawBody: body })).toBe(false);
    expect(wa.verify({ headers: { 'x-hub-signature-256': sign(body) }, rawBody: body + ' ' })).toBe(false);
    expect(wa.verify({ headers: {}, rawBody: body })).toBe(false);
  });

  it('refuses everything when no app secret is set', () => {
    const open = new WhatsAppAdapter({ accessToken: 'x', phoneNumberId: '1', appSecret: '', verifyToken: 'v' });
    expect(open.verify({ headers: { 'x-hub-signature-256': sign('{}', '') }, rawBody: '{}' })).toBe(false);
  });

  it('answers Meta’s handshake only for the right token', () => {
    expect(wa.handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'hello-meta', 'hub.challenge': '1158' })).toEqual({ status: 200, contentType: 'text/plain', body: '1158' });
    expect(wa.handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1158' }).status).toBe(403);
  });

  it('reads text messages with the sender’s name, and button replies', () => {
    const events = wa.parse(
      payload([
        { from: '905551112233', id: 'wamid.1', type: 'text', text: { body: '/new' } },
        { from: '905551112233', id: 'wamid.2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'a:c:X', title: 'Confirm' } } },
        { from: '905551112233', id: 'wamid.3', type: 'image', image: {} },
      ]),
    );
    expect(events).toEqual([
      { kind: 'message', provider: 'whatsapp', eventId: 'wamid.1', senderId: '905551112233', chatId: '905551112233', displayName: 'Ayşe', text: '/new', isGroup: false, command: { name: 'new', args: '' } },
      { kind: 'button', provider: 'whatsapp', eventId: 'wamid.2', senderId: '905551112233', chatId: '905551112233', displayName: 'Ayşe', data: 'a:c:X', ackId: null },
    ]);
  });

  it('sends reply buttons as an interactive message — three at most, links in the text', () => {
    const calls = wa.send({
      chatId: '905551112233',
      text: 'Send the weekly report to Grace?',
      buttons: [
        { label: 'Confirm', data: 'a:c:1' },
        { label: 'Discard', data: 'a:d:1' },
        { label: 'Open in Milyonuse', url: 'https://milyonuse.com/app/inbox' },
      ],
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse((calls[0] as { body: string }).body);
    expect(body.type).toBe('interactive');
    expect(body.interactive.action.buttons.map((b: { reply: { id: string } }) => b.reply.id)).toEqual(['a:c:1', 'a:d:1']);
    expect(body.interactive.body.text).toContain('Open in Milyonuse: https://milyonuse.com/app/inbox');
    expect((calls[0] as { headers: Record<string, string> }).headers.authorization).toBe('Bearer wa-token');
  });

  it('sends a long text in pieces before its buttons', () => {
    const calls = wa.send({ chatId: '1', text: 'y'.repeat(9000), buttons: [{ label: 'OK', data: 'a:c:1' }] });
    expect(calls.map((c) => JSON.parse((c as { body: string }).body).type)).toEqual(['text', 'text', 'interactive']);
  });
});
