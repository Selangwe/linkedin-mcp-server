import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LinkedInClient } from "../services/linkedin-client.js";
import { confirmTokenField, defineTool, type ToolContext } from "./shared.js";

const visibility = z
  .enum(["PUBLIC", "CONNECTIONS"])
  .default("PUBLIC")
  .describe("Who can see the post.");

export function registerPostTools(server: McpServer, ctx: ToolContext): void {
  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_upload_document",
    title: "Upload Document to LinkedIn",
    description: `Download a PDF from a URL and upload it to LinkedIn as a document asset. Nothing is published — this only stages the file and returns its URN.

Args:
  - pdf_url (string, required): a publicly reachable URL to the PDF (e.g. a Gamma export link).
  - filename (string, optional): a name for logs. LinkedIn takes the visible title from the post, not the file.

Returns JSON: { documentUrn, uploadUrl }

Use when: you want a review step between staging and going live. Pass the documentUrn to linkedin_create_post afterwards. For one-shot publishing use linkedin_post_carousel.

Error handling: a failure here means nothing was published. Safe to retry.`,
    schema: z
      .object({
        pdf_url: z.string().url().describe("Publicly reachable URL of the PDF to upload."),
        filename: z.string().min(1).max(200).optional().describe("Optional name, for logs only."),
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: false },
    capability: "post.document",
    handler: async (args, c) => {
      const pdf = await LinkedInClient.downloadPdf(args.pdf_url);
      const result = await c.client.uploadDocument(pdf, args.filename ?? "document.pdf");
      return { ...result, sizeBytes: pdf.length };
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_create_post",
    title: "Publish LinkedIn Document Post",
    description: `Publish a post to the authenticated member's feed, attaching a document (carousel) asset uploaded earlier.

This is IRREVERSIBLE through this API — LinkedIn posts cannot be edited or deleted here, only from the LinkedIn UI.

Two-phase by design: call it once WITHOUT confirm_token to get back a preview of exactly what will be published plus a single-use token; call it again with that token and identical content to actually publish. The token is bound to the content, so an edited caption invalidates it.

Args:
  - commentary (string, required): the caption text, plain text (no markdown).
  - document_urn (string, required): a "urn:li:document:..." from linkedin_upload_document.
  - title (string, required): title shown on the carousel card.
  - visibility ('PUBLIC' | 'CONNECTIONS', optional, default 'PUBLIC').
  - confirm_token (string, optional): the token from the preview call.

Returns JSON: { postUrn, postUrl } — or { needs_confirmation: true, preview, confirm_token } on the first call.

Don't use when: the document isn't uploaded yet (call linkedin_upload_document first, or use linkedin_post_carousel for both steps).`,
    schema: z
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
        title: z.string().min(1).max(200).describe("Title shown on the document/carousel card."),
        visibility,
        confirm_token: confirmTokenField,
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: false },
    capability: "post.document",
    action: { action: "post.publish" },
    previewOf: (args) => ({
      commentary: args.commentary,
      title: args.title,
      visibility: args.visibility,
      document_urn: args.document_urn,
    }),
    targetOf: (args) => args.document_urn,
    handler: async (args, c) => {
      const result = await c.client.createDocumentPost({
        commentary: args.commentary,
        documentUrn: args.document_urn,
        title: args.title,
        visibility: args.visibility,
      });
      await c.history.record({
        urn: result.postUrn,
        url: result.postUrl,
        title: args.title,
        excerpt: args.commentary.slice(0, 120),
        kind: "document",
      });
      return result as unknown as Record<string, unknown>;
    },
  });

  // -----------------------------------------------------------------------
  defineTool(server, ctx, {
    name: "linkedin_post_carousel",
    title: "Post PDF Carousel to LinkedIn",
    description: `Download a PDF, upload it to LinkedIn and publish it as a carousel post — all three steps in one call.

This is IRREVERSIBLE through this API. Like linkedin_create_post it is two-phase: the first call (no confirm_token) downloads nothing and publishes nothing, it just returns a preview of the caption and title plus a single-use token bound to that exact content.

Args:
  - pdf_url (string, required): publicly reachable URL of the PDF.
  - commentary (string, required): the caption text.
  - title (string, required): title shown on the carousel card.
  - visibility ('PUBLIC' | 'CONNECTIONS', optional, default 'PUBLIC').
  - confirm_token (string, optional): the token from the preview call.

Returns JSON: { postUrn, postUrl, documentUrn } — or { needs_confirmation: true, preview, confirm_token } on the first call.

Error handling: if the upload succeeds but publishing fails, the error names the documentUrn so you can retry with linkedin_create_post instead of re-uploading.`,
    schema: z
      .object({
        pdf_url: z.string().url().describe("Publicly reachable URL of the PDF to post."),
        commentary: z.string().min(1).max(3000).describe("The post's caption text."),
        title: z.string().min(1).max(200).describe("Title shown on the carousel card."),
        visibility,
        confirm_token: confirmTokenField,
      })
      .strict(),
    annotations: { readOnlyHint: false, idempotentHint: false },
    capability: "post.document",
    action: { action: "post.publish" },
    previewOf: (args) => ({
      commentary: args.commentary,
      title: args.title,
      visibility: args.visibility,
      pdf_url: args.pdf_url,
    }),
    targetOf: (args) => args.pdf_url,
    handler: async (args, c) => {
      const pdf = await LinkedInClient.downloadPdf(args.pdf_url);
      const upload = await c.client.uploadDocument(pdf, "carousel.pdf");

      try {
        const result = await c.client.createDocumentPost({
          commentary: args.commentary,
          documentUrn: upload.documentUrn,
          title: args.title,
          visibility: args.visibility,
        });
        await c.history.record({
          urn: result.postUrn,
          url: result.postUrl,
          title: args.title,
          excerpt: args.commentary.slice(0, 120),
          kind: "document",
        });
        return { ...result, documentUrn: upload.documentUrn };
      } catch (error) {
        // Hand back the uploaded asset so the work isn't lost to a retry.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `The document uploaded successfully but publishing failed: ${detail}. Retry with linkedin_create_post using document_urn="${upload.documentUrn}" — do not re-upload.`
        );
      }
    },
  });
}
