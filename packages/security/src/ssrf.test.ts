import { describe, expect, it } from 'vitest';
import { SsrfBlocked, destinationProblem, fetchPublic, isPublicAddress, publicLookup, type Resolver } from './ssrf.js';

const resolverOf =
  (...answers: string[][]): Resolver =>
  () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    return Promise.resolve(next.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };

function lookupWith(resolve: Resolver, host = 'site.example'): Promise<string> {
  return new Promise((done, fail) =>
    publicLookup(resolve)(host, {}, (error, address) => (error ? fail(error) : done(address as string))),
  );
}

describe('SSRF: the URL as written', () => {
  it('blocks the cloud metadata address and host names (Agent 5.5 test_ssrf_blocks_metadata)', () => {
    expect(destinationProblem('http://169.254.169.254/latest/meta-data/', { allowHttp: true })).toContain('not a public address');
    expect(destinationProblem('https://metadata.google.internal/computeMetadata/v1/')).toContain('metadata host');
  });

  it('blocks localhost and loopback, however written', () => {
    for (const url of ['http://localhost:4000', 'http://api.localhost', 'http://127.0.0.1', 'http://[::1]/', 'http://0.0.0.0']) {
      expect(destinationProblem(url, { allowHttp: true }), url).not.toBeNull();
    }
  });

  it('blocks private, CGNAT, link-local and IPv4-mapped IPv6 addresses', () => {
    for (const url of ['http://10.0.0.5', 'http://172.16.3.1', 'http://192.168.1.1', 'http://100.64.0.1', 'http://[fe80::1]', 'http://[fc00::1]', 'http://[::ffff:127.0.0.1]']) {
      expect(destinationProblem(url, { allowHttp: true }), url).not.toBeNull();
    }
  });

  it('blocks numeric host spellings a resolver would turn into loopback', () => {
    for (const url of ['http://2130706433/', 'http://0x7f.0.0.1/', 'http://017700000001/']) {
      expect(destinationProblem(url, { allowHttp: true }), url).not.toBeNull();
    }
  });

  it('blocks other schemes, credentials in the URL, and bare internal names (test_ssrf_blocks_file_scheme)', () => {
    expect(destinationProblem('file:///etc/passwd', { allowHttp: true })).toContain('file');
    expect(destinationProblem('gopher://example.com', { allowHttp: true })).toContain('gopher');
    expect(destinationProblem('https://user:pass@example.com')).toContain('credentials');
    expect(destinationProblem('http://intranet/', { allowHttp: true })).toContain('not a public host name');
    expect(destinationProblem('http://db.internal/', { allowHttp: true })).not.toBeNull();
  });

  it('allows a public https URL, and http only where reading allows it (test_ssrf_allows_public)', () => {
    expect(destinationProblem('https://example.com/page?q=1')).toBeNull();
    expect(destinationProblem('http://example.com/')).toContain('http');
    expect(destinationProblem('http://example.com/', { allowHttp: true })).toBeNull();
    expect(destinationProblem('https://93.184.216.34/')).toBeNull();
  });

  it('knows a public address from a private one', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('169.254.169.254')).toBe(false);
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });
});

describe('SSRF: at connection time', () => {
  it('lets a host through whose every address is public', async () => {
    await expect(lookupWith(resolverOf(['93.184.216.34']))).resolves.toBe('93.184.216.34');
  });

  it('refuses a host any of whose addresses is private', async () => {
    await expect(lookupWith(resolverOf(['93.184.216.34', '10.0.0.7']))).rejects.toBeInstanceOf(SsrfBlocked);
  });

  it('refuses DNS rebinding: a host public when checked and private when connected', async () => {
    const rebinding = resolverOf(['93.184.216.34'], ['169.254.169.254']);
    await expect(lookupWith(rebinding)).resolves.toBe('93.184.216.34');
    await expect(lookupWith(rebinding)).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('fails closed when the host does not resolve', async () => {
    const failing: Resolver = () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(lookupWith(failing)).rejects.toThrow('ENOTFOUND');
    await expect(lookupWith(resolverOf([]))).rejects.toBeInstanceOf(SsrfBlocked);
  });

  it('never connects to a private destination, whether written or resolved', async () => {
    await expect(fetchPublic('http://169.254.169.254/latest/')).rejects.toBeInstanceOf(SsrfBlocked);
    await expect(fetchPublic('http://site.example/', { resolve: resolverOf(['127.0.0.1']) })).rejects.toBeInstanceOf(SsrfBlocked);
  });
});
