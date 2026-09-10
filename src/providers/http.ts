import axios from "axios";
import crypto from "crypto";
import type { CapabilityId } from "../capabilities/types.js";
import type { OutreachProvider, SendMessageParams, SendMessageResult } from "./types.js";

/**
 * Forwards capabilities LinkedIn's official API withholds to an endpoint the
 * operator runs themselves.
 *
 * This ships deliberately empty of any LinkedIn-specific mechanism. Reaching
 * LinkedIn by unofficial means violates its User Agreement and risks the
 * account; that is the operator's call to make, so the code that would do it
 * lives on their side of this boundary, not in this repository.
 *
 * Requests carry an HMAC of the body in X-Signature so the receiving end can
 * verify they came from this server.
 */
export class HttpForwardingProvider implements OutreachProvider {
  readonly name = "http";

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly declared: CapabilityId[]
  ) {}

  capabilities(): CapabilityId[] {
    return this.declared;
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    return this.post<SendMessageResult>("/messages", params);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    const signature = crypto.createHmac("sha256", this.secret).update(payload).digest("hex");

    const resp = await axios.post<T>(`${this.baseUrl.replace(/\/+$/, "")}${path}`, payload, {
      headers: { "Content-Type": "application/json", "X-Signature": signature },
      timeout: 30_000,
    });
    return resp.data;
  }
}

/**
 * Builds the provider, if the operator has explicitly turned it on.
 *
 * Two variables are required, not one, and the second is an acknowledgement
 * rather than a value — so a .env copied from somewhere else cannot switch
 * unofficial access on by accident.
 */
export function selectProvider(): OutreachProvider | null {
  const kind = process.env.LINKEDIN_UNOFFICIAL_PROVIDER;
  if (!kind) return null;

  if (process.env.LINKEDIN_UNOFFICIAL_ACK !== "i-accept-tos-risk") {
    throw new Error(
      "LINKEDIN_UNOFFICIAL_PROVIDER is set but LINKEDIN_UNOFFICIAL_ACK is not 'i-accept-tos-risk'. " +
        "Routing LinkedIn actions through an unofficial provider breaks LinkedIn's User Agreement and can get the account restricted. " +
        "Set the acknowledgement explicitly if that is intended."
    );
  }

  if (kind !== "http") {
    throw new Error(`Unknown LINKEDIN_UNOFFICIAL_PROVIDER '${kind}'. The only supported value is 'http'.`);
  }

  const baseUrl = process.env.LINKEDIN_PROVIDER_URL;
  const secret = process.env.LINKEDIN_PROVIDER_SECRET;
  if (!baseUrl || !secret) {
    throw new Error(
      "The http provider needs LINKEDIN_PROVIDER_URL and LINKEDIN_PROVIDER_SECRET."
    );
  }

  const declared = (process.env.LINKEDIN_PROVIDER_CAPABILITIES || "message.send")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as CapabilityId[];

  return new HttpForwardingProvider(baseUrl, secret, declared);
}
