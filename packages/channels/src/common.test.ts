import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, chunks, codeDigest, codeIn, commandOf, decodeAction, encodeAction, generateCode } from './common.js';

describe('pairing codes', () => {
  it('are eight characters from an alphabet with no look-alikes', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateCode();
      expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`));
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('are found in what a person sends, in any case, alone or after a command', () => {
    expect(codeIn('K7M2Q9XA')).toBe('K7M2Q9XA');
    expect(codeIn('/start k7m2q9xa')).toBe('K7M2Q9XA');
    expect(codeIn('my code is K7M2Q9XA, thanks')).toBe('K7M2Q9XA');
    expect(codeIn('hello there')).toBeNull();
    expect(codeIn('K7M2Q9XAB')).toBeNull();
  });

  it('are stored as a digest that ignores case and spaces', () => {
    expect(codeDigest(' k7m2q9xa ')).toBe(codeDigest('K7M2Q9XA'));
    expect(codeDigest('K7M2Q9XA')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('commands', () => {
  it('read a command, its bot suffix and its words', () => {
    expect(commandOf('/report this week')).toEqual({ name: 'report', args: 'this week' });
    expect(commandOf('/Report@MilyonuseBot')).toEqual({ name: 'report', args: '' });
    expect(commandOf('report this week')).toBeNull();
    expect(commandOf('/9lives')).toBeNull();
  });
});

describe('button data', () => {
  const id = '01JZ5Q8X9V3K7M2Q9XA0B1C2D3';
  it('round-trips a verb and an id within Telegram’s 64 bytes', () => {
    expect(encodeAction('confirm', id)).toBe(`a:c:${id}`);
    expect(Buffer.byteLength(encodeAction('discard', id))).toBeLessThanOrEqual(64);
    expect(decodeAction(encodeAction('discard', id))).toEqual({ verb: 'discard', id });
  });

  it('refuses anything else', () => {
    expect(decodeAction('a:x:' + id)).toBeNull();
    expect(decodeAction('a:c:not-an-id')).toBeNull();
    expect(decodeAction('hello')).toBeNull();
  });
});

describe('chunks', () => {
  it('cut long text on a line break, and keep short text whole', () => {
    expect(chunks('short', 10)).toEqual(['short']);
    const parts = chunks('aaaa\nbbbb\ncccc', 10);
    expect(parts).toEqual(['aaaa\nbbbb', 'cccc']);
    expect(chunks('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });
});
