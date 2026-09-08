import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FileKeyValueStore } from "../src/services/kv-store.js";
import { verifyPkce, escapeHtml } from "../src/services/oauth-store.js";
import crypto from "crypto";

const dirs: string[] = [];

async function tmpStore(): Promise<FileKeyValueStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kv-test-"));
  dirs.push(dir);
  return new FileKeyValueStore(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("FileKeyValueStore", () => {
  it("round-trips a value and returns null for a missing key", async () => {
    const store = await tmpStore();
    expect(await store.get("nope")).toBeNull();
    await store.set("k", { hello: "world" });
    expect(await store.get("k")).toEqual({ hello: "world" });
  });

  it("treats an expired entry as absent", async () => {
    const store = await tmpStore();
    // A TTL in the past is the deterministic way to test expiry without sleeping.
    await store.set("k", "v", -1);
    expect(await store.get("k")).toBeNull();
  });

  it("keeps an entry that has not reached its TTL", async () => {
    const store = await tmpStore();
    await store.set("k", "v", 3600);
    expect(await store.get("k")).toBe("v");
  });

  it("deletes, and tolerates deleting a key that is not there", async () => {
    const store = await tmpStore();
    await store.set("k", "v");
    await store.del("k");
    expect(await store.get("k")).toBeNull();
    await expect(store.del("k")).resolves.toBeUndefined();
  });

  it("handles keys containing characters that are not filesystem-safe", async () => {
    const store = await tmpStore();
    const key = "client:../../etc/passwd?x=1";
    await store.set(key, "safe");
    expect(await store.get(key)).toBe("safe");
  });
});

describe("verifyPkce", () => {
  it("accepts a correct S256 challenge", () => {
    const verifier = "a-verifier-string-long-enough-for-pkce";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("rejects a mismatched verifier", () => {
    expect(verifyPkce("wrong", "definitely-not-the-hash")).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes every character that could break out of an attribute or element", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;"
    );
  });
});
