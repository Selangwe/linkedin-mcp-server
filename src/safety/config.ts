import { envInt } from "../services/linkedin-auth.js";

/** Every action that touches LinkedIn on the member's behalf. */
export type SafetyAction =
  | "post.publish"
  | "comment.reply"
  | "message.send"
  | "connect.invite"
  | "probe.live";

export interface ActionSpec {
  action: SafetyAction;
  /** How much of the daily budget this consumes. Default 1. */
  cost?: number;
  /** Default true for everything outward-facing. */
  requiresConfirmation?: boolean;
}

/**
 * Deliberately low. These are tuned for the operator's main LinkedIn account,
 * where the downside of an over-eager loop is a restricted profile, not a
 * failed job. Raise them by env once a pattern has proven itself.
 */
const DEFAULT_CAPS: Record<SafetyAction, number> = {
  "message.send": 15,
  "comment.reply": 20,
  "connect.invite": 15,
  "post.publish": 3,
  "probe.live": 2,
};

const CAP_ENV: Record<SafetyAction, string> = {
  "message.send": "LINKEDIN_CAP_MESSAGE_SEND",
  "comment.reply": "LINKEDIN_CAP_COMMENT_REPLY",
  "connect.invite": "LINKEDIN_CAP_CONNECT_INVITE",
  "post.publish": "LINKEDIN_CAP_POST_PUBLISH",
  "probe.live": "LINKEDIN_CAP_PROBE_LIVE",
};

/** Actions paced by the minimum gap; a burst of these is what looks automated. */
const PACED: SafetyAction[] = ["message.send", "comment.reply", "connect.invite"];

export const safetyConfig = {
  capFor(action: SafetyAction): number {
    return envInt(CAP_ENV[action], DEFAULT_CAPS[action]);
  },
  totalCap(): number {
    return envInt("LINKEDIN_CAP_TOTAL", 40);
  },
  minGapSeconds(action: SafetyAction): number {
    return PACED.includes(action) ? envInt("LINKEDIN_MIN_ACTION_GAP_SECONDS", 90) : 0;
  },
  /**
   * Confirmation can be relaxed for publishing only. Sends, replies and
   * invites always confirm: those are the ones that reach another person, and
   * an over-eager agent loop is exactly what the rail exists to catch.
   */
  requiresConfirmation(action: SafetyAction): boolean {
    if (action === "post.publish" || action === "probe.live") {
      return (process.env.LINKEDIN_REQUIRE_CONFIRMATION ?? "true").toLowerCase() !== "false";
    }
    return true;
  },
  killSwitchFromEnv(): boolean {
    const raw = (process.env.LINKEDIN_KILL_SWITCH || "").toLowerCase();
    return raw === "1" || raw === "true" || raw === "on";
  },
  /** Ceiling on total LinkedIn requests per day; LinkedIn does not publish per-endpoint limits. */
  dailyRequestCeiling(): number {
    return envInt("LINKEDIN_DAILY_REQUEST_CEILING", 400);
  },
};
