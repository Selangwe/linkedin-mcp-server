/**
 * What this server can actually do against LinkedIn right now.
 *
 * LinkedIn gates its API by *product* (approved on the app) as well as by
 * OAuth scope, and the two don't always coincide — a token can hold a scope
 * the endpoint still refuses. Capabilities model the union of both, plus the
 * cases where no API exists at any tier, so tools can say why something isn't
 * possible instead of surfacing a bare 403.
 */
export type CapabilityId =
  | "profile.read"
  | "post.create"
  | "post.document"
  | "comment.write"
  | "comment.read"
  | "analytics.member_post"
  | "message.send"
  | "message.read"
  | "people.search";

export type CapabilityState =
  /** Proven: a real 2xx was observed on this endpoint with this token. */
  | "available"
  /** Scope is present or a safe probe passed, but no successful call has been seen. */
  | "probable"
  /** The endpoint exists, but this app/token lacks the product or scope for it. */
  | "gated"
  /** No API for this at any tier available to a self-serve individual account. */
  | "unsupported"
  /** Only reachable through the unofficial provider, which is not enabled. */
  | "provider_only"
  /** Never checked. */
  | "unknown";

export interface CapabilityInfo {
  id: CapabilityId;
  state: CapabilityState;
  provider: "official" | "unofficial" | "none";
  /** Why it's in this state, phrased so a caller can relay it to a human. */
  reason: string;
  /** What a human could do about it, when there is something. */
  remedy?: string;
  /** What to use instead, right now. The field that stops callers improvising. */
  fallback_tool?: string;
  /** What we actually observed, e.g. "403 on POST /rest/socialActions/.../comments". */
  evidence?: string;
  /** Epoch ms of the last state change. */
  checked_at?: number;
}
