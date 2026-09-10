import axios from "axios";
import type { LinkedInHttp } from "../services/linkedin-http.js";
import type { LinkedInAuth } from "../services/linkedin-auth.js";
import type { CapabilityRegistry } from "./registry.js";
import type { CapabilityState } from "./types.js";

export interface ProbeOutcome {
  capability: string;
  state: CapabilityState;
  status?: number;
  evidence: string;
}

/**
 * A share URN that is syntactically valid but cannot exist, so a write aimed
 * at it can never create anything. Id 0 is not issued by LinkedIn.
 */
const NONEXISTENT_SHARE_URN = "urn:li:share:0";

/**
 * Settles whether this app may write comments, without posting one.
 *
 * The trick is ordering inside LinkedIn: a permission check happens before
 * entity resolution, so aiming a well-formed request at an entity that cannot
 * exist separates the two answers.
 *
 *   403          → refused on permission; the product/scope gate is real
 *   404/400/422  → got past permission and only then failed to find the share
 *
 * The known weakness: LinkedIn could answer 403 for an unresolvable entity
 * too. That is exactly why a pass here yields "probable" and never
 * "available" — only a real comment (probe='live') proves the write works.
 */
async function resolveMemberUrn(http: LinkedInHttp, auth: LinkedInAuth): Promise<string> {
  const tokens = await auth.getValidAccessToken();
  if (tokens.member_id) return `urn:li:person:${tokens.member_id}`;
  const info = await http.request<{ sub: string }>({
    method: "GET",
    path: "/v2/userinfo",
    versioned: false,
  });
  await auth.persistMemberId(info.data.sub);
  return `urn:li:person:${info.data.sub}`;
}

export async function probeCommentWrite(
  http: LinkedInHttp,
  auth: LinkedInAuth,
  registry: CapabilityRegistry
): Promise<ProbeOutcome> {
  // Must be a real URN. Sending `actor: undefined` makes LinkedIn answer 400
  // for the missing required field, which this probe would then read as
  // "permission passed, entity missing" — recording comment.write as probable
  // without permission ever having been evaluated.
  const memberUrn = await resolveMemberUrn(http, auth);

  try {
    await http.request({
      method: "POST",
      path: `/rest/socialActions/${encodeURIComponent(NONEXISTENT_SHARE_URN)}/comments`,
      body: {
        actor: memberUrn,
        object: NONEXISTENT_SHARE_URN,
        message: { text: "capability probe" },
      },
      // Not tagged with a capability: observe() would read a 404 as noise and a
      // 403 here is what we are classifying, so we record the verdict ourselves.
    });

    // Creating a comment on a share that cannot exist should be impossible.
    // If it somehow succeeds, treat it as inconclusive rather than proof.
    const evidence = "unexpected 2xx against a non-existent share";
    await registry.record("comment.write", "probable", evidence);
    return { capability: "comment.write", state: "probable", evidence };
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const detail = axios.isAxiosError(error)
      ? (error.response?.data as { message?: string } | undefined)?.message
      : undefined;
    const evidence = `POST /rest/socialActions/{nonexistent}/comments → ${status ?? "no response"}${
      detail ? ` (${detail})` : ""
    }`;

    if (status === 403) {
      await registry.record("comment.write", "gated", evidence);
      return { capability: "comment.write", state: "gated", status, evidence };
    }

    if (status === 404 || status === 400 || status === 422) {
      // Permission passed; only the entity was missing, which is the point.
      await registry.record("comment.write", "probable", evidence);
      return { capability: "comment.write", state: "probable", status, evidence };
    }

    // 401 is a token problem, 429/5xx are noise — neither answers the question.
    return { capability: "comment.write", state: "unknown", status, evidence };
  }
}
