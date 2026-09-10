import { describe, expect, it } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import {
  LinkedInAuthError,
  CapabilityUnavailableError,
  handleLinkedInApiError,
} from "../src/services/linkedin-client.js";

/** Builds an AxiosError shaped the way axios actually delivers HTTP failures. */
function httpError(status: number, body?: unknown): AxiosError {
  const err = new AxiosError("Request failed", "ERR_BAD_RESPONSE");
  err.response = {
    status,
    statusText: "",
    data: body,
    headers: {},
    config: { headers: new AxiosHeaders() },
  } as AxiosError["response"];
  return err;
}

describe("handleLinkedInApiError", () => {
  it("passes our own auth errors through with their message intact", () => {
    const msg = handleLinkedInApiError(new LinkedInAuthError("token is gone"));
    expect(msg).toBe("Error: token is gone");
  });

  it("tells the caller to re-run OAuth on 401", () => {
    expect(handleLinkedInApiError(httpError(401))).toContain("/oauth/linkedin/start");
  });

  it("blames the missing product rather than the token on 403", () => {
    const msg = handleLinkedInApiError(httpError(403, { message: "ACCESS_DENIED" }));
    expect(msg).toContain("denied this request");
    expect(msg).toContain("ACCESS_DENIED");
    expect(msg).toContain("product or permission");
    expect(msg).toContain("linkedin_capabilities");
  });

  it("names the capability, granted scopes and fallback tool on 403 when given them", () => {
    const msg = handleLinkedInApiError(httpError(403), {
      capability: "comment.write",
      scopes: ["openid", "w_member_social"],
      fallbackTool: "linkedin_outreach_run",
    });
    expect(msg).toContain("comment.write");
    expect(msg).toContain("openid, w_member_social");
    expect(msg).toContain("linkedin_outreach_run");
  });

  it("surfaces a capability error's own message and fallback", () => {
    const err = new CapabilityUnavailableError(
      "message.send",
      "message.send is not available: LinkedIn restricts the Messages API to approved partners.",
      "linkedin_outreach_run"
    );
    const msg = handleLinkedInApiError(err);
    expect(msg).toContain("approved partners");
    expect(msg).toContain("Use linkedin_outreach_run instead.");
  });

  it("reports 404 and 422 distinctly", () => {
    expect(handleLinkedInApiError(httpError(404))).toContain("not found");
    expect(handleLinkedInApiError(httpError(422))).toContain("rejected the request payload");
  });

  it("tells the caller to wait on 429", () => {
    expect(handleLinkedInApiError(httpError(429))).toContain("rate limit");
  });

  it("falls back to the status code for unmapped statuses", () => {
    expect(handleLinkedInApiError(httpError(500))).toContain("500");
  });

  it("recognises a timeout", () => {
    const err = new AxiosError("timeout", "ECONNABORTED");
    expect(handleLinkedInApiError(err)).toContain("timed out");
  });

  it("degrades gracefully for a non-axios throw", () => {
    expect(handleLinkedInApiError(new Error("boom"))).toContain("boom");
    expect(handleLinkedInApiError("a bare string")).toContain("a bare string");
  });
});
