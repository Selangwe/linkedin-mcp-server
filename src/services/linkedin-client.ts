import axios from "axios";
import type {
  StoredTokens,
  LinkedInUserInfo,
  DocumentUploadResult,
  CreatePostResult,
  AuthStatus,
} from "../types.js";
import type { ITokenStore } from "./token-store.js";
import { LinkedInAuth, type LinkedInClientConfig } from "./linkedin-auth.js";
import { LinkedInHttp, type CapabilityObserver } from "./linkedin-http.js";
import { getUserInfo, getMemberUrn } from "./domains/profile.js";
import { uploadDocument } from "./domains/documents.js";
import { createDocumentPost } from "./domains/posts.js";

// Re-exported so existing importers of this module keep working. The
// definitions live in errors.ts / linkedin-auth.ts now.
export { LinkedInAuthError, CapabilityUnavailableError, SafetyBlockedError, REAUTHORIZE_PATH, handleLinkedInApiError } from "./errors.js";
export type { LinkedInClientConfig } from "./linkedin-auth.js";

/**
 * A thin facade over the auth, HTTP and domain modules.
 *
 * It exists so callers have one object to hold, and so the split from a single
 * 500-line class stayed behaviour-preserving: every method below has the same
 * name and signature it had before. New code can reach past it via `.auth` and
 * `.http` rather than growing this surface.
 */
export class LinkedInClient {
  readonly auth: LinkedInAuth;
  readonly http: LinkedInHttp;

  constructor(
    config: LinkedInClientConfig,
    private readonly store: ITokenStore,
    observer?: CapabilityObserver
  ) {
    this.auth = new LinkedInAuth(config, store);
    this.http = new LinkedInHttp(this.auth, observer);
  }

  // --- OAuth / session -------------------------------------------------

  buildAuthorizationUrl(state: string): string {
    return this.auth.buildAuthorizationUrl(state);
  }

  exchangeCodeForTokens(code: string): Promise<StoredTokens> {
    return this.auth.exchangeCodeForTokens(code);
  }

  getValidAccessToken(opts: { force?: boolean } = {}): Promise<StoredTokens> {
    return this.auth.getValidAccessToken(opts);
  }

  getAuthStatus(): Promise<AuthStatus> {
    return this.auth.getAuthStatus();
  }

  // --- Profile ---------------------------------------------------------

  getUserInfo(): Promise<LinkedInUserInfo> {
    return getUserInfo(this.http, this.auth);
  }

  getMemberUrn(): Promise<string> {
    return getMemberUrn(this.http, this.auth, this.store);
  }

  // --- Documents & posts -----------------------------------------------

  async uploadDocument(pdfBytes: Buffer, _filename: string): Promise<DocumentUploadResult> {
    // _filename is unused — LinkedIn takes the display title from the post,
    // not the asset. Kept in the signature for callers that already pass it.
    const memberUrn = await this.getMemberUrn();
    return uploadDocument(this.http, this.auth, memberUrn, pdfBytes);
  }

  async createDocumentPost(params: {
    commentary: string;
    documentUrn: string;
    title: string;
    visibility?: "PUBLIC" | "CONNECTIONS";
  }): Promise<CreatePostResult> {
    const memberUrn = await this.getMemberUrn();
    return createDocumentPost(this.http, { ...params, memberUrn });
  }

  // --- Helper: download an externally-hosted PDF (e.g. a Gamma export URL) ---

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
