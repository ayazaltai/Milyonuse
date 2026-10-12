import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SlackAdapter } from './slack.js';

const slack = new SlackAdapter({ botToken: 'xoxb-1', signingSecret: 'slack-secret' });
const now = 1_800_000_000_000;
const ts = now / 1000;
const sign = (body: string, at = ts, secret = 'slack-secret') => `v0=${createHmac('sha256', secret).update(`v0:${at}:${body}`).digest('hex')}`;
const headers = (body: string, at = ts) => ({ 'X-Slack-Request-Timestamp': String(at), 'X-Slack-Signature': sign(body, at) });
const event = (e: Record<string, unknown>) => ({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { type: 'message', user: 'U1', channel: 'D1', channel_type: 'im', ts: '1.1', text: 'hi', ...e } });

describe('Slack', () => {
  it('trusts a fresh request signed with the signing secret', () => {
    const body = JSON.stringify(event({}));
    expect(slack.verify({ headers: headers(body), rawBody: body, now })).toBe(true);
    expect(slack.verify({ headers: headers(body), rawBody: body + 'x', now })).toBe(false);
  });

  it('refuses a replay older than five minutes', () => {
    const body = '{}';
    expect(slack.verify({ headers: headers(body, ts - 301), rawBody: body, now })).toBe(false);
    expect(slack.verify({ headers: { 'x-slack-signature': sign(body) }, rawBody: body, now })).toBe(false);
  });

  it('answers the URL check at once', () => {
    expect(slack.immediate({ type: 'url_verification', challenge: 'c1' })).toEqual({ status: 200, contentType: 'application/json', body: '{"challenge":"c1"}' });
    expect(slack.immediate(event({}))).toBeNull();
  });

  it('reads a direct message, and a mention in a channel without the mention', () => {
    expect(slack.parse(event({ text: '/report' }))).toEqual([
      { kind: 'message', provider: 'slack', eventId: 'Ev1', senderId: 'T1:U1', chatId: 'D1', displayName: '', text: '/report', isGroup: false, command: { name: 'report', args: '' } },
    ]);
    expect(slack.parse(event({ type: 'app_mention', channel: 'C9', channel_type: 'channel', text: '<@UBOT> summarise this' }))[0]).toMatchObject({
      text: 'summarise this',
      isGroup: true,
      chatId: 'C9',
    });
  });

  it('ignores its own posts and edits', () => {
    expect(slack.parse(event({ bot_id: 'B1' }))).toEqual([]);
    expect(slack.parse(event({ subtype: 'message_changed' }))).toEqual([]);
  });

  it('reads a button press from the form payload', () => {
    const payload = JSON.stringify({
      type: 'block_actions',
      user: { id: 'U1', name: 'ada', team_id: 'T1' },
      team: { id: 'T1' },
      channel: { id: 'D1' },
      container: { message_ts: '2.2' },
      actions: [{ value: 'a:d:X', action_ts: '3.3' }],
    });
    expect(slack.parse({ payload })).toEqual([
      { kind: 'button', provider: 'slack', eventId: '2.2:3.3', senderId: 'T1:U1', chatId: 'D1', displayName: 'ada', data: 'a:d:X', ackId: null },
    ]);
  });

  it('posts blocks with buttons, as the bot', () => {
    const [call] = slack.send({ chatId: 'D1', text: 'Send it?', buttons: [{ label: 'Confirm', data: 'a:c:1' }, { label: 'Open', url: 'https://milyonuse.com' }] });
    expect(call).toMatchObject({ url: 'https://slack.com/api/chat.postMessage' });
    const body = JSON.parse((call as { body: string }).body);
    expect(body.blocks[1].elements).toEqual([
      { type: 'button', text: { type: 'plain_text', text: 'Confirm' }, value: 'a:c:1', action_id: 'act_0' },
      { type: 'button', text: { type: 'plain_text', text: 'Open' }, url: 'https://milyonuse.com', action_id: 'open_1' },
    ]);
    expect((call as { headers: Record<string, string> }).headers.authorization).toBe('Bearer xoxb-1');
  });
});
