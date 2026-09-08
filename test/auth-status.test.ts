import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { LinkedInClient, REAUTHORIZE_PATH } from "../src/services/linkedin-client.js";
import type { ITokenStore } from "../src/services/token-store.js";
import type { StoredTokens } from "../src/types.js";

const DAY_MS = 86_400_000;

/**
 * n days from now, plus a minute. The minute matters: getAuthStatus floors the
 * remaining duration, so an exact multiple of DAY_MS reads back as n-1 once a
 * millisecond has elapsed between constructing the fixture and asserting.
 */
const inDays = (n: number) => Date.now() + n * DAY_MS + 60_000;

/** In-memory ITokenStore so these tests never touch disk or Redis. */
class FakeTokenStore implements ITokenStore {
  constructor(private tokens: StoredTokens | null = null) {}
  async load() {
    return this.tokens;
  }
  async save(tokens: StoredTokens) {
    this.tokens = tokens;
  }
  async clear() {
    this.tokens = null;
  }
}

function clientWith(tokens: StoredTokens | null): LinkedInClient {
  return new LinkedInClient(
    { clientId: "id", clientSecret: "secret", redirectUri: "https://example.test/cb" },
    new FakeTokenStore(tokens)
  );
}

describe("getAuthStatus", () => {
  const originalWarnDays = process.env.LINKEDIN_AUTH_WARN_DAYS;

  beforeEach(() => {
    delete process.env.LINKEDIN_AUTH_WARN_DAYS;
  });

  afterEach(() => {
    if (originalWarnDays === undefined) delete process.env.LINKEDIN_AUTH_WARN_DAYS;
    else process.env.LINKEDIN_AUTH_WARN_DAYS = originalWarnDays;
  });

  it("reports disconnected when no token record is stored", async () => {
    const status = await clientWith(null).getAuthStatus();
    expect(status.connected).toBe(false);
    expect(status.has_refresh_token).toBe(false);
    expect(status.reauthorize_path).toBe(REAUTHORIZE_PATH);
    expect(status.warning).toContain("No LinkedIn session is stored");
  });

  it("treats the access token expiry as the hard deadline when no refresh token exists", async () => {
    const expiresAt = inDays(37);
    const status = await clientWith({
      access_token: "at",
      access_token_expires_at: expiresAt,
      member_id: "abc",
    }).getAuthStatus();

    expect(status.connected).toBe(true);
    expect(status.member_id).toBe("abc");
    expect(status.has_refresh_token).toBe(false);
    expect(status.hard_deadline_at).toBe(expiresAt);
    expect(status.hard_deadline_in_days).toBe(37);
    // No refresh token always warns, however far away the deadline is.
    expect(status.warning).toContain("no refresh token");
  });

  it("warns in the past tense once an unrenewable access token has expired", async () => {
    const status = await clientWith({
      access_token: "at",
      access_token_expires_at: Date.now() - DAY_MS,
    }).getAuthStatus();

    expect(status.warning).toContain("expired on");
    expect(status.access_token_expires_in_days).toBeLessThan(0);
  });

  it("stays silent when a refresh token puts the deadline beyond the warning window", async () => {
    const status = await clientWith({
      access_token: "at",
      refresh_token: "rt",
      access_token_expires_at: inDays(30),
      refresh_token_expires_at: inDays(300),
    }).getAuthStatus();

    expect(status.has_refresh_token).toBe(true);
    expect(status.hard_deadline_in_days).toBe(300);
    expect(status.warning).toBeUndefined();
  });

  it("warns once the refresh token deadline falls inside the warning window", async () => {
    const status = await clientWith({
      access_token: "at",
      refresh_token: "rt",
      access_token_expires_at: inDays(1),
      refresh_token_expires_at: inDays(5),
    }).getAuthStatus();

    expect(status.warning).toContain("cannot be extended automatically");
    expect(status.warning).toContain(REAUTHORIZE_PATH);
  });

  it("honours LINKEDIN_AUTH_WARN_DAYS", async () => {
    const tokens: StoredTokens = {
      access_token: "at",
      refresh_token: "rt",
      access_token_expires_at: inDays(1),
      refresh_token_expires_at: inDays(20),
    };

    // 20 days out is quiet under the default 14-day window...
    expect((await clientWith(tokens).getAuthStatus()).warning).toBeUndefined();

    // ...and noisy once the window is widened past it.
    process.env.LINKEDIN_AUTH_WARN_DAYS = "30";
    expect((await clientWith(tokens).getAuthStatus()).warning).toContain("expires on");
  });
});
