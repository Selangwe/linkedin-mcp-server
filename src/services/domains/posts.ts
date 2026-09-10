import type { CreatePostResult } from "../../types.js";
import type { LinkedInHttp } from "../linkedin-http.js";

export interface CreateDocumentPostParams {
  memberUrn: string;
  commentary: string;
  documentUrn: string;
  title: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
}

export async function createDocumentPost(
  http: LinkedInHttp,
  params: CreateDocumentPostParams
): Promise<CreatePostResult> {
  const resp = await http.request<{ id?: string }>({
    method: "POST",
    path: "/rest/posts",
    timeoutMs: 20_000,
    capability: "post.document",
    body: {
      author: params.memberUrn,
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
  });

  return toPostResult(resp.headers, resp.data);
}

export interface CreateTextPostParams {
  memberUrn: string;
  commentary: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
}

/** A plain text post — same endpoint, no `content` block. */
export async function createTextPost(
  http: LinkedInHttp,
  params: CreateTextPostParams
): Promise<CreatePostResult> {
  const resp = await http.request<{ id?: string }>({
    method: "POST",
    path: "/rest/posts",
    timeoutMs: 20_000,
    capability: "post.create",
    body: {
      author: params.memberUrn,
      commentary: params.commentary,
      visibility: params.visibility ?? "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    },
  });

  return toPostResult(resp.headers, resp.data);
}

function toPostResult(
  headers: Record<string, string>,
  data: { id?: string } | undefined
): CreatePostResult {
  // LinkedIn returns the created post's URN in the x-restli-id or x-linkedin-id response header.
  const postUrn: string = headers["x-restli-id"] ?? headers["x-linkedin-id"] ?? data?.id ?? "";
  const postId = postUrn.split(":").pop() ?? "";
  const postUrl = postId ? `https://www.linkedin.com/feed/update/${postUrn}/` : "";
  return { postUrn, postUrl };
}
