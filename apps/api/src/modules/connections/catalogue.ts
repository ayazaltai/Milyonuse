import type { ConnectionAppView } from '@milyonuse/contracts';
import type { Env } from '../../config/env.js';
import type { AuthServer } from './oauth.js';

/**
 * The apps a person can connect, each an "app card" (F3 §3). An MCP app is a
 * remote server we authorize with by OAuth 2.1 (registering ourselves where
 * the server allows it) or a token; a Google app is Google's own API with our
 * OAuth client. A custom card connects any MCP server the person names.
 */

export interface AppDefinition {
  provider: string;
  name: string;
  description: string;
  transport: 'mcp_http' | 'oauth_api';
  /** An MCP app's server. */
  serverUrl?: string;
  /** How it authorizes: OAuth 2.1 with discovery, a token the person pastes, or Google's client. */
  auth: 'oauth' | 'token' | 'google';
  scopes: string[];
}

const GOOGLE_SCOPES: Record<string, string[]> = {
  gmail: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
  google_calendar: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
  google_drive: ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly'],
};

export const APPS: readonly AppDefinition[] = [
  {
    provider: 'milyonus',
    name: 'Milyonus',
    description: 'Your AI interviewer: positions, candidates, interviews and reports — as yourself, with every change confirmed.',
    transport: 'mcp_http',
    serverUrl: 'https://platform.milyonus.com/api/v1/mcp',
    auth: 'oauth',
    scopes: [],
  },
  {
    provider: 'gmail',
    name: 'Gmail',
    description: 'Search and read your mail; draft and send — every send confirmed by you.',
    transport: 'oauth_api',
    auth: 'google',
    scopes: GOOGLE_SCOPES['gmail']!,
  },
  {
    provider: 'google_calendar',
    name: 'Google Calendar',
    description: 'See your events and create or move them, with your confirmation.',
    transport: 'oauth_api',
    auth: 'google',
    scopes: GOOGLE_SCOPES['google_calendar']!,
  },
  {
    provider: 'google_drive',
    name: 'Google Drive',
    description: 'Find and read your documents. Read-only.',
    transport: 'oauth_api',
    auth: 'google',
    scopes: GOOGLE_SCOPES['google_drive']!,
  },
  {
    provider: 'notion',
    name: 'Notion',
    description: 'Search and read your pages; create and update them with your confirmation.',
    transport: 'mcp_http',
    serverUrl: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    scopes: [],
  },
  {
    provider: 'github',
    name: 'GitHub',
    description: 'Repositories, issues and pull requests, with a token you create on GitHub.',
    transport: 'mcp_http',
    serverUrl: 'https://api.githubcopilot.com/mcp/',
    auth: 'token',
    scopes: [],
  },
  {
    provider: 'custom',
    name: 'Another MCP server',
    description: 'Any remote MCP server: its address, and OAuth or a token.',
    transport: 'mcp_http',
    auth: 'oauth',
    scopes: [],
  },
];

export function appOf(provider: string): AppDefinition | undefined {
  return APPS.find((a) => a.provider === provider);
}

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function appView(app: AppDefinition, env: Env): ConnectionAppView {
  return {
    provider: app.provider,
    name: app.name,
    description: app.description,
    transport: app.transport,
    available: app.auth !== 'google' || googleConfigured(env),
    custom: app.provider === 'custom',
    scopes: app.scopes,
  };
}

export const GOOGLE_AUTH: AuthServer = {
  issuer: 'https://accounts.google.com',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  registrationEndpoint: null,
  scopesSupported: [],
};
