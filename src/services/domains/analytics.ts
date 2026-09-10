import type { LinkedInHttp } from "../linkedin-http.js";

export type MemberPostMetric =
  | "IMPRESSION"
  | "MEMBERS_REACHED"
  | "REACTION"
  | "COMMENT"
  | "RESHARE";

export interface MemberPostAnalytics {
  metric: MemberPostMetric;
  value: number;
  postUrn?: string;
}

interface AnalyticsElement {
  metricType?: string | { value?: string };
  metricValue?: number;
  value?: number;
  entity?: string;
}

const METRICS: MemberPostMetric[] = [
  "IMPRESSION",
  "MEMBERS_REACHED",
  "REACTION",
  "COMMENT",
  "RESHARE",
];

/**
 * Member post analytics, added in LinkedIn version 202506.
 *
 * Implemented but gated in practice: the r_member_postAnalytics scope comes
 * only through the Community Management API, which LinkedIn grants to
 * "registered legal organizations for commercial use cases only". The code is
 * here so that the day that scope is granted, adding it to
 * LINKEDIN_EXTRA_SCOPES and re-authorizing is the whole change.
 */
export async function getMemberPostAnalytics(
  http: LinkedInHttp,
  opts: { postUrn?: string } = {}
): Promise<MemberPostAnalytics[]> {
  const resp = await http.request<{ elements?: AnalyticsElement[] }>({
    method: "GET",
    path: "/rest/memberCreatorPostAnalytics",
    capability: "analytics.member_post",
    query: opts.postUrn
      ? { q: "entity", entity: opts.postUrn, metricTypes: METRICS.join(",") }
      : { q: "me", metricTypes: METRICS.join(",") },
  });

  return (resp.data.elements ?? []).map((element) => ({
    metric: normalizeMetric(element.metricType),
    value: element.metricValue ?? element.value ?? 0,
    postUrn: element.entity ?? opts.postUrn,
  }));
}

/** LinkedIn returns the metric name either bare or wrapped in a {value} object. */
function normalizeMetric(raw: AnalyticsElement["metricType"]): MemberPostMetric {
  const name = typeof raw === "string" ? raw : raw?.value;
  return (METRICS.find((m) => m === name) ?? "IMPRESSION") as MemberPostMetric;
}
