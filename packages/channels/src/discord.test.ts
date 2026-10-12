import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DiscordAdapter } from './discord.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const discord = new DiscordAdapter({ applicationId: 'app1', publicKey: raw, botToken: 'bot-token' });
const signed = (body: string, timestamp = '1800000000') => ({
  'X-Signature-Ed25519': sign(null, Buffer.from(timestamp + body), privateKey).toString('hex'),
  'X-Signature-Timestamp': timestamp,
});
const interaction = (extra: Record<string, unknown>) => ({ id: 'i1', channel_id: 'ch1', user: { id: 'u1', username: 'ada' }, ...extra });

describe('Discord', () => {
  it('trusts only an Ed25519 signature by the application’s key', () => {
    const body = JSON.stringify(interaction({ type: 1 }));
    expect(discord.verify({ headers: signed(body), rawBody: body })).toBe(true);
    expect(discord.verify({ headers: signed(body), rawBody: body.replace('i1', 'i2') })).toBe(false);
    expect(discord.verify({ headers: { ...signed(body), 'X-Signature-Timestamp': '1800000001' }, rawBody: body })).toBe(false);
    expect(discord.verify({ headers: {}, rawBody: body })).toBe(false);
  });

  it('answers a ping, defers a command and acknowledges a button at once', () => {
    expect(discord.immediate({ type: 1 })?.body).toBe('{"type":1}');
    expect(discord.immediate({ type: 2 })?.body).toBe('{"type":5}');
    expect(discord.immediate({ type: 3 })?.body).toBe('{"type":6}');
  });

  it('reads /ask as a message, /pair as a code and /run as an automation command', () => {
    expect(discord.parse(interaction({ type: 2, data: { name: 'ask', options: [{ name: 'text', value: 'What is new?' }] } }))[0]).toMatchObject({
      kind: 'message',
      text: 'What is new?',
      isGroup: false,
      command: null,
    });
    expect(discord.parse(interaction({ type: 2, data: { name: 'pair', options: [{ name: 'code', value: 'K7M2Q9XA' }] } }))[0]).toMatchObject({ text: 'K7M2Q9XA' });
    expect(discord.parse(interaction({ type: 2, guild_id: 'g1', member: { user: { id: 'u1' } }, data: { name: 'run', options: [{ name: 'name', value: 'Report' }] } }))[0]).toMatchObject({
      command: { name: 'report', args: '' },
      isGroup: true,
    });
  });

  it('reads a button press by its custom id', () => {
    expect(discord.parse(interaction({ type: 3, data: { custom_id: 'a:c:X' } }))).toEqual([
      { kind: 'button', provider: 'discord', eventId: 'i1', senderId: 'u1', chatId: 'ch1', displayName: 'ada', data: 'a:c:X', ackId: null },
    ]);
  });

  it('posts to the channel as the bot, with buttons and no mentions', () => {
    const [call] = discord.send({ chatId: 'ch1', text: 'Send it?', buttons: [{ label: 'Confirm', data: 'a:c:1' }, { label: 'Open', url: 'https://milyonuse.com' }] });
    expect(call).toMatchObject({ url: 'https://discord.com/api/v10/channels/ch1/messages' });
    const body = JSON.parse((call as { body: string }).body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.components[0].components).toEqual([
      { type: 2, style: 1, label: 'Confirm', custom_id: 'a:c:1' },
      { type: 2, style: 5, label: 'Open', url: 'https://milyonuse.com' },
    ]);
  });
});
