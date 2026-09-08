import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AxiosRequestConfig } from "axios";
import type { LinkedInAuth } from "../src/services/linkedin-auth.js";

/**
 * Swap only axios.create() for a fake instance. Everything else (AxiosError,
 * isAxiosError) stays real, because isTransient/isUnauthorized depend on it.
 */
let handler: (config: AxiosRequestConfig) => Promise<unknown>;
const calls: AxiosRequestConfig[] = [];

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  const fakeInstance = {
    request: (config: AxiosRequestConfig) => {
      calls.push(config);
      return handler(config);
    },
  };
  return {
    ...actual,
    default: Object.assign(Object.create(actual.default), actual.default, {
      create: () => fakeInstance,
    }),
  };
});

const { AxiosError } = await import("axios");
const { LinkedInHttp } = await import("../src/services/linkedin-http.js");

function httpError(status: number): InstanceType<typeof AxiosError> {
  const err = new AxiosError("failed", "ERR_BAD_RESPONSE");
  err.response = { status, statusText: "", data: {}, headers: {}, config: {} } as never;
  return err;
}

const ok = (data: unknown = {}) => Promise.resolve({ data, status: 200, headers: {} });

/** A stand-in for LinkedInAuth that hands out fixed headers and counts refreshes. */
function fakeAuth(): { auth: LinkedInAuth; forced: () => number } {
  let forced = 0;
  const auth = {
    async authHeaders(opts: { force?: boolean } = {}) {
      if (opts.force) forced++;
      return {
        Authorization: "Bearer t",
        "LinkedIn-Version": "202607",
        "X-Restli-Protocol-Version": "2.0.0",
      };
    },
    async withAuthRetry<T>(fn: (h: Record<string, string>) => Promise<T>): Promise<T> {
      try {
        return await fn(await this.authHeaders());
      } catch (error) {
        if (!(error instanceof AxiosError) || error.response?.status !== 401) throw error;
        return fn(await this.authHeaders({ force: true }));
      }
    },
  };
  return { auth: auth as unknown as LinkedInAuth, forced: () => forced };
}

beforeEach(() => {
  calls.length = 0;
  handler = () => ok();
});

describe("LinkedInHttp.request", () => {
  it("sends version headers for /rest/ paths", async () => {
    const http = new LinkedInHttp(fakeAuth().auth);
    await http.request({ method: "GET", path: "/rest/posts" });
    expect(calls[0].headers).toMatchObject({
      "LinkedIn-Version": "202607",
      "X-Restli-Protocol-Version": "2.0.0",
    });
  });

  it("strips version headers for legacy /v2/ paths, which reject them", async () => {
    const http = new LinkedInHttp(fakeAuth().auth);
    await http.request({ method: "GET", path: "/v2/userinfo" });
    expect(calls[0].headers).not.toHaveProperty("LinkedIn-Version");
    expect(calls[0].headers).not.toHaveProperty("X-Restli-Protocol-Version");
    expect(calls[0].headers).toMatchObject({ Authorization: "Bearer t" });
  });

  it("defaults a JSON content type when there is a body", async () => {
    const http = new LinkedInHttp(fakeAuth().auth);
    await http.request({ method: "POST", path: "/rest/posts", body: { a: 1 } });
    expect(calls[0].headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("retries a transient failure on GET", async () => {
    let n = 0;
    handler = () => (++n < 3 ? Promise.reject(httpError(503)) : ok({ done: true }));
    const http = new LinkedInHttp(fakeAuth().auth);
    const res = await http.request<{ done: boolean }>({ method: "GET", path: "/rest/posts" });
    expect(res.data.done).toBe(true);
    expect(n).toBe(3);
  });

  it("NEVER retries a write on 5xx — LinkedIn may already have processed it", async () => {
    let n = 0;
    handler = () => {
      n++;
      return Promise.reject(httpError(500));
    };
    const http = new LinkedInHttp(fakeAuth().auth);
    await expect(http.request({ method: "POST", path: "/rest/posts", body: {} })).rejects.toThrow();
    expect(n).toBe(1);
  });

  it("NEVER retries a write on 429 either", async () => {
    let n = 0;
    handler = () => {
      n++;
      return Promise.reject(httpError(429));
    };
    const http = new LinkedInHttp(fakeAuth().auth);
    await expect(http.request({ method: "POST", path: "/rest/posts", body: {} })).rejects.toThrow();
    expect(n).toBe(1);
  });

  it("lets a 401 escape so the auth layer can refresh and replay exactly once", async () => {
    let n = 0;
    handler = () => (++n === 1 ? Promise.reject(httpError(401)) : ok({ ok: true }));
    const { auth, forced } = fakeAuth();
    const http = new LinkedInHttp(auth);
    const res = await http.request<{ ok: boolean }>({ method: "POST", path: "/rest/posts", body: {} });
    expect(res.data.ok).toBe(true);
    expect(forced()).toBe(1);
    expect(n).toBe(2);
  });

  it("reports observed statuses to the capability observer", async () => {
    const seen: Array<{ id: string; status: number }> = [];
    const http = new LinkedInHttp(fakeAuth().auth, {
      async observe(id, status) {
        seen.push({ id, status });
      },
    });
    await http.request({ method: "GET", path: "/v2/userinfo", capability: "profile.read" });
    expect(seen).toEqual([{ id: "profile.read", status: 200 }]);
  });

  it("does not let a failing observer break the call", async () => {
    const http = new LinkedInHttp(fakeAuth().auth, {
      async observe() {
        throw new Error("kv is down");
      },
    });
    await expect(
      http.request({ method: "GET", path: "/v2/userinfo", capability: "profile.read" })
    ).resolves.toBeTruthy();
  });
});

describe("LinkedInHttp.paginateOffset", () => {
  it("walks pages and stops on a short page", async () => {
    handler = (config) => {
      const start = (config.params as { start: number }).start;
      if (start === 0) return ok({ elements: [1, 2] });
      return ok({ elements: [3] }); // short page => last page
    };
    const http = new LinkedInHttp(fakeAuth().auth);
    const seen: number[] = [];
    for await (const n of http.paginateOffset<number>({ path: "/rest/x" }, { count: 2, max: 100 })) {
      seen.push(n);
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it("stops at max even when more pages exist", async () => {
    handler = () => ok({ elements: [1, 2, 3, 4, 5] });
    const http = new LinkedInHttp(fakeAuth().auth);
    const seen: number[] = [];
    for await (const n of http.paginateOffset<number>({ path: "/rest/x" }, { count: 5, max: 3 })) {
      seen.push(n);
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it("stops on an empty page rather than trusting paging.total", async () => {
    let n = 0;
    handler = () => (++n === 1 ? ok({ elements: [1], paging: { total: 999 } }) : ok({ elements: [] }));
    const http = new LinkedInHttp(fakeAuth().auth);
    const seen: number[] = [];
    for await (const v of http.paginateOffset<number>({ path: "/rest/x" }, { count: 1, max: 50 })) {
      seen.push(v);
    }
    expect(seen).toEqual([1]);
  });
});
