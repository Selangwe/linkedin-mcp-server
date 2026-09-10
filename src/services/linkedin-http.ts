import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { LINKEDIN_API_BASE } from "../constants.js";
import type { CapabilityId } from "../capabilities/types.js";
import type { LinkedInAuth } from "./linkedin-auth.js";
import { isTransient } from "./linkedin-auth.js";

/**
 * Told about every response this client sees.
 *
 * Two jobs, both of which need to sit here because this is the only place that
 * sees raw statuses: teaching the capability registry what the token can
 * actually do, and letting the safety layer react to a 429 and count requests
 * against the daily ceiling.
 */
export interface ResponseObserver {
  /** A status worth attributing to a capability (2xx promotes, 403 demotes). */
  observe(id: CapabilityId, status: number, evidence: string): Promise<void>;
  /** Every response, capability-tagged or not. */
  onResponse?(status: number, retryAfterSeconds?: number): Promise<void>;
}

/** @deprecated Kept as an alias so existing imports keep compiling. */
export type CapabilityObserver = ResponseObserver;

export interface LinkedInRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path only, e.g. "/rest/posts" or "/v2/userinfo". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Whether re-running this request is harmless. Controls the 429/5xx retry
   * below, and defaults to `method === "GET"`.
   *
   * NEVER set this true on a write. LinkedIn can return a 5xx or a 429 *after*
   * having already processed the write, so a retry would duplicate the side
   * effect — publish the same post twice, send the same message twice.
   */
  idempotent?: boolean;
  /** The capability this call exercises, for observed-capability learning. */
  capability?: CapabilityId;
  /**
   * Send LinkedIn-Version + X-Restli-Protocol-Version. Defaults to true for
   * /rest/ paths; the legacy /v2/ endpoints are unversioned and reject them.
   */
  versioned?: boolean;
}

export interface LinkedInResult<T> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

interface RestliPage<T> {
  elements?: T[];
  paging?: { start?: number; count?: number; total?: number };
}

interface CursorPage<T> {
  elements?: T[];
  metadata?: { nextPageToken?: string };
  paging?: { pageToken?: string; nextPageToken?: string };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = [1_000, 3_000];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The single place LinkedIn HTTP calls are made. Owns base URL, version
 * headers, timeouts, the 401 re-auth retry, the (GET-only) 429/5xx retry, and
 * pagination — so a new endpoint is a few lines in a domain module rather than
 * another hand-rolled axios call with its own header spelling.
 */
export class LinkedInHttp {
  private readonly axios: AxiosInstance;

  private observer?: ResponseObserver;

  constructor(
    private readonly auth: LinkedInAuth,
    observer?: ResponseObserver
  ) {
    this.axios = axios.create({ baseURL: LINKEDIN_API_BASE });
    this.observer = observer;
  }

  /**
   * Attaches the observer after construction.
   *
   * Needed because the capability registry depends on this client's auth, so
   * the two cannot both be constructor arguments of each other. app.ts builds
   * the client, then the registry, then wires the observer back in here.
   */
  setObserver(observer: ResponseObserver): void {
    this.observer = observer;
  }

  async request<T = unknown>(req: LinkedInRequest): Promise<LinkedInResult<T>> {
    const versioned = req.versioned ?? req.path.startsWith("/rest/");
    const idempotent = req.idempotent ?? req.method === "GET";

    // withAuthRetry owns the 401 case: one forced refresh, one replay. It is
    // safe on writes precisely because a 401 means LinkedIn never acted.
    return this.auth.withAuthRetry(async (authHeaders) => {
      const headers: Record<string, string> = { ...authHeaders, ...req.headers };
      if (!versioned) {
        delete headers["LinkedIn-Version"];
        delete headers["X-Restli-Protocol-Version"];
      }
      if (req.body !== undefined && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }

      const config: AxiosRequestConfig = {
        method: req.method,
        url: req.path,
        headers,
        params: req.query,
        data: req.body,
        timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        validateStatus: (status) => status < 300,
      };

      return this.send<T>(config, idempotent, req.capability);
    });
  }

  /**
   * Issues the request, retrying transient failures only when the caller has
   * declared the request idempotent. The 401 path is handled a level up.
   */
  private async send<T>(
    config: AxiosRequestConfig,
    idempotent: boolean,
    capability?: CapabilityId
  ): Promise<LinkedInResult<T>> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= (idempotent ? RETRY_BACKOFF_MS.length : 0); attempt++) {
      try {
        const resp = await this.axios.request<T>(config);
        await this.noteResponse(resp.status);
        await this.note(capability, resp.status, `${config.method} ${config.url}`);
        return {
          data: resp.data,
          status: resp.status,
          headers: resp.headers as unknown as Record<string, string>,
        };
      } catch (error) {
        lastError = error;
        // A 401 must escape immediately so withAuthRetry can refresh and replay.
        if (axios.isAxiosError(error) && error.response?.status === 401) throw error;

        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status) {
          await this.noteResponse(status, retryAfterSeconds(error));
          await this.note(
            capability,
            status,
            `${config.method} ${config.url} → ${status}${detailOf(error)}`
          );
        }
        if (!idempotent || !isTransient(error) || attempt === RETRY_BACKOFF_MS.length) break;
        await delay(retryAfterMs(error) ?? RETRY_BACKOFF_MS[attempt]);
      }
    }

    throw lastError;
  }

  /** Capability learning is best-effort — a failed KV write must not fail the call. */
  private async note(id: CapabilityId | undefined, status: number, evidence: string): Promise<void> {
    if (!id || !this.observer) return;
    try {
      await this.observer.observe(id, status, evidence);
    } catch {
      /* ignore */
    }
  }

  /** Same best-effort contract: bookkeeping must never fail a real call. */
  private async noteResponse(status: number, retryAfter?: number): Promise<void> {
    if (!this.observer?.onResponse) return;
    try {
      await this.observer.onResponse(status, retryAfter);
    } catch {
      /* ignore */
    }
  }

  /**
   * Walks a classic rest.li `start`/`count` collection.
   *
   * GET-only, and `max` is mandatory: an unbounded loop inside a 60s Vercel
   * function is a timeout, not a feature.
   */
  async *paginateOffset<T>(
    req: Omit<LinkedInRequest, "method">,
    opts: { count?: number; max: number }
  ): AsyncGenerator<T> {
    const count = opts.count ?? 50;
    let start = 0;
    let yielded = 0;

    while (yielded < opts.max) {
      const page = await this.request<RestliPage<T>>({
        ...req,
        method: "GET",
        query: { ...req.query, start, count },
      });
      const elements = page.data.elements ?? [];
      // Trust an empty page over `paging.total`, which LinkedIn sometimes
      // omits and sometimes reports as an estimate.
      if (elements.length === 0) return;

      for (const element of elements) {
        yield element;
        if (++yielded >= opts.max) return;
      }

      if (elements.length < count) return;
      start += elements.length;
    }
  }

  /** Walks a newer `pageToken`/`nextPageToken` collection. Same bounds as above. */
  async *paginateCursor<T>(
    req: Omit<LinkedInRequest, "method">,
    opts: { count?: number; max: number }
  ): AsyncGenerator<T> {
    let pageToken: string | undefined;
    let yielded = 0;

    while (yielded < opts.max) {
      const page = await this.request<CursorPage<T>>({
        ...req,
        method: "GET",
        query: { ...req.query, count: opts.count, pageToken },
      });
      const elements = page.data.elements ?? [];
      if (elements.length === 0) return;

      for (const element of elements) {
        yield element;
        if (++yielded >= opts.max) return;
      }

      pageToken = page.data.metadata?.nextPageToken ?? page.data.paging?.nextPageToken;
      if (!pageToken) return;
    }
  }
}

/** Honour LinkedIn's Retry-After when it sends one, rather than guessing. */
function retryAfterMs(error: unknown): number | undefined {
  const seconds = retryAfterSeconds(error);
  return seconds === undefined ? undefined : Math.min(seconds, 30) * 1000;
}

function retryAfterSeconds(error: unknown): number | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const raw = error.response?.headers?.["retry-after"];
  if (!raw) return undefined;
  const seconds = Number.parseInt(String(raw), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function detailOf(error: unknown): string {
  if (!axios.isAxiosError(error)) return "";
  const message = (error.response?.data as { message?: string } | undefined)?.message;
  return message ? ` ${message}` : "";
}
