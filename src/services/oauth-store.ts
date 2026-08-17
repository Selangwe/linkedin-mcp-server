import crypto from "crypto";
import { createKeyValueStore, type IKeyValueStore } from "./kv-store.js";

/**
 * Minimal, single-user OAuth 2.1 authorization server storage, backing the
 * /register, /authorize, and /token routes in app.ts. This exists purely so
 * Claude's (and other MCP clients') built-in "custom connector" OAuth flow
 * has something real to talk to — there's still exactly one LinkedIn
 * account and one operator behind it (see /authorize's consent gate).
 *
 * All four record types share one underlying store (file or Redis,
 * following TOKEN_STORE_DRIVER, same as token-store.ts), each with its own
 * key prefix so they can never collide even on the Redis backend where
 * every store shares one keyspace.
 */

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
  created_at: number;
}

export interface AuthorizationCodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  resource?: string;
  scope?: string;
  expires_at: number;
}

export interface AccessTokenRecord {
  client_id: string;
  scope?: string;
  resource?: string;
  expires_at: number;
}

export interface RefreshTokenRecord {
  client_id: string;
  scope?: string;
  resource?: string;
}

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour — short-lived, refreshed via refresh_token
const AUTH_CODE_TTL_SECONDS = 10 * 60; // 10 minutes, single-use

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export class OAuthStore {
  private readonly clients: IKeyValueStore;
  private readonly codes: IKeyValueStore;
  private readonly accessTokens: IKeyValueStore;
  private readonly refreshTokens: IKeyValueStore;

  constructor() {
    this.clients = createKeyValueStore("oauth-clients");
    this.codes = createKeyValueStore("oauth-codes");
    this.accessTokens = createKeyValueStore("oauth-access");
    this.refreshTokens = createKeyValueStore("oauth-refresh");
  }

  async registerClient(input: { client_name?: string; redirect_uris: string[] }): Promise<OAuthClient> {
    const client: OAuthClient = {
      client_id: randomToken(16),
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      created_at: Date.now(),
    };
    await this.clients.set(`client:${client.client_id}`, client);
    return client;
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    return this.clients.get<OAuthClient>(`client:${clientId}`);
  }

  async createAuthorizationCode(record: Omit<AuthorizationCodeRecord, "expires_at">): Promise<string> {
    const code = randomToken(32);
    const full: AuthorizationCodeRecord = { ...record, expires_at: Date.now() + AUTH_CODE_TTL_SECONDS * 1000 };
    await this.codes.set(`code:${code}`, full, AUTH_CODE_TTL_SECONDS);
    return code;
  }

  /** Single-use: deletes the code as part of reading it. */
  async consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | null> {
    const key = `code:${code}`;
    const record = await this.codes.get<AuthorizationCodeRecord>(key);
    if (!record) return null;
    await this.codes.del(key);
    if (record.expires_at < Date.now()) return null;
    return record;
  }

  async issueAccessToken(record: {
    client_id: string;
    scope?: string;
    resource?: string;
  }): Promise<{ token: string; expiresIn: number }> {
    const token = randomToken(32);
    const full: AccessTokenRecord = { ...record, expires_at: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000 };
    await this.accessTokens.set(`access:${token}`, full, ACCESS_TOKEN_TTL_SECONDS);
    return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  async getAccessToken(token: string): Promise<AccessTokenRecord | null> {
    const record = await this.accessTokens.get<AccessTokenRecord>(`access:${token}`);
    if (!record) return null;
    if (record.expires_at < Date.now()) return null;
    return record;
  }

  async issueRefreshToken(record: RefreshTokenRecord): Promise<string> {
    const token = randomToken(32);
    await this.refreshTokens.set(`refresh:${token}`, record);
    return token;
  }

  async getRefreshToken(token: string): Promise<RefreshTokenRecord | null> {
    return this.refreshTokens.get<RefreshTokenRecord>(`refresh:${token}`);
  }
}

/** PKCE (RFC 7636) S256 verification: base64url(sha256(code_verifier)) === code_challenge. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return hash === codeChallenge;
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
