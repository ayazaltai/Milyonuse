import { createHash, randomBytes } from 'node:crypto';
import { redact } from '@milyonuse/security';
import type { WebFetcher } from '../tools/web/fetcher.js';
import { bodyText } from '../tools/web/fetcher.js';

/**
 * OAuth 2.1 as a client (F3 §3), the way an MCP server expects it:
 *
 *   discover   the resource's metadata (RFC 9728) → its authorization server's (RFC 8414, or OIDC)
 *   register   ourselves, if the server lets clients register (RFC 7591)
 *   authorize  with PKCE S256 only, and the resource named (RFC 8707)
 *   exchange   the code for tokens; refresh them before they lapse
 *
 * Google's apps use the same steps with Google's fixed endpoints and our own
 * client. Every request goes through the SSRF guard, and nothing a server
 * answers is trusted beyond the fields read here.
 */

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopesSupported: string[];
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string | undefined;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
}

export class OAuthFailed extends Error {
  override name = 'OAuthFailed';
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function stateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function getJson(fetcher: WebFetcher, url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(url, { headers: { accept: 'application/json' }, timeoutMs: 10_000, maxBytes: 500_000, allowHttp: false });
    if (response.status !== 200) return null;
    const data = JSON.parse(bodyText(response)) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Where the resource says it is authorized: its protected-resource metadata, at the path-aware place first. */
export async function discover(fetcher: WebFetcher, resource: string): Promise<AuthServer> {
  const url = new URL(resource);
  const path = url.pathname.replace(/\/$/, '');
  const candidates = [
    `${url.origin}/.well-known/oauth-protected-resource${path}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
  let issuer: string | null = null;
  for (const candidate of candidates) {
    const meta = await getJson(fetcher, candidate);
    const servers = meta?.['authorization_servers'];
    if (Array.isArray(servers) && typeof servers[0] === 'string') {
      issuer = servers[0];
      break;
    }
  }
  // A server without the resource metadata is often its own authorization server.
  issuer ??= url.origin;
  const issuerUrl = new URL(issuer);
  const issuerPath = issuerUrl.pathname.replace(/\/$/, '');
  for (const candidate of [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
    `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
  ]) {
    const meta = await getJson(fetcher, candidate);
    if (meta && typeof meta['authorization_endpoint'] === 'string' && typeof meta['token_endpoint'] === 'string') {
      const methods = meta['code_challenge_methods_supported'];
      if (Array.isArray(methods) && !methods.includes('S256')) throw new OAuthFailed('The server does not support PKCE with S256.');
      return {
        issuer: typeof meta['issuer'] === 'string' ? meta['issuer'] : issuer,
        authorizationEndpoint: meta['authorization_endpoint'],
        tokenEndpoint: meta['token_endpoint'],
        registrationEndpoint: typeof meta['registration_endpoint'] === 'string' ? meta['registration_endpoint'] : null,
        scopesSupported: Array.isArray(meta['scopes_supported']) ? meta['scopes_supported'].filter((s): s is string => typeof s === 'string') : [],
      };
    }
  }
  throw new OAuthFailed('The server does not say how to authorize with it.');
}

/** Registers Milyonuse as a public client (PKCE, no secret) with the server. */
export async function register(fetcher: WebFetcher, server: AuthServer, redirectUri: string): Promise<OAuthClient> {
  if (!server.registrationEndpoint) throw new OAuthFailed('The server does not let new apps register; it needs a token instead.');
  const response = await fetcher(server.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Milyonuse',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    timeoutMs: 10_000,
    maxBytes: 200_000,
    allowHttp: false,
    maxRedirects: 0,
  });
  const data = safeJson(bodyText(response));
  if (response.status >= 300 || typeof data['client_id'] !== 'string') {
    throw new OAuthFailed(`The server refused to register the app (${response.status}).`);
  }
  return { clientId: data['client_id'], clientSecret: typeof data['client_secret'] === 'string' ? data['client_secret'] : undefined };
}

export function authorizeUrl(
  server: AuthServer,
  client: OAuthClient,
  input: { redirectUri: string; state: string; challenge: string; scopes: string[]; resource?: string | undefined; extra?: Record<string, string> },
): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.scopes.length > 0) url.searchParams.set('scope', input.scopes.join(' '));
  if (input.resource) url.searchParams.set('resource', input.resource);
  for (const [k, v] of Object.entries(input.extra ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

async function tokenRequest(fetcher: WebFetcher, server: AuthServer, client: OAuthClient, form: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams({ ...form, client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) });
  const response = await fetcher(server.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    timeoutMs: 15_000,
    maxBytes: 200_000,
    allowHttp: false,
    maxRedirects: 0,
  });
  const data = safeJson(bodyText(response));
  if (response.status >= 300 || typeof data['access_token'] !== 'string') {
    const reason = typeof data['error'] === 'string' ? data['error'] : String(response.status);
    throw new OAuthFailed(`The server did not issue a token (${redact(reason).slice(0, 80)}).`);
  }
  const expiresIn = Number(data['expires_in']);
  return {
    accessToken: data['access_token'],
    refreshToken: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    scope: typeof data['scope'] === 'string' ? data['scope'] : null,
  };
}

export function exchangeCode(
  fetcher: WebFetcher,
  server: AuthServer,
  client: OAuthClient,
  input: { code: string; verifier: string; redirectUri: string; resource?: string | undefined },
): Promise<TokenSet> {
  return tokenRequest(fetcher, server, client, {
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    ...(input.resource ? { resource: input.resource } : {}),
  });
}

export async function refresh(
  fetcher: WebFetcher,
  server: AuthServer,
  client: OAuthClient,
  refreshToken: string,
  resource?: string,
): Promise<TokenSet> {
  const tokens = await tokenRequest(fetcher, server, client, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...(resource ? { resource } : {}),
  });
  // A server that does not rotate refresh tokens keeps the one it had.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const data = JSON.parse(text) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
