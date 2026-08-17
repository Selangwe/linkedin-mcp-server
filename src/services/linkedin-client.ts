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
} from "../types.js";
import type { ITokenStore } from "./token-store.js";

export interface LinkedInClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Thrown when there is no usable LinkedIn session; callers should surface a clear "run the OAuth setup" message. */
export class LinkedInAuthError extends Error {}

export function handleLinkedInApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError<{ message?: string; serviceErrorCode?: number }>;
    if (err.response) {
      const body = err.response.data;
      const detail = body?.message ? ` — ${body.message}` : "";
      switch (err.response.status) {
        case 401:
          return "Error: LinkedIn rejected the access token (expired or revoked). Re-run the OAuth setup via /oauth/linkedin/start.";
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

export class LinkedInClient {
  constructor(
    private readonly config: LinkedInClientConfig,
    private readonly store: ITokenStore
  ) {}

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
    const resp = await axios.post(
      `${LINKEDIN_AUTH_BASE}/accessToken`,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const tokens = this.toStoredTokens(resp.data);
    await this.store.save(tokens);
    return tokens;
  }

  private toStoredTokens(data: {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  }): StoredTokens {
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

  /** Returns a valid access token, refreshing it first if it's expired (or close to it). */
  async getValidAccessToken(): Promise<StoredTokens> {
    const tokens = await this.store.load();
    if (!tokens) {
      throw new LinkedInAuthError(
        "No LinkedIn session found. Visit /oauth/linkedin/start on this server and approve access first."
      );
    }

    const bufferMs = 60_000;
    if (tokens.access_token_expires_at - bufferMs > Date.now()) {
      return tokens;
    }

    if (!tokens.refresh_token) {
      throw new LinkedInAuthError(
        "LinkedIn access token expired and no refresh token is stored. Re-run the OAuth setup via /oauth/linkedin/start."
      );
    }

    const resp = await axios.post(
      `${LINKEDIN_AUTH_BASE}/accessToken`,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const refreshed = this.toStoredTokens(resp.data);
    // LinkedIn doesn't always return a new refresh_token; keep the old one if so.
    const merged: StoredTokens = {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
      refresh_token_expires_at:
        refreshed.refresh_token_expires_at ?? tokens.refresh_token_expires_at,
      member_id: tokens.member_id,
    };
    await this.store.save(merged);
    return merged;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const tokens = await this.getValidAccessToken();
    return {
      Authorization: `Bearer ${tokens.access_token}`,
      "LinkedIn-Version": LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    };
  }

  // ---------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------

  async getUserInfo(): Promise<LinkedInUserInfo> {
    const headers = await this.authHeaders();
    const resp = await axios.get<LinkedInUserInfo>(`${LINKEDIN_API_BASE}/v2/userinfo`, {
      headers,
      timeout: 15_000,
    });

    // Cache the member id alongside the tokens so future calls don't need this round trip.
    const tokens = await this.store.load();
    if (tokens) {
      await this.store.save({ ...tokens, member_id: resp.data.sub });
    }
    return resp.data;
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

  async uploadDocument(
    pdfBytes: Buffer,
    filename: string
  ): Promise<DocumentUploadResult> {
    const headers = await this.authHeaders();
    const memberUrn = await this.getMemberUrn();

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
    const headers = await this.authHeaders();
    const memberUrn = await this.getMemberUrn();

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
