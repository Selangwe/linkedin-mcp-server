import axios, { AxiosError } from "axios";
import {
  LINKEDIN_API_BASE,
  LINKEDIN_AUTH_BASE,
  LINKEDIN_API_VERSION,
  LINKEDIN_SCOPES,
} from "../constants.js";
import type {
  StoredTokens,
  LinkedInUserInfo,
  DocumentUploadResult,
  CreatePostResult,
  AuthStatus,
} from "../types.js";
import type { ITokenStore } from "./token-store.js";

export interface LinkedInClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Thrown when there is no usable LinkedIn session; callers should surface a clear "run the OAuth setup" message. */
export class LinkedInAuthError extends Error {}

export const REAUTHORIZE_PATH = "/oauth/linkedin/start";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long before actual expiry we treat a token as already expired.
 *
 * This has to be longer than the longest single run, or a token that passes
 * the check at the start of a run can be dead by the end of it:
 * linkedin_post_carousel chains a 60s PDF download, a 60s upload and a 20s
 * publish. 10 minutes clears that with room to spare, and also clears the 60s
 * function ceiling in vercel.json.
 */
const DEFAULT_REFRESH_BUFFER_SECONDS = 600;

/** How close to the hard re-auth deadline before results start carrying a warning. */
const DEFAULT_WARN_DAYS = 14;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Network blips and LinkedIn-side faults are worth retrying; a 4xx is not. */
function isTransient(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (!error.response) return true; // timeout / DNS / connection reset
  return error.response.status >= 500 || error.response.status === 429;
}

function isUnauthorized(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401;
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function handleLinkedInApiError(error: unknown): string {
  // Our own auth errors already carry a precise, actionable message — don't
  // let them fall through to the generic "Unexpected error occurred" below.
  if (error instanceof LinkedInAuthError) return `Error: ${error.message}`;

  if (axios.isAxiosError(error)) {
    const err = error as AxiosError<{ message?: string; serviceErrorCode?: number }>;
    if (err.response) {
      const body = err.response.data;
      const detail = body?.message ? ` — ${body.message}` : "";
      switch (err.response.status) {
        case 401:
          return `Error: LinkedIn rejected the access token (expired or revoked) even after a refresh attempt. Re-run the OAuth setup via ${REAUTHORIZE_PATH}.`;
        case 403:
          return `Error: Permission denied by LinkedIn${detail}. Check that the app has the 'Share on LinkedIn' product and w_member_social scope.`;
        case 404:
          return `Error: LinkedIn resource not found${detail}.`;
        case 422:
          return `Error: LinkedIn rejected the request payload${detail}.`;
        case 429:
          return "Error: LinkedIn rate limit exceeded. Wait before retrying.";
        default:
          return `Error: LinkedIn API request failed with status ${err.response.status}${detail}`;
      }
    }
    if (err.code === "ECONNABORTED") return "Error: Request to LinkedIn timed out. Please retry.";
  }
  return `Error: Unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`;
}

interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export class LinkedInClient {
  constructor(
    private readonly config: LinkedInClientConfig,
    private readonly store: ITokenStore
  ) {}

  /**
   * The in-progress refresh, if any. Parallel tool calls (and the two legs of
   * linkedin_post_carousel) share it rather than each firing their own POST:
   * when LinkedIn rotates the refresh token, racing refreshes leave all but
   * one caller holding a token that has already been spent.
   */
  private refreshInFlight: Promise<StoredTokens> | null = null;

  /**
   * Serializes every read-modify-write of the token record, so a slow write
   * can't overwrite a newer one. Note this is an *in-process* guard: on Vercel
   * two concurrent invocations are separate processes and don't share it. For
   * a single-user, single-operator server that's the right trade — real
   * cross-process safety would mean a Lua script or WATCH loop in KvTokenStore
   * for no practical gain.
   */
  private mutations: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(fn, fn);
    this.mutations = next.catch(() => undefined);
    return next;
  }

  // ---------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------

  buildAuthorizationUrl(state: string): string {
    const url = new URL(`${LINKEDIN_AUTH_BASE}/authorization`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", LINKEDIN_SCOPES.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCodeForTokens(code: string): Promise<StoredTokens> {
    const resp = await axios.post<LinkedInTokenResponse>(
      `${LINKEDIN_AUTH_BASE}/accessToken`,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15_000 }
    );
    const tokens = this.toStoredTokens(resp.data);
    await this.serialize(() => this.store.save(tokens));
    return tokens;
  }

  private toStoredTokens(data: LinkedInTokenResponse): StoredTokens {
    const now = Date.now();
    return {
      access_token: data.access_token,
      access_token_expires_at: now + data.expires_in * 1000,
      refresh_token: data.refresh_token,
      refresh_token_expires_at: data.refresh_token_expires_in
        ? now + data.refresh_token_expires_in * 1000
        : undefined,
    };
  }

  /**
   * Returns a valid access token, refreshing first if it's expired or close to
   * it. Pass `force` to refresh unconditionally (used by the 401 retry path).
   */
  async getValidAccessToken(opts: { force?: boolean } = {}): Promise<StoredTokens> {
    const tokens = await this.store.load();
    if (!tokens) {
      throw new LinkedInAuthError(
        `No LinkedIn session found. Visit ${REAUTHORIZE_PATH} on this server and approve access first.`
      );
    }

    const bufferMs =
      envInt("LINKEDIN_TOKEN_REFRESH_BUFFER_SECONDS", DEFAULT_REFRESH_BUFFER_SECONDS) * 1000;
    if (!opts.force && tokens.access_token_expires_at - bufferMs > Date.now()) {
      return tokens;
    }

    if (!tokens.refresh_token) {
      const expiry = tokens.access_token_expires_at;
      const when = expiry <= Date.now() ? `expired on ${formatDate(expiry)}` : `expires on ${formatDate(expiry)}`;
      throw new LinkedInAuthError(
        `The LinkedIn access token ${when} and no refresh token was issued for this session, ` +
          `so it cannot be renewed automatically. Re-run the OAuth setup via ${REAUTHORIZE_PATH}.`
      );
    }

    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(tokens).finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async refresh(existing: StoredTokens): Promise<StoredTokens> {
    const data = await this.postRefresh(existing.refresh_token as string);
    const refreshed = this.toStoredTokens(data);

    return this.serialize(async () => {
      // Re-read inside the lock: another leg of this run may have written
      // since we started the (network-bound) refresh above.
      const current = (await this.store.load()) ?? existing;
      // LinkedIn doesn't always return a new refresh_token; keep the old one if so.
      const merged: StoredTokens = {
        ...refreshed,
        refresh_token: refreshed.refresh_token ?? current.refresh_token ?? existing.refresh_token,
        refresh_token_expires_at:
          refreshed.refresh_token_expires_at ??
          current.refresh_token_expires_at ??
          existing.refresh_token_expires_at,
        member_id: current.member_id ?? existing.member_id,
      };
      await this.store.save(merged);
      return merged;
    });
  }

  /** POSTs the refresh grant, retrying transient failures so a blip doesn't end a run. */
  private async postRefresh(refreshToken: string): Promise<LinkedInTokenResponse> {
    const backoffMs = [500, 1500];
    let lastError: unknown;

    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      try {
        const resp = await axios.post<LinkedInTokenResponse>(
          `${LINKEDIN_AUTH_BASE}/accessToken`,
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
          }),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15_000 }
        );
        return resp.data;
      } catch (error) {
        lastError = error;
        if (!isTransient(error) || attempt === backoffMs.length) break;
        await delay(backoffMs[attempt]);
      }
    }

    throw this.toRefreshError(lastError);
  }

  /**
   * A 4xx from the refresh grant means the refresh token itself is dead — say
   * so, and point at the fix. Anything else (timeout, 5xx) is transient and
   * re-authorizing wouldn't help, so the original error is rethrown for
   * handleLinkedInApiError to describe accurately.
   */
  private toRefreshError(error: unknown): unknown {
    if (axios.isAxiosError(error) && error.response && error.response.status < 500) {
      const body = error.response.data as { error?: string; error_description?: string } | undefined;
      const detail = [body?.error, body?.error_description].filter(Boolean).join(": ");
      return new LinkedInAuthError(
        `LinkedIn refused to refresh the access token${detail ? ` (${detail})` : ""}. ` +
          `The refresh token is expired or was revoked — visit ${REAUTHORIZE_PATH} on this server to reconnect.`
      );
    }
    return error;
  }

  private async authHeaders(opts: { force?: boolean } = {}): Promise<Record<string, string>> {
    const tokens = await this.getValidAccessToken(opts);
    return {
      Authorization: `Bearer ${tokens.access_token}`,
      "LinkedIn-Version": LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    };
  }

  /**
   * Runs an API call with fresh auth headers and, if LinkedIn answers 401,
   * forces a refresh and runs it exactly once more.
   *
   * The retry is scoped to 401 deliberately, and must stay that way: a 401
   * means LinkedIn rejected the credential without acting on the request, so
   * re-running the call cannot duplicate a side effect. A 5xx, a 429 or a
   * timeout can all be returned *after* LinkedIn has already processed a
   * write, so retrying those would risk publishing the same post twice.
   */
  private async withAuthRetry<T>(fn: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.authHeaders());
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      return fn(await this.authHeaders({ force: true }));
    }
  }

  /** Caches the member id next to the tokens without clobbering a concurrent refresh. */
  private async persistMemberId(memberId: string): Promise<void> {
    await this.serialize(async () => {
      const current = await this.store.load();
      if (!current || current.member_id === memberId) return;
      await this.store.save({ ...current, member_id: memberId });
    });
  }

  // ---------------------------------------------------------------------
  // Session health
  // ---------------------------------------------------------------------

  /**
   * Reports how much life the stored session has left. Computed entirely from
   * the stored record — no LinkedIn API call — so it's cheap enough to consult
   * on every tool result.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const tokens = await this.store.load();
    if (!tokens) {
      return {
        connected: false,
        has_refresh_token: false,
        reauthorize_path: REAUTHORIZE_PATH,
        warning: `No LinkedIn session is stored. Visit ${REAUTHORIZE_PATH} on this server to connect an account.`,
      };
    }

    const now = Date.now();
    const hasRefreshToken = Boolean(tokens.refresh_token);
    // Without a refresh token, the access token's own expiry is the hard stop.
    const hardDeadlineAt = hasRefreshToken
      ? tokens.refresh_token_expires_at
      : tokens.access_token_expires_at;
    const daysUntil = (at: number) => Math.floor((at - now) / DAY_MS);

    const status: AuthStatus = {
      connected: true,
      member_id: tokens.member_id,
      access_token_expires_at: tokens.access_token_expires_at,
      access_token_expires_in_days: daysUntil(tokens.access_token_expires_at),
      has_refresh_token: hasRefreshToken,
      refresh_token_expires_at: tokens.refresh_token_expires_at,
      hard_deadline_at: hardDeadlineAt,
      hard_deadline_in_days: hardDeadlineAt === undefined ? undefined : daysUntil(hardDeadlineAt),
      reauthorize_path: REAUTHORIZE_PATH,
    };

    const warnDays = envInt("LINKEDIN_AUTH_WARN_DAYS", DEFAULT_WARN_DAYS);

    if (!hasRefreshToken) {
      status.warning =
        tokens.access_token_expires_at <= now
          ? `The LinkedIn access token expired on ${formatDate(tokens.access_token_expires_at)} and no refresh token was issued for this session. Reconnect at ${REAUTHORIZE_PATH}.`
          : `LinkedIn issued no refresh token for this session, so it cannot be renewed automatically. Posting stops working on ${formatDate(tokens.access_token_expires_at)} (${status.access_token_expires_in_days} days). Reconnect at ${REAUTHORIZE_PATH} before then, and check whether the LinkedIn app is approved for programmatic refresh.`;
    } else if (hardDeadlineAt !== undefined && daysUntil(hardDeadlineAt) <= warnDays) {
      status.warning =
        hardDeadlineAt <= now
          ? `The LinkedIn refresh token expired on ${formatDate(hardDeadlineAt)}. Reconnect at ${REAUTHORIZE_PATH}.`
          : `LinkedIn authorization expires on ${formatDate(hardDeadlineAt)} (${daysUntil(hardDeadlineAt)} days) and cannot be extended automatically. Re-run ${REAUTHORIZE_PATH} to avoid an interruption.`;
    }

    return status;
  }

  // ---------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------

  async getUserInfo(): Promise<LinkedInUserInfo> {
    const info = await this.withAuthRetry(async (headers) => {
      const resp = await axios.get<LinkedInUserInfo>(`${LINKEDIN_API_BASE}/v2/userinfo`, {
        headers,
        timeout: 15_000,
      });
      return resp.data;
    });

    // Cache the member id alongside the tokens so future calls don't need this round trip.
    await this.persistMemberId(info.sub);
    return info;
  }

  async getMemberUrn(): Promise<string> {
    const tokens = await this.store.load();
    if (tokens?.member_id) return `urn:li:person:${tokens.member_id}`;
    const info = await this.getUserInfo();
    return `urn:li:person:${info.sub}`;
  }

  // ---------------------------------------------------------------------
  // Documents (used for LinkedIn's swipeable "carousel" — a PDF asset)
  // ---------------------------------------------------------------------

  async uploadDocument(pdfBytes: Buffer, filename: string): Promise<DocumentUploadResult> {
    const memberUrn = await this.getMemberUrn();

    // Both legs run under one withAuthRetry: on a 401 the whole upload is
    // redone, which just initializes a fresh document. The abandoned one is an
    // orphaned asset LinkedIn never sees referenced.
    return this.withAuthRetry(async (headers) => {
      const initResp = await axios.post(
        `${LINKEDIN_API_BASE}/rest/documents?action=initializeUpload`,
        {
          initializeUploadRequest: {
            owner: memberUrn,
          },
        },
        { headers: { ...headers, "Content-Type": "application/json" }, timeout: 15_000 }
      );

      const uploadUrl: string = initResp.data.value.uploadUrl;
      const documentUrn: string = initResp.data.value.document;

      await axios.put(uploadUrl, pdfBytes, {
        headers: {
          Authorization: headers.Authorization,
          "Content-Type": "application/pdf",
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 60_000,
      });

      return { documentUrn, uploadUrl };
    });
  }

  // ---------------------------------------------------------------------
  // Posts
  // ---------------------------------------------------------------------

  async createDocumentPost(params: {
    commentary: string;
    documentUrn: string;
    title: string;
    visibility?: "PUBLIC" | "CONNECTIONS";
  }): Promise<CreatePostResult> {
    const memberUrn = await this.getMemberUrn();

    return this.withAuthRetry(async (headers) => {
      const resp = await axios.post(
        `${LINKEDIN_API_BASE}/rest/posts`,
        {
          author: memberUrn,
          commentary: params.commentary,
          visibility: params.visibility ?? "PUBLIC",
          distribution: {
            feedDistribution: "MAIN_FEED",
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          content: {
            media: {
              title: params.title,
              id: params.documentUrn,
            },
          },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        },
        {
          headers: { ...headers, "Content-Type": "application/json" },
          timeout: 20_000,
          validateStatus: (status) => status < 300,
        }
      );

      // LinkedIn returns the created post's URN in the x-restli-id or x-linkedin-id response header.
      const postUrn: string =
        resp.headers["x-restli-id"] ?? resp.headers["x-linkedin-id"] ?? resp.data?.id ?? "";
      const postId = postUrn.split(":").pop() ?? "";
      const postUrl = postId ? `https://www.linkedin.com/feed/update/${postUrn}/` : "";

      return { postUrn, postUrl };
    });
  }

  // ---------------------------------------------------------------------
  // Helper: download an externally-hosted PDF (e.g. a Gamma export URL)
  // ---------------------------------------------------------------------

  static async downloadPdf(url: string): Promise<Buffer> {
    const resp = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 60_000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return Buffer.from(resp.data);
  }
}
