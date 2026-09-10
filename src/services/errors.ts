import axios, { AxiosError } from "axios";
import type { CapabilityId } from "../capabilities/types.js";

/** Thrown when there is no usable LinkedIn session; callers should surface a clear "run the OAuth setup" message. */
export class LinkedInAuthError extends Error {}

/**
 * Thrown when the endpoint behind a tool isn't reachable with this app's
 * products and scopes. Distinct from LinkedInAuthError: the session is fine,
 * LinkedIn just won't grant this *capability* to this app.
 */
export class CapabilityUnavailableError extends Error {
  constructor(
    readonly capability: CapabilityId,
    message: string,
    readonly fallbackTool?: string
  ) {
    super(message);
  }
}

/**
 * Thrown by the outreach engine for a condition the caller can act on — a
 * prospect who already replied, a finished sequence, a template placeholder
 * with no value. These messages name the fix, so they must not be flattened
 * into "Unexpected error occurred" by the handler below.
 */
export class OutreachError extends Error {}

/** Thrown when a safety rail (kill switch, daily cap, throttle) refuses an action. */
export class SafetyBlockedError extends Error {
  constructor(
    readonly kind: "kill_switch" | "cap" | "throttle" | "cooldown",
    message: string
  ) {
    super(message);
  }
}

export const REAUTHORIZE_PATH = "/oauth/linkedin/start";

export interface ApiErrorContext {
  /** The capability this call was exercising, named in the 403 message. */
  capability?: CapabilityId;
  /** Scopes the token actually holds, so a 403 can show what's present vs missing. */
  scopes?: string[];
  /** A tool that still works, offered as the next step. */
  fallbackTool?: string;
}

export function handleLinkedInApiError(error: unknown, ctx: ApiErrorContext = {}): string {
  // Our own errors already carry precise, actionable messages — don't let them
  // fall through to the generic "Unexpected error occurred" below.
  if (error instanceof LinkedInAuthError) return `Error: ${error.message}`;
  if (error instanceof CapabilityUnavailableError) {
    const fallback = error.fallbackTool ? ` Use ${error.fallbackTool} instead.` : "";
    return `Error: ${error.message}${fallback}`;
  }
  if (error instanceof SafetyBlockedError) return `Error: ${error.message}`;
  if (error instanceof OutreachError) return `Error: ${error.message}`;

  if (axios.isAxiosError(error)) {
    const err = error as AxiosError<{ message?: string; serviceErrorCode?: number }>;
    if (err.response) {
      const body = err.response.data;
      const detail = body?.message ? ` — ${body.message}` : "";
      switch (err.response.status) {
        case 401:
          return `Error: LinkedIn rejected the access token (expired or revoked) even after a refresh attempt. Re-run the OAuth setup via ${REAUTHORIZE_PATH}.`;
        case 403:
          return formatForbidden(detail, ctx);
        case 404:
          return `Error: LinkedIn resource not found${detail}.`;
        case 422:
          return `Error: LinkedIn rejected the request payload${detail}.`;
        case 429:
          return "Error: LinkedIn rate limit exceeded. Wait before retrying.";
        default:
          return `Error: LinkedIn API request failed with status ${err.response.status}${detail}`;
      }
    }
    if (err.code === "ECONNABORTED") return "Error: Request to LinkedIn timed out. Please retry.";
  }
  return `Error: Unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * A 403 from LinkedIn almost always means the *app* lacks the product or
 * permission for the endpoint, not that the token is bad — so name the
 * capability and the granted scopes rather than guessing at one product.
 * (This used to hardcode "Share on LinkedIn"/w_member_social, which is
 * actively misleading for analytics and messaging endpoints.)
 */
function formatForbidden(detail: string, ctx: ApiErrorContext): string {
  const parts = [
    `Error: LinkedIn denied this request${detail}.`,
    "A 403 here normally means the app lacks the required product or permission for this endpoint, not that the token is invalid.",
  ];
  if (ctx.capability) parts.push(`Capability: ${ctx.capability}.`);
  if (ctx.scopes?.length) parts.push(`Granted scopes: ${ctx.scopes.join(", ")}.`);
  parts.push(
    ctx.fallbackTool
      ? `Run linkedin_capabilities to see what this token can actually do, or use ${ctx.fallbackTool} instead.`
      : "Run linkedin_capabilities to see what this token can actually do."
  );
  return parts.join(" ");
}
