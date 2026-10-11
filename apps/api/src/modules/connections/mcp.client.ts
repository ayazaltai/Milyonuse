import { redact } from '@milyonuse/security';
import type { WebFetcher } from '../tools/web/fetcher.js';
import { bodyText } from '../tools/web/fetcher.js';

/**
 * An MCP client over Streamable HTTP (F3 §3; the transport and namespacing of
 * Agent 5.5 `tools/mcp/client.py` and `manager.py`, for remote servers).
 *
 * Stateless from our side: every use opens with `initialize`, carries the
 * server's session id if it gives one, and is bounded in time (20 s). A server
 * may answer a request as JSON or as a server-sent event stream; both are read.
 * Every request goes through the SSRF guard. A server is untrusted: what it
 * says is redacted before anyone sees it, and an error never carries more than
 * a line of its words.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 20_000;

export interface McpToolInfo {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string } | undefined;
}

export interface McpCallResult {
  isError: boolean;
  text: string;
  structured: unknown;
}

export class McpError extends Error {
  override name = 'McpError';
  constructor(
    message: string,
    readonly status?: number,
    /** The server asked for (fresh) authorization. */
    readonly unauthorized = false,
  ) {
    super(message);
  }
}

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly fetcher: WebFetcher,
    private readonly auth: { bearer?: string | undefined; headers?: Record<string, string> } = {},
  ) {}

  async initialize(): Promise<{ name: string | null; version: string | null }> {
    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Milyonuse', version: '1.0' },
    })) as { serverInfo?: { name?: string; version?: string } };
    await this.notify('notifications/initialized');
    return { name: result.serverInfo?.name ?? null, version: result.serverInfo?.version ?? null };
  }

  async listTools(limit = 200): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10 && tools.length < limit; page += 1) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: McpToolInfo[]; nextCursor?: string };
      for (const t of result.tools ?? []) {
        if (typeof t.name === 'string' && t.name.length > 0) tools.push({ ...t, inputSchema: t.inputSchema ?? { type: 'object' } });
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools.slice(0, limit);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string; resource?: { text?: string; uri?: string } }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : c.type === 'resource' ? (c.resource?.text ?? c.resource?.uri ?? '') : `[${c.type} content]`))
      .join('\n')
      .trim();
    return { isError: result.isError === true, text: redact(text), structured: result.structuredContent ?? null };
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.auth.bearer ? { authorization: `Bearer ${this.auth.bearer}` } : {}),
      ...this.auth.headers,
    };
  }

  private async notify(method: string): Promise<void> {
    await this.fetcher(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      timeoutMs: TIMEOUT_MS,
      allowHttp: false,
      maxRedirects: 0,
    }).catch(() => undefined);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    let response;
    try {
      response = await this.fetcher(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        timeoutMs: TIMEOUT_MS,
        maxBytes: 5_000_000,
        allowHttp: false,
        maxRedirects: 0,
      });
    } catch (error) {
      throw new McpError(`The server could not be reached: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new McpError('The server asked to be authorized again.', response.status, true);
    }
    if (response.status >= 400) throw new McpError(`The server answered ${response.status}.`, response.status);
    const session = response.headers['mcp-session-id'];
    if (session && /^[\x21-\x7e]{1,200}$/.test(session)) this.sessionId = session;
    const text = bodyText(response);
    const message = (response.headers['content-type'] ?? '').includes('text/event-stream') ? fromEventStream(text, id) : parse(text);
    if (!message || typeof message !== 'object') throw new McpError('The server’s answer was not JSON-RPC.');
    const reply = message as { error?: { message?: string }; result?: unknown };
    if (reply.error) throw new McpError(redact(String(reply.error.message ?? 'The server refused the request.')).slice(0, 300));
    return reply.result ?? {};
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The JSON-RPC response with our id among a stream's `data:` events. */
export function fromEventStream(text: string, id: number): unknown {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    const message = parse(data) as { id?: unknown } | null;
    if (message && message.id === id) return message;
  }
  return null;
}
