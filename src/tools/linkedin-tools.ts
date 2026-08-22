import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LinkedInClient, handleLinkedInApiError } from "../services/linkedin-client.js";
import { CHARACTER_LIMIT } from "../constants.js";

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Truncated: response was ${text.length} characters, limit is ${CHARACTER_LIMIT}]`
  );
}

type TextBlock = { type: "text"; text: string };

/**
 * A trailing warning block for successful results when the LinkedIn session is
 * heading for a deadline a human has to clear. Returned as its own content
 * block rather than appended to the first one, so the JSON payload callers
 * parse stays valid JSON.
 *
 * Never throws: a failed status lookup must not turn a successful post into an
 * error.
 */
async function authWarningBlocks(client: LinkedInClient): Promise<TextBlock[]> {
  try {
    const status = await client.getAuthStatus();
    if (!status.warning) return [];
    return [{ type: "text", text: `⚠ LinkedIn auth: ${status.warning}` }];
  } catch {
    return [];
  }
}

export function registerLinkedInTools(server: McpServer, client: LinkedInClient): void {
  // -----------------------------------------------------------------------
  server.registerTool(
    "linkedin_auth_status",
    {
      title: "Check LinkedIn Auth Status",
      description: `Report the health of this server's stored LinkedIn session: when the access token expires, whether a refresh token exists, and the date by which a human must re-authorize.

Makes NO LinkedIn API call — it only reads the locally stored token record, so it is free and safe to call any time, including when posting is already failing.

Returns JSON:
  {
    connected: boolean,
    member_id?: string,
    access_token_expires_at?: number,      // epoch ms
    access_token_expires_in_days?: number,
    has_refresh_token: boolean,            // false = hard stop, cannot renew itself
    refresh_token_expires_at?: number,
    hard_deadline_at?: number,             // epoch ms a HUMAN must re-authorize by
    hard_deadline_in_days?: number,
    warning?: string,                      // present only when action is needed
    reauthorize_path: string
  }

Use this when: a LinkedIn tool returned an auth error, or you want to check before a scheduled/batch run whether the session will last. If 'warning' is set, tell the user to visit the reauthorize_path on this server.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const status = await client.getAuthStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          structuredContent: status as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleLinkedInApiError(error) }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  server.registerTool(
    "linkedin_get_profile",
    {
      title: "Get LinkedIn Profile",
      description: `Get the authenticated LinkedIn member's profile info (name, id, email if granted).

Use this to confirm which LinkedIn account this server is authenticated as, or to obtain the member URN used by other tools. Read-only, no side effects.

Returns JSON: { sub: string, name?: string, email?: string, picture?: string }

Error Handling:
  - Returns an auth error message telling you to visit /oauth/linkedin/start if no session exists or the token can't be refreshed.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const info = await client.getUserInfo();
        return {
          content: [
            { type: "text", text: truncate(JSON.stringify(info, null, 2)) },
            ...(await authWarningBlocks(client)),
          ],
          structuredContent: info as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleLinkedInApiError(error) }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  const UploadDocumentInputSchema = z
    .object({
      pdf_url: z
        .string()
        .url()
        .describe(
          "Publicly reachable URL of the PDF to upload (e.g. a Gamma export download link). The server downloads this and re-uploads it to LinkedIn."
        ),
      filename: z
        .string()
        .min(1)
        .max(200)
        .default("document.pdf")
        .describe("Filename to associate with the upload (cosmetic only)."),
    })
    .strict();

  server.registerTool(
    "linkedin_upload_document",
    {
      title: "Upload LinkedIn Document",
      description: `Upload a PDF to LinkedIn as a "document" asset and return its URN.

A LinkedIn document asset is what renders as a swipeable carousel in the feed once attached to a post via linkedin_create_post (or use linkedin_post_carousel to do both steps in one call). This tool ONLY uploads — it does not publish anything, so it is safe to call speculatively.

Args:
  - pdf_url (string, required): a URL the server can fetch the PDF from.
  - filename (string, optional): cosmetic filename, default "document.pdf".

Returns JSON: { documentUrn: string }  // e.g. "urn:li:document:C4D1FAQ..."

Examples:
  - Use when: you already have a hosted PDF and want to stage it before writing/approving the post caption.
  - Don't use when: you want the whole post published in one step — use linkedin_post_carousel instead.

Error Handling:
  - Returns "Error: ..." with the LinkedIn API status/message if the fetch or upload fails.`,
      inputSchema: UploadDocumentInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: z.infer<typeof UploadDocumentInputSchema>) => {
      try {
        const pdfBytes = await LinkedInClient.downloadPdf(params.pdf_url);
        const { documentUrn } = await client.uploadDocument(pdfBytes, params.filename);
        const output = { documentUrn };
        return {
          content: [
            { type: "text", text: JSON.stringify(output) },
            ...(await authWarningBlocks(client)),
          ],
          structuredContent: output,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleLinkedInApiError(error) }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  const CreatePostInputSchema = z
    .object({
      commentary: z
        .string()
        .min(1)
        .max(3000)
        .describe("The post's caption text, shown above the carousel. Plain text (no markdown)."),
      document_urn: z
        .string()
        .regex(/^urn:li:document:/, "Must be a document URN from linkedin_upload_document")
        .describe("The document URN returned by linkedin_upload_document."),
      title: z
        .string()
        .min(1)
        .max(200)
        .describe("Title shown on the document/carousel card itself."),
      visibility: z
        .enum(["PUBLIC", "CONNECTIONS"])
        .default("PUBLIC")
        .describe("Who can see the post."),
    })
    .strict();

  server.registerTool(
    "linkedin_create_post",
    {
      title: "Publish LinkedIn Document Post",
      description: `Publish a post to the authenticated member's LinkedIn feed, attaching a previously-uploaded document (carousel) asset.

This is IRREVERSIBLE via this API — LinkedIn posts can't be edited or deleted through this tool, only from the LinkedIn UI. Always confirm the caption and document are correct before calling this.

Args:
  - commentary (string, required): the caption text.
  - document_urn (string, required): a "urn:li:document:..." from linkedin_upload_document.
  - title (string, required): title shown on the carousel card.
  - visibility ('PUBLIC' | 'CONNECTIONS', optional, default 'PUBLIC').

Returns JSON: { postUrn: string, postUrl: string }

Don't use when: you haven't uploaded the document yet (call linkedin_upload_document first, or use linkedin_post_carousel for both steps at once).`,
      inputSchema: CreatePostInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: z.infer<typeof CreatePostInputSchema>) => {
      try {
        const result = await client.createDocumentPost({
          commentary: params.commentary,
          documentUrn: params.document_urn,
          title: params.title,
          visibility: params.visibility,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(result) },
            ...(await authWarningBlocks(client)),
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleLinkedInApiError(error) }] };
      }
    }
  );

  // -----------------------------------------------------------------------
  const PostCarouselInputSchema = z
    .object({
      pdf_url: z
        .string()
        .url()
        .describe("Publicly reachable URL of the carousel PDF (e.g. a Gamma export download link)."),
      commentary: z.string().min(1).max(3000).describe("The post's caption text."),
      title: z.string().min(1).max(200).describe("Title shown on the carousel card."),
      visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
    })
    .strict();

  server.registerTool(
    "linkedin_post_carousel",
    {
      title: "Post Carousel to LinkedIn (Upload + Publish)",
      description: `Convenience workflow tool: downloads a PDF from a URL, uploads it to LinkedIn as a document asset, and immediately publishes a post referencing it — in one call.

This is the tool to use for "post this Gamma carousel to LinkedIn" style requests. It is IRREVERSIBLE — the post goes live on the authenticated member's feed immediately with no draft/review step. If you want a review step, call linkedin_upload_document and linkedin_create_post separately with a confirmation in between instead.

Args:
  - pdf_url (string, required): URL of the carousel PDF (e.g. a Gamma export link).
  - commentary (string, required): caption text for the post.
  - title (string, required): title shown on the carousel card.
  - visibility ('PUBLIC' | 'CONNECTIONS', optional, default 'PUBLIC').

Returns JSON: { documentUrn: string, postUrn: string, postUrl: string }

Error Handling:
  - If the PDF download fails, returns an error before anything is uploaded to LinkedIn (no partial post).
  - If upload succeeds but publishing fails, the document URN is still returned in the error text so you can retry linkedin_create_post without re-uploading.`,
      inputSchema: PostCarouselInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: z.infer<typeof PostCarouselInputSchema>) => {
      let documentUrn: string | undefined;
      try {
        const pdfBytes = await LinkedInClient.downloadPdf(params.pdf_url);
        const uploadResult = await client.uploadDocument(pdfBytes, `${params.title}.pdf`);
        documentUrn = uploadResult.documentUrn;

        const postResult = await client.createDocumentPost({
          commentary: params.commentary,
          documentUrn,
          title: params.title,
          visibility: params.visibility,
        });

        const output = { documentUrn, ...postResult };
        return {
          content: [
            { type: "text", text: JSON.stringify(output) },
            ...(await authWarningBlocks(client)),
          ],
          structuredContent: output,
        };
      } catch (error) {
        const suffix = documentUrn
          ? ` (document was uploaded successfully as ${documentUrn} — you can retry publishing with linkedin_create_post instead of re-uploading)`
          : "";
        return {
          isError: true,
          content: [{ type: "text", text: handleLinkedInApiError(error) + suffix }],
        };
      }
    }
  );
}
