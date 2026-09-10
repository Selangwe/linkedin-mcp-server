import type { IKeyValueStore } from "../services/kv-store.js";
import type { LinkedInAuth } from "../services/linkedin-auth.js";
import type { OutreachProvider } from "../providers/types.js";
import { CapabilityUnavailableError } from "../services/errors.js";
import type { CapabilityId, CapabilityInfo, CapabilityState } from "./types.js";

/**
 * What LinkedIn's documentation and access model say, before any live
 * evidence. Sourced from LinkedIn's developer docs, and the reason strings are
 * written to be relayed to a human verbatim — they are the answer to "why
 * can't it just send the DM?".
 */
const STATIC: Record<CapabilityId, Omit<CapabilityInfo, "id">> = {
  "profile.read": {
    state: "probable",
    provider: "official",
    reason: "The OpenID Connect userinfo endpoint is covered by the self-serve 'profile' scope.",
  },
  "post.create": {
    state: "probable",
    provider: "official",
    reason: "Posting is covered by w_member_social from the self-serve 'Share on LinkedIn' product.",
  },
  "post.document": {
    state: "probable",
    provider: "official",
    reason: "Document (carousel) posting is covered by w_member_social.",
  },
  "comment.write": {
    state: "unknown",
    provider: "official",
    reason:
      "POST /rest/socialActions/{urn}/comments lists w_member_social, which this app holds — but the endpoint is documented under the Community Management API and may additionally require that product. LinkedIn's docs do not settle it.",
    remedy:
      "Run linkedin_capabilities with probe='safe' to classify it without posting anything, or probe='live' against a post you own to settle it for certain.",
    fallback_tool: "linkedin_outreach_run",
  },
  "comment.read": {
    state: "gated",
    provider: "official",
    reason:
      "Reading comments needs the r_member_social permission, which LinkedIn has closed: 'access requests are not being accepted at this time'.",
    remedy:
      "There is no application route while the permission stays closed. Comment URNs have to come from a pasted LinkedIn permalink instead.",
    fallback_tool: "linkedin_comment_reply",
  },
  "analytics.member_post": {
    state: "gated",
    provider: "official",
    reason:
      "Member post analytics (/rest/memberCreatorPostAnalytics) need the r_member_postAnalytics scope, which is only granted through the Community Management API — available to 'registered legal organizations for commercial use cases only'.",
    remedy:
      "Apply for the Community Management API as a registered legal entity, then add r_member_postAnalytics to LINKEDIN_EXTRA_SCOPES and re-authorize.",
    fallback_tool: "linkedin_analytics_summary",
  },
  "message.send": {
    state: "unsupported",
    provider: "none",
    reason:
      "LinkedIn restricts the Messages API to approved partners, and the partner agreement additionally forbids automated or scheduled sends — a message must follow a specific member action.",
    remedy:
      "There is no self-serve route. Draft the message here and send it from LinkedIn, or configure an unofficial provider you host yourself.",
    fallback_tool: "linkedin_outreach_run",
  },
  "message.read": {
    state: "unsupported",
    provider: "none",
    reason: "Reading LinkedIn conversations is partner-gated in the same way as sending.",
    fallback_tool: "linkedin_outreach_due",
  },
  "people.search": {
    state: "unsupported",
    provider: "none",
    reason:
      "LinkedIn exposes no people-search endpoint at any access tier. The Connections API is restricted-access and first-degree only.",
    remedy:
      "Source prospects from a dedicated data provider and load them with linkedin_prospect_import.",
    fallback_tool: "linkedin_prospect_import",
  },
};

/** Scopes that, when granted, upgrade a capability from gated to probable. */
const SCOPE_REQUIREMENTS: Partial<Record<CapabilityId, string>> = {
  "analytics.member_post": "r_member_postAnalytics",
  "comment.read": "r_member_social",
};

/** How long a learned state is trusted before falling back to the static table. */
const TTL_SECONDS: Partial<Record<CapabilityState, number>> = {
  available: 30 * 24 * 3600,
  gated: 7 * 24 * 3600,
  probable: 7 * 24 * 3600,
};

interface CachedState {
  state: CapabilityState;
  evidence?: string;
  checked_at: number;
}

export const ALL_CAPABILITIES = Object.keys(STATIC) as CapabilityId[];

/**
 * Answers "can this server actually do X right now?" — combining LinkedIn's
 * documented access model, the scopes the token really holds, whatever a live
 * call last proved, and any configured provider.
 *
 * Ordered cheapest-first: the static table costs nothing, and only capabilities
 * with a cache entry or a scope requirement touch I/O.
 */
export class CapabilityRegistry {
  constructor(
    private readonly kv: IKeyValueStore,
    private readonly auth: LinkedInAuth,
    private readonly provider: OutreachProvider | null = null
  ) {}

  async get(id: CapabilityId): Promise<CapabilityInfo> {
    const base: CapabilityInfo = { id, ...STATIC[id] };

    // A provider that claims the capability outranks the official verdict,
    // because it reaches LinkedIn by a route the official table doesn't model.
    if (this.provider?.capabilities().includes(id)) {
      return {
        ...base,
        state: "probable",
        provider: "unofficial",
        reason: `Served by the '${this.provider.name}' provider, which is enabled. LinkedIn's own API does not offer this: ${base.reason}`,
        fallback_tool: undefined,
      };
    }

    // A capability with no official route stays unsupported whatever the cache
    // says — there is nothing a scope or a probe could change about it.
    if (base.state === "unsupported") {
      return process.env.LINKEDIN_UNOFFICIAL_PROVIDER
        ? base
        : { ...base, state: "unsupported", provider: "none" };
    }

    const cached = await this.readCache(id);
    if (cached) {
      return {
        ...base,
        state: cached.state,
        evidence: cached.evidence,
        checked_at: cached.checked_at,
        // A capability we have proof for doesn't need to advertise a fallback.
        fallback_tool: cached.state === "available" ? undefined : base.fallback_tool,
      };
    }

    const required = SCOPE_REQUIREMENTS[id];
    if (required) {
      const scopes = await this.auth.grantedScopes();
      if (scopes?.includes(required)) {
        return {
          ...base,
          state: "probable",
          reason: `The ${required} scope is granted on this token, so the endpoint should be reachable.`,
        };
      }
      if (scopes) {
        return { ...base, reason: `${base.reason} This token does not hold ${required}.` };
      }
    }

    return base;
  }

  async snapshot(): Promise<CapabilityInfo[]> {
    return Promise.all(ALL_CAPABILITIES.map((id) => this.get(id)));
  }

  /** Throws a CapabilityUnavailableError unless the capability is usable. */
  async require(id: CapabilityId): Promise<CapabilityInfo> {
    const info = await this.get(id);
    if (info.state === "available" || info.state === "probable" || info.state === "unknown") {
      return info;
    }
    const remedy = info.remedy ? ` ${info.remedy}` : "";
    throw new CapabilityUnavailableError(
      id,
      `${id} is not available. ${info.reason}${remedy}`,
      info.fallback_tool
    );
  }

  /**
   * Learns from a live call. Free accuracy: every real request tells us
   * something a probe would have had to ask for.
   *
   * Only 2xx and 403 are meaningful — a 404 says the entity was missing, a 429
   * says we were too fast, neither says anything about permission.
   */
  async observe(id: CapabilityId, status: number, evidence: string): Promise<void> {
    let state: CapabilityState | null = null;
    if (status >= 200 && status < 300) state = "available";
    else if (status === 403) state = "gated";
    if (!state) return;

    // Write only on a transition, so a hot path isn't also a write path.
    const cached = await this.readCache(id);
    if (cached?.state === state) return;

    await this.writeCache(id, { state, evidence, checked_at: Date.now() });
  }

  /** Records a probe result directly, where a live call isn't what produced it. */
  async record(id: CapabilityId, state: CapabilityState, evidence: string): Promise<void> {
    await this.writeCache(id, { state, evidence, checked_at: Date.now() });
  }

  async clear(id: CapabilityId): Promise<void> {
    await this.kv.del(this.key(id));
  }

  private key(id: CapabilityId): string {
    return `capabilities:${id}`;
  }

  private async readCache(id: CapabilityId): Promise<CachedState | null> {
    try {
      return await this.kv.get<CachedState>(this.key(id));
    } catch {
      // A capability lookup must never be the thing that fails a tool call.
      return null;
    }
  }

  private async writeCache(id: CapabilityId, value: CachedState): Promise<void> {
    try {
      await this.kv.set(this.key(id), value, TTL_SECONDS[value.state]);
    } catch {
      /* best-effort */
    }
  }
}
