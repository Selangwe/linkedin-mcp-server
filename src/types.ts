export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms when access_token expires. */
  access_token_expires_at: number;
  /** Epoch ms when refresh_token expires (LinkedIn: ~1 year). */
  refresh_token_expires_at?: number;
  /** Cached LinkedIn member id (the `sub` claim), so we don't refetch it every call. */
  member_id?: string;
}

export interface LinkedInUserInfo {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
}

export interface DocumentUploadResult {
  documentUrn: string;
  uploadUrl: string;
}

export interface CreatePostResult {
  postUrn: string;
  postUrl: string;
}

/**
 * Snapshot of the stored LinkedIn session's health. Computed purely from the
 * persisted token record — no LinkedIn API call — so it's cheap enough to
 * consult on every tool result.
 */
export interface AuthStatus {
  connected: boolean;
  member_id?: string;
  /** Epoch ms. */
  access_token_expires_at?: number;
  access_token_expires_in_days?: number;
  /** False means there is a hard stop at access_token_expires_at with no way to renew automatically. */
  has_refresh_token: boolean;
  /** Epoch ms. */
  refresh_token_expires_at?: number;
  /**
   * Epoch ms after which a HUMAN must re-run the OAuth flow: the refresh
   * token's expiry when one exists, otherwise the access token's. This is the
   * date the server stops working on its own.
   */
  hard_deadline_at?: number;
  hard_deadline_in_days?: number;
  /** Set when the deadline is near, or when no refresh token was ever issued. */
  warning?: string;
  reauthorize_path: string;
}
