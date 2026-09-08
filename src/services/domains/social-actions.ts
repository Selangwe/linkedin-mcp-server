import type { LinkedInHttp } from "../linkedin-http.js";

export interface CreateCommentParams {
  /** The share, ugcPost or comment URN being commented on. Replying targets a comment URN. */
  targetUrn: string;
  actorUrn: string;
  text: string;
}

export interface CreateCommentResult {
  commentUrn: string;
  targetUrn: string;
}

/**
 * Posts a comment, or — when targetUrn is itself a comment URN — a reply to
 * one. LinkedIn uses the same endpoint for both; the path parameter is what
 * decides.
 *
 * Whether a self-serve app may call this at all is the open question the
 * capability probe exists to answer: the permission table lists
 * w_member_social, but the endpoint is documented under Community Management
 * and may require that product too.
 */
export async function createComment(
  http: LinkedInHttp,
  params: CreateCommentParams
): Promise<CreateCommentResult> {
  const resp = await http.request<{ id?: string; $URN?: string }>({
    method: "POST",
    path: `/rest/socialActions/${encodeURIComponent(params.targetUrn)}/comments`,
    capability: "comment.write",
    timeoutMs: 20_000,
    body: {
      actor: params.actorUrn,
      object: params.targetUrn,
      message: { text: params.text },
    },
  });

  const commentUrn =
    resp.headers["x-restli-id"] ?? resp.data?.$URN ?? resp.data?.id ?? "";
  return { commentUrn, targetUrn: params.targetUrn };
}
