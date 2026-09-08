/**
 * Turning a LinkedIn permalink into the URN the API wants.
 *
 * This exists because reading comments needs r_member_social, a permission
 * LinkedIn has closed — so there is no way to enumerate the comments on a
 * post. A pasted link from the browser is the only discovery path left, and
 * these are the shapes LinkedIn's own UI produces.
 */

export interface ParsedUrn {
  urn: string;
  kind: "share" | "ugcPost" | "activity" | "comment";
}

const URN_PATTERN = /^urn:li:(share|ugcPost|activity|comment):/;

/**
 * Accepts a URN as-is, or extracts one from any of:
 *   https://www.linkedin.com/feed/update/urn:li:activity:7123...
 *   https://www.linkedin.com/posts/someone_slug-activity-7123...-AbCd
 *   https://www.linkedin.com/feed/update/urn:li:activity:7123.../?commentUrn=urn%3Ali%3Acomment%3A(...)
 */
export function parsePostUrn(input: string): ParsedUrn {
  const value = input.trim();

  if (URN_PATTERN.test(value)) {
    return { urn: value, kind: value.split(":")[2] as ParsedUrn["kind"] };
  }

  const decoded = safeDecode(value);

  // A comment URN carried in the query string wins: it is more specific than
  // the post URN in the same link, and it is what a reply has to target.
  const commentMatch = decoded.match(/urn:li:comment:\([^)]*\)/);
  if (commentMatch) return { urn: commentMatch[0], kind: "comment" };

  const embedded = decoded.match(/urn:li:(share|ugcPost|activity):\d+/);
  if (embedded) return { urn: embedded[0], kind: embedded[1] as ParsedUrn["kind"] };

  // The /posts/ permalink shape encodes the id as "...-activity-<digits>-<hash>".
  const slug = decoded.match(/-activity-(\d+)/);
  if (slug) return { urn: `urn:li:activity:${slug[1]}`, kind: "activity" };

  throw new Error(
    `Could not find a LinkedIn post or comment URN in "${input}". Paste the full URL of the post (the address bar on the post's own page), or a urn:li:activity:… / urn:li:ugcPost:… / urn:li:comment:… value directly.`
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
