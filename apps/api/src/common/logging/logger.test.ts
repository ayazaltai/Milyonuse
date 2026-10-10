import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLogger } from './logger.js';

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  fn();
  spy.mockRestore();
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe('AppLogger', () => {
  it('keeps a metadata object as fields', () => {
    const [line] = capture(() => new AppLogger('info').log('api listening', { port: 4000 }));
    expect(JSON.parse(line!)).toMatchObject({ level: 'info', msg: 'api listening', port: 4000 });
  });

  it("does not shred Nest's string context into character keys", () => {
    // Nest calls logger.log(message, 'NestFactory'). Spreading that string
    // produces {"0":"N","1":"e",...} and destroys the log line.
    const [line] = capture(() => new AppLogger('info').log('Starting Nest', 'NestFactory'));
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed['context']).toBe('NestFactory');
    expect(parsed['0']).toBeUndefined();
  });

  it('masks personal data in the message and the metadata before writing', () => {
    const [line] = capture(() =>
      new AppLogger('info').log('invite to ada@example.com', { to: 'ada@example.com', err: 'rejected +1 415 555 0132' }),
    );
    expect(line).not.toContain('ada@example.com');
    expect(line).not.toContain('555');
    expect(JSON.parse(line!)).toMatchObject({ msg: 'invite to [email]', to: '[redacted]', err: 'rejected [phone]' });
  });

  it('respects the minimum level', () => {
    expect(capture(() => new AppLogger('warn').log('quiet'))).toHaveLength(0);
  });
});
