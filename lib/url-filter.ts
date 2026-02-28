const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
]);

const BLOCKED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".webp",
  ".mp4",
  ".mp3",
  ".wav",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
]);

/** Strip tracking params, fragments, trailing slashes; lowercase hostname. */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }

  // Sort remaining params for consistent dedup
  url.searchParams.sort();

  let result = url.toString();
  // Strip trailing slash (but keep root "/")
  if (result.endsWith("/") && url.pathname !== "/") {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Basic sanity check — reject things that are obviously not web pages.
 * Epistemic relevance filtering is handled by the LLM, not here.
 */
export function isAnalyzableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  // Check file extensions
  const ext = url.pathname.match(/\.\w+$/)?.[0]?.toLowerCase();
  if (ext && BLOCKED_EXTENSIONS.has(ext)) return false;

  return true;
}
