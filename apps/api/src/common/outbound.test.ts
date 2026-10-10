import { describe, expect, it } from 'vitest';
import { OutboundRefused, destinationProblem, isPublicAddress, postToPublicHttps } from './outbound.js';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('%s is public', (a) => expect(isPublicAddress(a)).toBe(true));
  it.each([
    '10.0.0.5',
    '127.0.0.1',
    '169.254.169.254',
    '172.20.1.1',
    '192.168.1.10',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
  ])('%s is not', (a) => expect(isPublicAddress(a)).toBe(false));
});

describe('destinationProblem', () => {
  it('accepts a public https host', () => {
    expect(destinationProblem('https://hooks.example.com/milyonus')).toBeNull();
  });
  it.each([
    ['http://hooks.example.com/x', /https/],
    ['https://https://hooks.example.com/x', /not a public host name/],
    ['https://localhost:4000/x', /localhost/],
    ['https://api.localhost/x', /localhost/],
    ['https://10.0.0.5/x', /not a public address/],
    ['https://[::1]/x', /not a public address/],
    ['https://user:pass@hooks.example.com/x', /credentials/],
    ['not a url', /not a URL/],
  ])('%s is refused', (url, reason) => expect(destinationProblem(url)).toMatch(reason));
});

describe('postToPublicHttps', () => {
  it('refuses an internal address before opening any connection', async () => {
    await expect(postToPublicHttps('https://127.0.0.1:1/x', { headers: {}, body: '{}', timeoutMs: 1000 })).rejects.toBeInstanceOf(
      OutboundRefused,
    );
  });
});
