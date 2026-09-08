import { describe, expect, it } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { LinkedInAuthError, handleLinkedInApiError } from "../src/services/linkedin-client.js";

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

  it("points at product/scope on 403 and includes LinkedIn's detail", () => {
    const msg = handleLinkedInApiError(httpError(403, { message: "ACCESS_DENIED" }));
    expect(msg).toContain("Permission denied");
    expect(msg).toContain("ACCESS_DENIED");
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
