import type { CapabilityId } from "../capabilities/types.js";

export interface SendMessageParams {
  /** Person URN or profile URL of the recipient. */
  recipient: string;
  text: string;
  subject?: string;
}

export interface SendMessageResult {
  threadId?: string;
  messageId?: string;
}

/**
 * The seam for capabilities LinkedIn's official API does not expose to a
 * self-serve app — messaging, inbox reads, people search.
 *
 * Nothing in this repo implements these against LinkedIn's internal endpoints.
 * The only shipped implementation forwards to a URL the operator runs, so the
 * decision to reach LinkedIn by unofficial means (and the code that does it)
 * stays on their side of a network boundary. See providers/http.ts.
 */
export interface OutreachProvider {
  /** Short name reported by linkedin_capabilities, e.g. "http". */
  readonly name: string;
  /** Which capabilities this provider claims to serve. */
  capabilities(): CapabilityId[];
  sendMessage?(params: SendMessageParams): Promise<SendMessageResult>;
}
