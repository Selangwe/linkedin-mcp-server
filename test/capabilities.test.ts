import { describe, expect, it } from "vitest";
import { CapabilityRegistry, ALL_CAPABILITIES } from "../src/capabilities/registry.js";
import { CapabilityUnavailableError } from "../src/services/errors.js";
import type { LinkedInAuth } from "../src/services/linkedin-auth.js";
import type { OutreachProvider } from "../src/providers/types.js";
import { MemoryKv } from "./helpers/memory-kv.js";

function authWithScopes(scopes?: string[]): LinkedInAuth {
  return { async grantedScopes() { return scopes; } } as unknown as LinkedInAuth;
}

function registry(opts: { scopes?: string[]; provider?: OutreachProvider | null } = {}) {
  return new CapabilityRegistry(new MemoryKv(), authWithScopes(opts.scopes), opts.provider ?? null);
}

describe("static verdicts", () => {
  it("reports messaging and people search as unsupported, with a usable reason", async () => {
    const reg = registry();
    for (const id of ["message.send", "message.read", "people.search"] as const) {
      const info = await reg.get(id);
      expect(info.state).toBe("unsupported");
      expect(info.reason.length).toBeGreaterThan(20);
    }
    expect((await reg.get("message.send")).reason).toContain("approved partners");
    expect((await reg.get("people.search")).fallback_tool).toBe("linkedin_prospect_import");
  });

  it("reports comment reading as gated on the closed permission", async () => {
    const info = await registry().get("comment.read");
    expect(info.state).toBe("gated");
    expect(info.reason).toContain("r_member_social");
  });

  it("leaves comment writing unknown until something proves it either way", async () => {
    const info = await registry({ scopes: ["w_member_social"] }).get("comment.write");
    // w_member_social is necessary but not known to be sufficient — the open
    // question is product gating, which a scope cannot answer.
    expect(info.state).toBe("unknown");
    expect(info.remedy).toContain("probe");
  });

  it("gates member analytics but names the exact missing scope", async () => {
    const info = await registry({ scopes: ["openid", "w_member_social"] }).get("analytics.member_post");
    expect(info.state).toBe("gated");
    expect(info.reason).toContain("r_member_postAnalytics");
  });

  it("upgrades analytics to probable once the scope is actually granted", async () => {
    const info = await registry({
      scopes: ["openid", "w_member_social", "r_member_postAnalytics"],
    }).get("analytics.member_post");
    expect(info.state).toBe("probable");
  });

  it("covers every declared capability in a snapshot", async () => {
    const snap = await registry().snapshot();
    expect(snap.map((c) => c.id).sort()).toEqual([...ALL_CAPABILITIES].sort());
  });
});

describe("observed learning", () => {
  it("promotes to available on a real 2xx and records the evidence", async () => {
    const reg = registry();
    await reg.observe("comment.write", 201, "POST /rest/socialActions/... → 201");
    const info = await reg.get("comment.write");
    expect(info.state).toBe("available");
    expect(info.evidence).toContain("201");
    // Proof means no fallback needs advertising.
    expect(info.fallback_tool).toBeUndefined();
  });

  it("demotes to gated on a 403", async () => {
    const reg = registry();
    await reg.observe("comment.write", 403, "ACCESS_DENIED");
    const info = await reg.get("comment.write");
    expect(info.state).toBe("gated");
    expect(info.fallback_tool).toBe("linkedin_outreach_run");
  });

  it("ignores statuses that say nothing about permission", async () => {
    const reg = registry();
    for (const status of [404, 429, 500, 422]) {
      await reg.observe("comment.write", status, "noise");
    }
    expect((await reg.get("comment.write")).state).toBe("unknown");
  });

  it("never lets live evidence resurrect a capability that has no API at all", async () => {
    const reg = registry();
    await reg.observe("message.send", 200, "impossible");
    expect((await reg.get("message.send")).state).toBe("unsupported");
  });
});

describe("provider override", () => {
  const provider: OutreachProvider = {
    name: "http",
    capabilities: () => ["message.send"],
  };

  it("makes a provider-served capability usable and marks it unofficial", async () => {
    const info = await registry({ provider }).get("message.send");
    expect(info.state).toBe("probable");
    expect(info.provider).toBe("unofficial");
    expect(info.reason).toContain("'http' provider");
  });

  it("leaves capabilities the provider does not claim alone", async () => {
    const info = await registry({ provider }).get("people.search");
    expect(info.state).toBe("unsupported");
    expect(info.provider).toBe("none");
  });
});

describe("require", () => {
  it("throws a capability error naming the fallback tool", async () => {
    await expect(registry().require("message.send")).rejects.toThrow(CapabilityUnavailableError);
    await registry()
      .require("message.send")
      .catch((e: CapabilityUnavailableError) => {
        expect(e.fallbackTool).toBe("linkedin_outreach_run");
        expect(e.capability).toBe("message.send");
      });
  });

  it("allows an unknown capability through, so an uncertain one can be tried", async () => {
    await expect(registry().require("comment.write")).resolves.toBeTruthy();
  });

  it("allows a provider-served capability through", async () => {
    const provider: OutreachProvider = { name: "http", capabilities: () => ["message.send"] };
    await expect(registry({ provider }).require("message.send")).resolves.toBeTruthy();
  });
});
