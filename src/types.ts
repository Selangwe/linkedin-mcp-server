export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms when access_token expires. */
  access_token_expires_at: number;
  /** Epoch ms when refresh_token expires (LinkedIn: ~1 year). */
  refresh_token_expires_at?: number;
  /** Cached LinkedIn member id (the `sub` claim), so we don't refetch it every call. */
  member_id?: string;
  /**
   * Scopes LinkedIn actually granted, from the token response or a later
   * introspection. Asking for a scope is not the same as receiving it, and
   * without this a missing one only ever shows up as an unexplained 403.
   */
  scopes?: string[];
  /** Epoch ms when `scopes` was last confirmed. */
  scope_checked_at?: number;
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
  /** Scopes the token actually holds. Absent on records stored before scopes were tracked. */
  scopes?: string[];
  /** Scopes this app asks for that LinkedIn did not grant — the usual cause of a 403. */
  missing_expected_scopes?: string[];
  /** True when the stored record predates scope tracking, so `scopes` says nothing. */
  scopes_unknown?: boolean;
  /** Set when the deadline is near, or when no refresh token was ever issued. */
  warning?: string;
  reauthorize_path: string;
}
