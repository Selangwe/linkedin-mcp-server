import type { LinkedInUserInfo } from "../../types.js";
import type { LinkedInAuth } from "../linkedin-auth.js";
import type { LinkedInHttp } from "../linkedin-http.js";
import type { ITokenStore } from "../token-store.js";

/**
 * The OpenID Connect userinfo endpoint. Legacy /v2/, so unversioned — the
 * `versioned: false` below is load-bearing, not decoration.
 */
export async function getUserInfo(
  http: LinkedInHttp,
  auth: LinkedInAuth
): Promise<LinkedInUserInfo> {
  const resp = await http.request<LinkedInUserInfo>({
    method: "GET",
    path: "/v2/userinfo",
    versioned: false,
    capability: "profile.read",
  });

  // Cache the member id alongside the tokens so future calls don't need this round trip.
  await auth.persistMemberId(resp.data.sub);
  return resp.data;
}

export async function getMemberUrn(
  http: LinkedInHttp,
  auth: LinkedInAuth,
  store: ITokenStore
): Promise<string> {
  const tokens = await store.load();
  if (tokens?.member_id) return `urn:li:person:${tokens.member_id}`;
  const info = await getUserInfo(http, auth);
  return `urn:li:person:${info.sub}`;
}
