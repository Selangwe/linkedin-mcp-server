import crypto from "crypto";
import type { IKeyValueStore } from "../services/kv-store.js";
import { AuditLog, canonical } from "./audit.js";
import { safetyConfig, type ActionSpec, type SafetyAction } from "./config.js";

export interface KillSwitchState {
  on: boolean;
  reason?: string;
  set_at: number;
}

export type GuardVerdict =
  | { ok: true }
  | {
      ok: false;
      kind: "kill_switch" | "cap" | "throttle" | "cooldown" | "needs_confirmation";
      message: string;
      confirm_token?: string;
      preview?: unknown;
      next_allowed_at?: number;
    };

interface ConfirmRecord {
  action: SafetyAction;
  digest: string;
  created_at: number;
}

const CONFIRM_TTL_SECONDS = 15 * 60;
const COUNTER_TTL_SECONDS = 48 * 3600;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The rails every outward-facing action passes through.
 *
 * These live in the tool layer rather than inside LinkedInClient on purpose:
 * the unofficial provider does not go through LinkedInHttp at all, so a rail
 * enforced down in the HTTP client would be bypassed the moment a provider is
 * enabled. Here, one wrapper covers both routes.
 */
export class SafetyGuard {
  readonly audit: AuditLog;

  constructor(private readonly kv: IKeyValueStore) {
    this.audit = new AuditLog(kv);
  }

  /**
   * Decides whether an action may proceed. Order matters: the kill switch
   * outranks everything, and confirmation is checked last so a caller isn't
   * asked to confirm something a cap would refuse anyway.
   */
  async check(spec: ActionSpec, payload: unknown, confirmToken?: string): Promise<GuardVerdict> {
    const kill = await this.killSwitch();
    if (kill.on) {
      return {
        ok: false,
        kind: "kill_switch",
        message: `The LinkedIn kill switch is ON${kill.reason ? ` (${kill.reason})` : ""}. No outward actions will run until it is cleared with linkedin_kill_switch.`,
      };
    }

    const cooldownUntil = (await this.kv.get<number>("safety:cooldown_until")) ?? 0;
    if (cooldownUntil > Date.now()) {
      return {
        ok: false,
        kind: "cooldown",
        message: `LinkedIn rate-limited this app recently, so writes are paused until ${new Date(cooldownUntil).toISOString()}.`,
        next_allowed_at: cooldownUntil,
      };
    }

    // Caps before throttle: when the daily budget is spent, "try again in 90
    // seconds" is a lie — the cap does not reset until tomorrow. The more
    // fundamental refusal has to be the one reported.
    const capVerdict = await this.checkCaps(spec);
    if (capVerdict) return capVerdict;

    const gapSeconds = safetyConfig.minGapSeconds(spec.action);
    if (gapSeconds) {
      const last = (await this.kv.get<number>(`safety:last:${spec.action}`)) ?? 0;
      const nextAllowed = last + gapSeconds * 1000;
      if (nextAllowed > Date.now()) {
        // Refuse rather than sleep: a 60s function ceiling makes waiting a
        // timeout, and pacing outreach is the human's job anyway.
        return {
          ok: false,
          kind: "throttle",
          message: `Too soon after the last ${spec.action}. The minimum gap is ${gapSeconds}s; try again at ${new Date(nextAllowed).toISOString()}.`,
          next_allowed_at: nextAllowed,
        };
      }
    }

    if (spec.requiresConfirmation ?? safetyConfig.requiresConfirmation(spec.action)) {
      return this.checkConfirmation(spec, payload, confirmToken);
    }
    return { ok: true };
  }

  private async checkCaps(spec: ActionSpec): Promise<GuardVerdict | null> {
    const cost = spec.cost ?? 1;
    const cap = safetyConfig.capFor(spec.action);
    const used = (await this.kv.get<number>(`safety:count:${spec.action}:${today()}`)) ?? 0;
    if (used + cost > cap) {
      return {
        ok: false,
        kind: "cap",
        message: `Daily cap reached for ${spec.action}: ${used}/${cap} used today. This limit protects the account from looking automated; raise it with the matching LINKEDIN_CAP_* env var if it is genuinely too low.`,
      };
    }

    const totalCap = safetyConfig.totalCap();
    const totalUsed = (await this.kv.get<number>(`safety:count:total:${today()}`)) ?? 0;
    if (totalUsed + cost > totalCap) {
      return {
        ok: false,
        kind: "cap",
        message: `Daily cap reached across all LinkedIn actions: ${totalUsed}/${totalCap} used today. Raise LINKEDIN_CAP_TOTAL if that is too low.`,
      };
    }
    return null;
  }

  /**
   * Two-phase confirmation, bound to the payload.
   *
   * A boolean `confirm` parameter would be no rail at all — the model would
   * simply set it. Instead the first call returns a preview and a single-use
   * token tied to a digest of the exact payload, and the second call must
   * present both. Binding to the digest is the important half: it makes it
   * impossible for the message a human approved to differ from the message
   * that actually goes out.
   */
  private async checkConfirmation(
    spec: ActionSpec,
    payload: unknown,
    confirmToken?: string
  ): Promise<GuardVerdict> {
    const digest = AuditLog.digest(payload);

    if (!confirmToken) {
      const token = crypto.randomBytes(18).toString("base64url");
      const record: ConfirmRecord = { action: spec.action, digest, created_at: Date.now() };
      await this.kv.set(`safety:confirm:${token}`, record, CONFIRM_TTL_SECONDS);
      return {
        ok: false,
        kind: "needs_confirmation",
        message: `Nothing has been sent. Review the preview below, then call this tool again with confirm_token to go ahead. The token is single-use, expires in ${CONFIRM_TTL_SECONDS / 60} minutes, and is only valid for this exact content.`,
        confirm_token: token,
        preview: payload,
      };
    }

    const record = await this.kv.get<ConfirmRecord>(`safety:confirm:${confirmToken}`);
    if (!record) {
      return {
        ok: false,
        kind: "needs_confirmation",
        message: "That confirm_token is unknown, already used, or expired. Call the tool again without one to get a fresh preview.",
      };
    }
    // Consume it before acting, so a retry can't replay the same approval.
    await this.kv.del(`safety:confirm:${confirmToken}`);

    if (record.action !== spec.action) {
      return {
        ok: false,
        kind: "needs_confirmation",
        message: `That confirm_token was issued for ${record.action}, not ${spec.action}.`,
      };
    }
    if (record.digest !== digest) {
      return {
        ok: false,
        kind: "needs_confirmation",
        message: "The content changed since it was previewed, so the approval no longer applies. Call the tool again without confirm_token to review the new version.",
      };
    }
    return { ok: true };
  }

  /**
   * Books the action against today's budget, atomically, and reports whether
   * the budget actually had room.
   *
   * check() reads the counters without incrementing, because it also runs for
   * the preview half of a two-phase write and a preview must not spend budget.
   * That leaves a window where two confirmed actions both pass a cap with one
   * slot left — which is the race kv.incr() exists to close. So the real
   * decision is made here, on the incremented value, and a losing caller gives
   * its slot back.
   *
   * Called *before* executing: over-counting a call that then fails is the
   * safe direction, undercounting is not.
   */
  async reserve(spec: ActionSpec): Promise<GuardVerdict> {
    const cost = spec.cost ?? 1;
    const actionKey = `safety:count:${spec.action}:${today()}`;
    const totalKey = `safety:count:total:${today()}`;

    const used = await this.kv.incr(actionKey, cost, COUNTER_TTL_SECONDS);
    const cap = safetyConfig.capFor(spec.action);
    if (used > cap) {
      await this.kv.incr(actionKey, -cost, COUNTER_TTL_SECONDS);
      return {
        ok: false,
        kind: "cap",
        message: `Daily cap reached for ${spec.action}: ${cap}/${cap} used today. This limit protects the account from looking automated; raise it with the matching LINKEDIN_CAP_* env var if it is genuinely too low.`,
      };
    }

    const totalUsed = await this.kv.incr(totalKey, cost, COUNTER_TTL_SECONDS);
    const totalCap = safetyConfig.totalCap();
    if (totalUsed > totalCap) {
      await this.kv.incr(totalKey, -cost, COUNTER_TTL_SECONDS);
      await this.kv.incr(actionKey, -cost, COUNTER_TTL_SECONDS);
      return {
        ok: false,
        kind: "cap",
        message: `Daily cap reached across all LinkedIn actions: ${totalCap}/${totalCap} used today. Raise LINKEDIN_CAP_TOTAL if that is too low.`,
      };
    }

    await this.kv.set(`safety:last:${spec.action}`, Date.now(), COUNTER_TTL_SECONDS);
    return { ok: true };
  }

  /** Pauses writes after LinkedIn rate-limits us, so one 429 doesn't become a burst. */
  async noteRateLimit(retryAfterSeconds = 300): Promise<void> {
    await this.kv.set("safety:cooldown_until", Date.now() + retryAfterSeconds * 1000, 24 * 3600);
  }

  async killSwitch(): Promise<KillSwitchState> {
    if (safetyConfig.killSwitchFromEnv()) {
      return { on: true, reason: "LINKEDIN_KILL_SWITCH env var is set", set_at: 0 };
    }
    return (await this.kv.get<KillSwitchState>("safety:kill_switch")) ?? { on: false, set_at: 0 };
  }

  /**
   * The env var wins and cannot be cleared from here — otherwise the emergency
   * stop could be undone by the same agent loop it was set to stop.
   */
  async setKillSwitch(on: boolean, reason?: string): Promise<KillSwitchState> {
    if (safetyConfig.killSwitchFromEnv() && !on) {
      throw new Error(
        "The kill switch is held on by the LINKEDIN_KILL_SWITCH environment variable and cannot be cleared from a tool. Unset that variable and redeploy."
      );
    }
    const state: KillSwitchState = { on, reason, set_at: Date.now() };
    await this.kv.set("safety:kill_switch", state);
    return state;
  }

  /**
   * Counts a LinkedIn request against the daily ceiling, and pauses writes once
   * it is reached.
   *
   * LinkedIn publishes no per-endpoint rate limits, so this is a self-imposed
   * bound: cheap insurance against a loop burning through an unknown quota and
   * getting the app throttled for the rest of the day. Reads keep working — the
   * cooldown that check() consults only gates writes.
   */
  async noteRequest(): Promise<{ used: number; ceiling: number; warn: boolean }> {
    const ceiling = safetyConfig.dailyRequestCeiling();
    const used = await this.kv.incr(`safety:requests:${today()}`, 1, COUNTER_TTL_SECONDS);

    if (used >= ceiling) {
      const untilMidnight = Math.max(
        60,
        Math.ceil((new Date().setUTCHours(24, 0, 0, 0) - Date.now()) / 1000)
      );
      await this.kv.set("safety:cooldown_until", Date.now() + untilMidnight * 1000, 24 * 3600);
    }

    return { used, ceiling, warn: used >= ceiling * 0.8 };
  }

  /** How much of today's self-imposed request budget is gone. */
  async requestUsage(): Promise<{ used: number; ceiling: number }> {
    return {
      used: (await this.kv.get<number>(`safety:requests:${today()}`)) ?? 0,
      ceiling: safetyConfig.dailyRequestCeiling(),
    };
  }
}

export { canonical };
