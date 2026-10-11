import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type ConnectionAppView,
  type ConnectionStartInput,
  type ConnectionStartResult,
  type ConnectionToolView,
  type ConnectionUpdateInput,
  type ConnectionView,
  ErrorCode,
  type Principal,
} from '@milyonuse/contracts';
import { type ToolRisk, destinationProblem, looksIrreversible, redact } from '@milyonuse/security';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import { AppLogger } from '../../common/logging/logger.js';
import { secretBoxFor } from '../../common/secret-box.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { ActionService } from '../agent/actions/action.service.js';
import { AgentToolbox } from '../agent/agent.toolbox.js';
import { type AgentTool, type ToolContext, ToolError, tool } from '../agent/tools/tool.js';
import { rethrowDatabaseError } from '../tenancy/database-error.js';
import { AuditService } from '../tenancy/audit.service.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';
import { WEB_FETCHER, type WebFetcher, bodyText } from '../tools/web/fetcher.js';
import { warningsFor } from '../tools/web/web.tools.js';
import { APPS, type AppDefinition, GOOGLE_AUTH, appOf, appView, googleConfigured } from './catalogue.js';
import { type GoogleCall, calendarTools, driveTools, gmailTools } from './google.tools.js';
import { McpClient, McpError, type McpToolInfo } from './mcp.client.js';
import {
  type AuthServer,
  type OAuthClient,
  OAuthFailed,
  type TokenSet,
  authorizeUrl,
  discover,
  exchangeCode,
  pkcePair,
  refresh,
  register,
  sha256Hex,
  stateToken,
} from './oauth.js';

/** What a connection keeps sealed: its tokens, and how to refresh them. */
interface Secret {
  accessToken: string;
  refreshToken?: string | null | undefined;
  expiresAt?: number | null | undefined;
  client?: OAuthClient | undefined;
  authServer?: AuthServer | undefined;
  resource?: string | undefined;
}

/** What an authorization in flight keeps sealed until the person comes back. */
interface PendingAuth {
  verifier: string;
  client: OAuthClient;
  authServer: AuthServer;
  resource?: string | undefined;
  name: string;
  scopes: string[];
}

interface StoredTool {
  name: string;
  toolName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
  reversible: boolean;
}

interface ConnectionRow {
  id: string;
  provider: string;
  name: string;
  transport: 'mcp_http' | 'oauth_api';
  server_url: string | null;
  status: 'active' | 'disabled' | 'error' | 'revoked';
  scopes: string[];
  tools: StoredTool[];
  account_label: string | null;
  last_error: string | null;
  last_used_at: Date | null;
  created_at: Date;
}

const SELECT = `SELECT id, provider, name, transport, server_url, status::text AS status, scopes, tools, account_label,
                       last_error, last_used_at, created_at FROM connections`;

/** Verbs a read is named by: a server's claim that a tool only reads is believed only for a tool named like one. */
const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'find', 'fetch', 'query', 'describe', 'view', 'lookup', 'show', 'retrieve', 'count']);

/** The risk we give a server's tool — its own annotations only ever make it safer if its name agrees. */
export function riskOfMcpTool(t: McpToolInfo): { risk: ToolRisk; reversible: boolean } {
  const words = t.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (t.annotations?.destructiveHint === true) return { risk: 'danger', reversible: false };
  if (looksIrreversible(t.name)) return { risk: 'caution', reversible: false };
  if (t.annotations?.readOnlyHint === true && words.some((w) => READ_VERBS.has(w))) return { risk: 'safe', reversible: true };
  return { risk: 'caution', reversible: true };
}

function slug(text: string, max: number): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || 'x';
}

export function mcpToolName(prefix: string, name: string): string {
  return `mcp_${prefix}_${slug(name, 60 - prefix.length)}`.slice(0, 64);
}

/**
 * A person's connections (F3 §3): the apps they connected, kept with their
 * secrets sealed (AES-256-GCM, bound to the connection) and offered to the
 * agent as that person's own tools.
 *
 * Connecting is OAuth 2.1 with PKCE where the app supports it — discovering
 * the server, registering ourselves, sending the person to consent, and
 * exchanging the code when they come back — or a token they paste. A
 * connection that fails authorization is marked `error`; a disconnected one
 * loses its secrets in the database at once and its tools from the next turn,
 * and a proposal that needed it fails at confirm.
 */
@Injectable()
export class ConnectionsService implements OnModuleInit {
  constructor(
    private readonly scope: TenantScope,
    private readonly audit: AuditService,
    private readonly toolbox: AgentToolbox,
    private readonly actions: ActionService,
    @Inject(WEB_FETCHER) private readonly fetcher: WebFetcher,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.toolbox.addSource((principal) => this.toolsFor(principal));
  }

  private run<T>(principal: Pick<Principal, 'organizationId' | 'memberId'>, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.scope.run({ organizationId: principal.organizationId, memberId: principal.memberId }, fn);
  }

  private get redirectUri(): string {
    return `${this.env.APP_BASE_URL.replace(/\/$/, '')}/api/v1/connections/callback`;
  }

  // ────────────────────────────────────────────────────────────────── read

  apps(): ConnectionAppView[] {
    return APPS.map((a) => appView(a, this.env));
  }

  async list(principal: Principal): Promise<ConnectionView[]> {
    return this.run(principal, async (client) => {
      const { rows } = await client.query<ConnectionRow>(`${SELECT} WHERE status <> 'revoked' ORDER BY created_at`);
      return rows.map(view);
    });
  }

  async get(principal: Principal, id: string): Promise<ConnectionView> {
    return this.run(principal, async (client) => view(await this.row(client, id)));
  }

  private async row(client: pg.PoolClient, id: string): Promise<ConnectionRow> {
    const { rows } = await client.query<ConnectionRow>(`${SELECT} WHERE id = $1 AND status <> 'revoked'`, [id]);
    if (!rows[0]) throw AppError.notFound('Connection');
    return rows[0];
  }

  // ──────────────────────────────────────────────────────────────── connect

  async start(principal: Principal, input: ConnectionStartInput): Promise<ConnectionStartResult> {
    const app = appOf(input.provider);
    if (!app) throw AppError.notFound('App');
    const serverUrl = app.transport === 'mcp_http' ? (app.provider === 'custom' ? input.serverUrl : app.serverUrl) : undefined;
    if (app.transport === 'mcp_http') {
      if (!serverUrl) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Give the MCP server’s address.');
      const problem = destinationProblem(serverUrl);
      if (problem) throw new AppError(ErrorCode.VALIDATION_FAILED, `That address cannot be connected: ${problem}.`);
    }
    const name = input.name ?? (app.provider === 'custom' ? new URL(serverUrl!).hostname : app.name);

    if (input.token || app.auth === 'token') {
      if (!input.token) throw new AppError(ErrorCode.VALIDATION_FAILED, `${app.name} connects with a token: paste one.`);
      const connection = await this.create(principal, app, { name, serverUrl, secret: { accessToken: input.token }, scopes: [] });
      return { authorizeUrl: null, connection };
    }

    let authServer: AuthServer;
    let client: OAuthClient;
    let scopes = app.scopes;
    const extra: Record<string, string> = {};
    if (app.auth === 'google') {
      if (!googleConfigured(this.env)) throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, `${app.name} is not available on this deployment yet.`);
      authServer = GOOGLE_AUTH;
      client = { clientId: this.env.GOOGLE_CLIENT_ID!, clientSecret: this.env.GOOGLE_CLIENT_SECRET };
      Object.assign(extra, { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' });
    } else {
      try {
        authServer = await discover(this.fetcher, serverUrl!);
        client = await register(this.fetcher, authServer, this.redirectUri);
      } catch (error) {
        if (error instanceof OAuthFailed) throw new AppError(ErrorCode.CONFLICT, error.message);
        throw new AppError(ErrorCode.CONFLICT, 'The server could not be reached to authorize with it.');
      }
      if (scopes.length === 0 && authServer.scopesSupported.length > 0) scopes = authServer.scopesSupported.slice(0, 20);
    }
    const state = stateToken();
    const { verifier, challenge } = pkcePair();
    const stateHash = sha256Hex(state);
    const pending: PendingAuth = { verifier, client, authServer, resource: serverUrl, name, scopes };
    const sealed = secretBoxFor(this.env).seal(JSON.stringify(pending), `oauth-state:${stateHash}`);
    await this.run(principal, (c) =>
      c.query(
        `INSERT INTO connection_oauth_states (organization_id, member_id, state_hash, provider, server_url, key_version, iv, tag, ciphertext)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [principal.organizationId, principal.memberId, stateHash, app.provider, serverUrl ?? null, sealed.keyVersion, sealed.iv, sealed.tag, sealed.ciphertext],
      ),
    );
    return {
      authorizeUrl: authorizeUrl(authServer, client, { redirectUri: this.redirectUri, state, challenge, scopes, resource: serverUrl, extra }),
      connection: null,
    };
  }

  /** The person came back from the app's consent page: the code becomes a connection. */
  async callback(principal: Principal, input: { state: string; code?: string | undefined; error?: string | undefined }): Promise<ConnectionView> {
    const stateHash = sha256Hex(input.state);
    const pending = await this.run(principal, async (client) => {
      const { rows } = await client.query<{ provider: string; server_url: string | null; key_version: number; iv: Buffer; tag: Buffer; ciphertext: Buffer }>(
        `SELECT provider, server_url, key_version, iv, tag, ciphertext FROM connection_oauth_states WHERE state_hash = $1`,
        [stateHash],
      );
      const row = rows[0];
      if (!row) throw AppError.notFound('Authorization');
      try {
        await client.query(`UPDATE connection_oauth_states SET used_at = now() WHERE state_hash = $1`, [stateHash]);
      } catch (error) {
        rethrowDatabaseError(error);
      }
      const auth = JSON.parse(
        secretBoxFor(this.env).open({ keyVersion: row.key_version, iv: row.iv, tag: row.tag, ciphertext: row.ciphertext }, `oauth-state:${stateHash}`),
      ) as PendingAuth;
      return { ...auth, provider: row.provider, serverUrl: row.server_url };
    });
    if (input.error || !input.code) throw new AppError(ErrorCode.CONFLICT, `The app did not grant access${input.error ? ` (${redact(input.error).slice(0, 60)})` : ''}.`);
    const app = appOf(pending.provider)!;
    let tokens: TokenSet;
    try {
      tokens = await exchangeCode(this.fetcher, pending.authServer, pending.client, {
        code: input.code,
        verifier: pending.verifier,
        redirectUri: this.redirectUri,
        resource: pending.resource,
      });
    } catch (error) {
      throw new AppError(ErrorCode.CONFLICT, error instanceof OAuthFailed ? error.message : 'The app did not issue a token.');
    }
    return this.create(principal, app, {
      name: pending.name,
      serverUrl: pending.serverUrl ?? undefined,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : pending.scopes,
      secret: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        client: pending.client.clientSecret && app.auth === 'google' ? { clientId: pending.client.clientId } : pending.client,
        authServer: pending.authServer,
        resource: pending.resource,
      },
    });
  }

  /** A new connection replaces the person's earlier one to the same app — reconnecting is connecting again. */
  private async create(
    principal: Principal,
    app: AppDefinition,
    input: { name: string; serverUrl?: string | undefined; scopes: string[]; secret: Secret },
  ): Promise<ConnectionView> {
    const id = await this.run(principal, async (client) => {
      const previous = await client.query<{ id: string }>(
        `UPDATE connections SET status = 'revoked' WHERE provider = $1 AND server_url IS NOT DISTINCT FROM $2 AND status <> 'revoked' RETURNING id`,
        [app.provider, input.serverUrl ?? null],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO connections (organization_id, member_id, provider, name, transport, server_url, scopes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [principal.organizationId, principal.memberId, app.provider, input.name.slice(0, 80), app.transport, input.serverUrl ?? null, input.scopes],
      );
      const connectionId = rows[0]!.id;
      await this.saveSecret(client, principal, connectionId, input.secret);
      await this.audit.record(client, {
        organizationId: principal.organizationId,
        actorMemberId: principal.memberId,
        action: 'connection.connected',
        resourceType: 'connection',
        resourceId: connectionId,
        after: { provider: app.provider, replaced: previous.rows.map((r) => r.id) },
      });
      return connectionId;
    });
    try {
      await this.refreshTools(principal, id);
    } catch (error) {
      // Connected but not usable yet: kept, marked, and said — the person can retry or disconnect.
      this.logger.warn('connection tools not listed', { provider: app.provider, err: error instanceof Error ? error.message : String(error) });
    }
    return this.get(principal, id);
  }

  private async saveSecret(client: pg.PoolClient, principal: Pick<Principal, 'organizationId' | 'memberId'>, id: string, secret: Secret): Promise<void> {
    const sealed = secretBoxFor(this.env).seal(JSON.stringify(secret), `connection:${id}`);
    await client.query(
      `INSERT INTO connection_secrets (connection_id, organization_id, member_id, key_version, iv, tag, ciphertext, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (connection_id) DO UPDATE SET key_version = EXCLUDED.key_version, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
         ciphertext = EXCLUDED.ciphertext, expires_at = EXCLUDED.expires_at`,
      [
        id,
        principal.organizationId,
        principal.memberId,
        sealed.keyVersion,
        sealed.iv,
        sealed.tag,
        sealed.ciphertext,
        secret.expiresAt ? new Date(secret.expiresAt) : null,
      ],
    );
  }

  // ──────────────────────────────────────────────────────── tokens and tools

  /** A working access token: refreshed first when it is about to lapse, or when `force`d after a refusal. */
  private async token(principal: Pick<Principal, 'organizationId' | 'memberId'>, id: string, force = false): Promise<string> {
    return this.run(principal, async (client) => {
      const { rows } = await client.query<{ key_version: number; iv: Buffer; tag: Buffer; ciphertext: Buffer }>(
        `SELECT s.key_version, s.iv, s.tag, s.ciphertext FROM connection_secrets s
           JOIN connections c ON c.id = s.connection_id WHERE s.connection_id = $1 AND c.status IN ('active', 'error')
          FOR UPDATE OF s`,
        [id],
      );
      if (!rows[0]) throw new ToolError('This app is no longer connected.');
      const secret = JSON.parse(secretBoxFor(this.env).open({ keyVersion: rows[0].key_version, iv: rows[0].iv, tag: rows[0].tag, ciphertext: rows[0].ciphertext }, `connection:${id}`)) as Secret;
      const lapsing = secret.expiresAt !== null && secret.expiresAt !== undefined && secret.expiresAt < Date.now() + 60_000;
      if ((!force && !lapsing) || !secret.refreshToken || !secret.authServer || !secret.client) return secret.accessToken;
      const clientCreds = secret.authServer.issuer === GOOGLE_AUTH.issuer ? { clientId: this.env.GOOGLE_CLIENT_ID ?? secret.client.clientId, clientSecret: this.env.GOOGLE_CLIENT_SECRET } : secret.client;
      let tokens: TokenSet;
      try {
        tokens = await refresh(this.fetcher, secret.authServer, clientCreds, secret.refreshToken, secret.resource);
      } catch {
        await client.query(`UPDATE connections SET status = 'error', last_error = $2 WHERE id = $1`, [id, 'Authorization expired; connect again.']);
        throw new ToolError('This app’s authorization expired. Ask the person to connect it again on the Connections page.');
      }
      await this.saveSecret(client, principal, id, { ...secret, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt });
      return tokens.accessToken;
    });
  }

  private mcp(principal: Pick<Principal, 'organizationId' | 'memberId'>, row: Pick<ConnectionRow, 'id' | 'server_url'>, context?: ToolContext) {
    const headers: Record<string, string> = context?.actionId ? { 'x-milyonuse-action': this.actions.provenance(context.actionId) } : {};
    return async <T>(use: (client: McpClient) => Promise<T>): Promise<T> => {
      for (const force of [false, true]) {
        const client = new McpClient(row.server_url!, this.fetcher, { bearer: await this.token(principal, row.id, force), headers });
        try {
          await client.initialize();
          return await use(client);
        } catch (error) {
          if (error instanceof McpError && error.unauthorized && !force) continue;
          if (error instanceof McpError && error.unauthorized) {
            await this.markError(principal, row.id, 'The server refused the authorization; connect again.');
          }
          throw error;
        }
      }
      throw new ToolError('The server refused the authorization.');
    };
  }

  private googleCall(principal: Pick<Principal, 'organizationId' | 'memberId'>, id: string): GoogleCall {
    return async (url, init) => {
      for (const force of [false, true]) {
        const response = await this.fetcher(url, {
          method: init?.method === 'GET' || !init?.method ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${await this.token(principal, id, force)}`,
            accept: 'application/json',
            ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(init?.method && !['GET', 'POST'].includes(init.method) ? { 'x-http-method-override': init.method } : {}),
          },
          ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          timeoutMs: 20_000,
          maxBytes: 5_000_000,
          allowHttp: false,
          maxRedirects: 2,
        });
        if (response.status === 401 && !force) continue;
        const text = bodyText(response);
        return { status: response.status, data: parseJson(text), text };
      }
      throw new ToolError('Google refused the authorization.');
    };
  }

  private async markError(principal: Pick<Principal, 'organizationId' | 'memberId'>, id: string, message: string): Promise<void> {
    await this.run(principal, (c) => c.query(`UPDATE connections SET status = 'error', last_error = $2 WHERE id = $1 AND status = 'active'`, [id, message]));
  }

  /** Lists the server's tools again, with the risk we give each; an account label for Google. */
  async refreshTools(principal: Principal, id: string): Promise<ConnectionView> {
    const row = await this.run(principal, (c) => this.row(c, id));
    let tools: StoredTool[] = [];
    let label: string | null = row.account_label;
    try {
      if (row.transport === 'mcp_http') {
        const listed = await this.mcp(principal, row)((client) => client.listTools());
        const prefix = row.provider === 'custom' ? slug(row.name, 16) : row.provider;
        const seen = new Set<string>();
        tools = listed
          .map((t) => ({
            name: t.name,
            toolName: mcpToolName(prefix, t.name),
            title: redact(t.title ?? t.annotations?.title ?? t.name).slice(0, 120),
            description: redact(t.description ?? '').slice(0, 1000),
            inputSchema: t.inputSchema,
            ...riskOfMcpTool(t),
          }))
          .filter((t) => (seen.has(t.toolName) ? false : (seen.add(t.toolName), true)));
      } else {
        const me = await this.googleCall(principal, id)('https://openidconnect.googleapis.com/v1/userinfo');
        label = typeof (me.data as { email?: unknown } | null)?.email === 'string' ? (me.data as { email: string }).email : label;
        // Google's tools are ours, not listed by a server: kept for the card all the same.
        const own = this.googleTools(row.provider, id, label ?? row.name, () => Promise.reject(new Error('listing only')));
        tools = own.map((t) => ({
          name: t.name,
          toolName: t.name,
          title: t.summary,
          description: t.description,
          inputSchema: {},
          risk: t.risk ?? 'safe',
          reversible: t.reversible ?? true,
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? redact(error.message).slice(0, 300) : 'The app could not be reached.';
      await this.run(principal, (c) => c.query(`UPDATE connections SET status = 'error', last_error = $2 WHERE id = $1`, [id, message]));
      throw new AppError(ErrorCode.CONFLICT, `Connected, but its tools could not be listed: ${message}`);
    }
    await this.run(principal, (c) =>
      c.query(`UPDATE connections SET tools = $2, account_label = $3, status = 'active', last_error = NULL WHERE id = $1 AND status IN ('active', 'error')`, [
        id,
        JSON.stringify(tools),
        label,
      ]),
    );
    return this.get(principal, id);
  }

  async update(principal: Principal, id: string, input: ConnectionUpdateInput): Promise<ConnectionView> {
    return this.run(principal, async (client) => {
      const row = await this.row(client, id);
      const status = input.enabled === undefined ? row.status : input.enabled ? (row.status === 'disabled' ? 'active' : row.status) : 'disabled';
      await client.query(`UPDATE connections SET name = $2, status = $3 WHERE id = $1`, [id, input.name ?? row.name, status]);
      await this.audit.record(client, {
        organizationId: principal.organizationId,
        actorMemberId: principal.memberId,
        action: 'connection.updated',
        resourceType: 'connection',
        resourceId: id,
        before: { name: row.name, status: row.status },
        after: { name: input.name ?? row.name, status },
      });
      return view(await this.row(client, id));
    });
  }

  /** Disconnects: revoked in the database, which deletes its secrets in the same statement. */
  async revoke(principal: Principal, id: string): Promise<void> {
    await this.run(principal, async (client) => {
      const row = await this.row(client, id);
      await client.query(`UPDATE connections SET status = 'revoked' WHERE id = $1`, [id]);
      await this.audit.record(client, {
        organizationId: principal.organizationId,
        actorMemberId: principal.memberId,
        action: 'connection.disconnected',
        resourceType: 'connection',
        resourceId: id,
        before: { provider: row.provider, name: row.name },
      });
    });
  }

  // ────────────────────────────────────────────────────── the agent's tools

  /** The tools a person's active connections give the agent. */
  async toolsFor(principal: Principal): Promise<AgentTool[]> {
    const rows = await this.run(principal, async (client) => (await client.query<ConnectionRow>(`${SELECT} WHERE status = 'active' ORDER BY created_at`)).rows);
    const out: AgentTool[] = [];
    for (const row of rows) {
      const tools =
        row.transport === 'oauth_api'
          ? this.googleTools(row.provider, row.id, row.account_label ?? row.name, this.googleCall(principal, row.id))
          : row.tools.map((t) => this.mcpTool(principal, row, t));
      out.push(...tools.map((t) => ({ ...t, provider: row.provider })));
    }
    return out;
  }

  private googleTools(provider: string, id: string, account: string, call: GoogleCall): AgentTool[] {
    if (provider === 'gmail') return gmailTools(id, account, call);
    if (provider === 'google_calendar') return calendarTools(id, account, call);
    if (provider === 'google_drive') return driveTools(id, account, call);
    return [];
  }

  private mcpTool(principal: Principal, row: ConnectionRow, t: StoredTool): AgentTool {
    return tool({
      name: t.toolName,
      source: t.risk === 'safe',
      connectionId: row.id,
      risk: t.risk,
      reversible: t.reversible,
      summary: `${row.name}: ${t.title}`,
      description: `[${row.name}] ${t.description || t.title}`.slice(0, 1024),
      parameters: t.inputSchema,
      schema: z.record(z.string(), z.unknown()),
      preview: (_context, args) => ({
        title: `${row.name}: ${t.title}`,
        summary: t.reversible ? undefined : 'This cannot be taken back once done.',
        fields: Object.entries(args)
          .slice(0, 20)
          .map(([label, value]) => ({ label, value: (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 500) })),
      }),
      run: async (context, args) => {
        const result = await this.mcp(principal, row, context)((client) => client.callTool(t.name, args));
        await this.run(principal, (c) => c.query(`UPDATE connections SET last_used_at = now() WHERE id = $1`, [row.id]));
        if (result.isError) throw new ToolError(`${row.name} answered with an error: ${result.text.slice(0, 500) || 'no reason given'}`);
        const text = result.text.slice(0, 50_000);
        return {
          kind: 'data',
          from: `${row.name}: ${t.title}`,
          data: { text, structured: result.structured, warnings: warningsFor(text) },
          reads: [{ kind: 'third_party', uri: `mcp:${row.provider}:${t.name}` }],
        };
      },
    });
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

function view(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    transport: row.transport,
    serverUrl: row.server_url,
    status: row.status,
    scopes: row.scopes,
    accountLabel: row.account_label,
    tools: row.tools.map((t): ConnectionToolView => ({ name: t.toolName, title: t.title, description: t.description, risk: t.risk, reversible: t.reversible })),
    lastError: row.last_error,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
