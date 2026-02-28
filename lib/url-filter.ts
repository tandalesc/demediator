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

const NON_ARTICLE_PATTERNS = [
  /\/video\//i,
  /\/videos\//i,
  /\/watch\b/i,
  /\/embed\//i,
  /\/podcast\//i,
  /\/episode\//i,
  /\/live\b/i,
];

const NON_ARTICLE_DOMAINS = new Set([
  "youtube.com", "youtu.be", "vimeo.com", "dailymotion.com",
  "twitch.tv", "tiktok.com",
  "spotify.com", "podcasts.apple.com",
]);

/**
 * Basic sanity check — reject things that are obviously not web pages
 * or are known non-text content (video, podcast, livestream pages).
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

  // Reject known non-article domains (video/podcast platforms)
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (NON_ARTICLE_DOMAINS.has(hostname)) return false;

  // Reject non-article URL path patterns
  const pathAndSearch = url.pathname + url.search;
  for (const pattern of NON_ARTICLE_PATTERNS) {
    if (pattern.test(pathAndSearch)) return false;
  }

  return true;
}
