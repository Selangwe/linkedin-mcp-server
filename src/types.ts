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
