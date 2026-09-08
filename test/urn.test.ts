import { describe, expect, it } from "vitest";
import { parsePostUrn } from "../src/services/urn.js";

describe("parsePostUrn", () => {
  it("passes a bare URN straight through", () => {
    expect(parsePostUrn("urn:li:activity:7123456789")).toEqual({
      urn: "urn:li:activity:7123456789",
      kind: "activity",
    });
    expect(parsePostUrn("urn:li:ugcPost:7123").kind).toBe("ugcPost");
    expect(parsePostUrn("urn:li:share:7123").kind).toBe("share");
  });

  it("extracts the URN from a /feed/update/ permalink", () => {
    const parsed = parsePostUrn("https://www.linkedin.com/feed/update/urn:li:activity:7123456789/");
    expect(parsed).toEqual({ urn: "urn:li:activity:7123456789", kind: "activity" });
  });

  it("extracts the id from a /posts/ slug permalink", () => {
    const parsed = parsePostUrn(
      "https://www.linkedin.com/posts/some-person_a-slug-here-activity-7123456789-AbCd"
    );
    expect(parsed).toEqual({ urn: "urn:li:activity:7123456789", kind: "activity" });
  });

  it("prefers a comment URN over the post URN in the same link", () => {
    // Replying has to target the comment, not the post it sits on.
    const url =
      "https://www.linkedin.com/feed/update/urn:li:activity:7123456789/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7123456789%2C7999%29";
    const parsed = parsePostUrn(url);
    expect(parsed.kind).toBe("comment");
    expect(parsed.urn).toContain("urn:li:comment:(");
  });

  it("tolerates surrounding whitespace", () => {
    expect(parsePostUrn("  urn:li:activity:7123  ").urn).toBe("urn:li:activity:7123");
  });

  it("never passes a malformed URN through to LinkedIn", () => {
    // Junk appended to a valid URN is stripped back to the valid part rather
    // than forwarded. Not exploitable downstream either way — the only
    // consumer percent-encodes it — but the API should see a clean URN.
    expect(parsePostUrn("urn:li:share:0/../../admin").urn).toBe("urn:li:share:0");

    // Nothing salvageable is an error with a message that says what to paste.
    expect(() => parsePostUrn("urn:li:activity:notanumber")).toThrow(/Could not find/);
    expect(() => parsePostUrn("urn:li:share:")).toThrow(/Could not find/);
  });

  it("still accepts a well-formed compound comment URN", () => {
    const parsed = parsePostUrn("urn:li:comment:(activity:7123456789,7999)");
    expect(parsed.kind).toBe("comment");
    expect(parsed.urn).toBe("urn:li:comment:(activity:7123456789,7999)");
  });

  it("explains itself when there is no URN to find", () => {
    expect(() => parsePostUrn("https://www.linkedin.com/in/someone/")).toThrow(
      /Could not find a LinkedIn post or comment URN/
    );
    expect(() => parsePostUrn("nonsense")).toThrow(/Paste the full URL of the post/);
  });
});
