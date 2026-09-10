import axios from "axios";
import type { DocumentUploadResult } from "../../types.js";
import type { LinkedInAuth } from "../linkedin-auth.js";
import type { LinkedInHttp } from "../linkedin-http.js";

interface InitializeUploadResponse {
  value: { uploadUrl: string; document: string };
}

/**
 * Uploads a PDF as a LinkedIn document asset — the thing a swipeable
 * "carousel" post points at.
 *
 * Both legs run under one withAuthRetry: on a 401 the whole upload is redone,
 * which just initializes a fresh document. The abandoned one is an orphaned
 * asset LinkedIn never sees referenced.
 */
export async function uploadDocument(
  http: LinkedInHttp,
  auth: LinkedInAuth,
  memberUrn: string,
  pdfBytes: Buffer
): Promise<DocumentUploadResult> {
  return auth.withAuthRetry(async (headers) => {
    const init = await http.request<InitializeUploadResponse>({
      method: "POST",
      path: "/rest/documents",
      query: { action: "initializeUpload" },
      body: { initializeUploadRequest: { owner: memberUrn } },
      capability: "post.document",
    });

    const uploadUrl = init.data.value.uploadUrl;
    const documentUrn = init.data.value.document;

    // Deliberately NOT through LinkedInHttp: uploadUrl is an absolute URL on a
    // different host, and it wants only Authorization + the binary content
    // type. Sending the versioned REST headers here makes LinkedIn reject it.
    await axios.put(uploadUrl, pdfBytes, {
      headers: {
        Authorization: headers.Authorization,
        "Content-Type": "application/pdf",
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 60_000,
    });

    return { documentUrn, uploadUrl };
  });
}
