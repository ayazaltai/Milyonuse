import { describe, expect, it } from 'vitest';
import { LocalSandbox } from './local.sandbox.js';
import { sandboxName } from './sandbox.port.js';

describe('the local sandbox (development only)', () => {
  const sandbox = new LocalSandbox();

  it('runs Python with its files, and brings back what it printed and wrote to out/', async () => {
    const result = await sandbox.run({
      runtime: 'python',
      code: "import csv\nrows=list(csv.reader(open('in/data.csv')))\nprint(len(rows))\nopen('out/sum.txt','w').write(str(sum(int(r[0]) for r in rows)))",
      files: [{ name: 'data.csv', bytes: Buffer.from('1\n2\n3\n') }],
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: '3\n', timedOut: false });
    expect(result.files.map((f) => [f.name, f.bytes.toString()])).toEqual([['sum.txt', '6']]);
  });

  it('runs Node, and reports a failure with its error', async () => {
    const result = await sandbox.run({ runtime: 'node', code: "console.log('hi'); throw new Error('boom')", files: [], timeoutMs: 20_000 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toContain('boom');
  });

  it('stops code at its time limit', async () => {
    const result = await sandbox.run({ runtime: 'python', code: 'while True: pass', files: [], timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
  });

  it('starts code with no secret in its environment', async () => {
    process.env['TEST_SECRET_TOKEN'] = 'should-not-leak';
    const result = await sandbox.run({ runtime: 'python', code: "import os\nprint(sorted(k for k in os.environ if 'TOKEN' in k or 'DATABASE' in k))", files: [], timeoutMs: 20_000 });
    delete process.env['TEST_SECRET_TOKEN'];
    expect(result.stdout.trim()).toBe('[]');
  });

  it('keeps file names to one safe segment', () => {
    expect(sandboxName('../../x.csv')).toBe('x.csv');
    expect(sandboxName('.env')).toBe('env');
    expect(sandboxName('a/b c$.txt')).toBe('b c_.txt');
  });
});
