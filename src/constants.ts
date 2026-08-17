export const LINKEDIN_API_BASE = "https://api.linkedin.com";
export const LINKEDIN_AUTH_BASE = "https://www.linkedin.com/oauth/v2";

// LinkedIn versions its REST API by calendar month. Bump this periodically —
// see https://learn.microsoft.com/en-us/linkedin/marketing/versioning
export const LINKEDIN_API_VERSION = "202506";

// Scopes needed for personal-profile organic posting via "Share on LinkedIn".
export const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"];

export const CHARACTER_LIMIT = 25000;
