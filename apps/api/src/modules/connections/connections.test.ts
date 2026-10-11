import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mcpToolName, riskOfMcpTool } from './connections.service.js';
import { mimeMessage } from './google.tools.js';
import { fromEventStream } from './mcp.client.js';
import { authorizeUrl, pkcePair } from './oauth.js';

describe('MCP', () => {
  it('finds our response among a stream’s events', () => {
    const stream = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n';
    expect(fromEventStream(stream, 7)).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    expect(fromEventStream(stream, 8)).toBeNull();
  });

  it('names a server’s tools within the model’s limits, namespaced', () => {
    expect(mcpToolName('notion', 'notion-search')).toBe('mcp_notion_notion_search');
    expect(mcpToolName('custom', 'A'.repeat(100)).length).toBeLessThanOrEqual(64);
    expect(mcpToolName('x', 'Create Page!')).toBe('mcp_x_create_page');
  });

  it('gives a tool our risk: a server’s annotations only make it safer when its name agrees', () => {
    const t = (name: string, annotations?: Record<string, boolean>) => ({ name, inputSchema: {}, annotations });
    expect(riskOfMcpTool(t('search_pages', { readOnlyHint: true }))).toEqual({ risk: 'safe', reversible: true });
    expect(riskOfMcpTool(t('update_page', { readOnlyHint: true }))).toEqual({ risk: 'caution', reversible: true });
    expect(riskOfMcpTool(t('send_message', { readOnlyHint: true }))).toEqual({ risk: 'caution', reversible: false });
    expect(riskOfMcpTool(t('archive_page', { destructiveHint: true }))).toEqual({ risk: 'danger', reversible: false });
    expect(riskOfMcpTool(t('create_page'))).toEqual({ risk: 'caution', reversible: true });
  });
});

describe('OAuth', () => {
  it('makes a PKCE pair whose challenge is the S256 of its verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(pkcePair().verifier).not.toBe(verifier);
  });

  it('asks for S256, the resource and the scopes, with our redirect', () => {
    const url = new URL(
      authorizeUrl(
        { issuer: 'https://a', authorizationEndpoint: 'https://a/authorize', tokenEndpoint: 'https://a/token', registrationEndpoint: null, scopesSupported: [] },
        { clientId: 'c1' },
        { redirectUri: 'https://app/cb', state: 's', challenge: 'ch', scopes: ['read', 'write'], resource: 'https://mcp/x' },
      ),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'c1',
      redirect_uri: 'https://app/cb',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      scope: 'read write',
      resource: 'https://mcp/x',
    });
  });
});

describe('an email’s message', () => {
  it('is plain text in UTF-8, the subject encoded when it is not ASCII', () => {
    const message = mimeMessage({ to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'], subject: 'Toplantı', body: 'Merhaba Ayşe' });
    expect(message).toContain('To: a@example.com, b@example.com\r\nCc: c@example.com');
    expect(message).toContain(`Subject: =?UTF-8?B?${Buffer.from('Toplantı').toString('base64')}?=`);
    expect(Buffer.from(message.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Merhaba Ayşe');
  });
});
