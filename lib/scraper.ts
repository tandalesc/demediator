import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface CrawlLink {
  href: string;
  text: string;
  internal: boolean;
}

export interface CrawlResult {
  url: string;
  success: boolean;
  markdown: string;
  title: string;
  links: CrawlLink[];
  metadata: Record<string, string>;
}

const SCRAPER_BASE_URL =
  process.env.SCRAPER_BASE_URL ?? "http://localhost:11235";

const BATCH_SIZE = 5;
const BATCH_MAX_RETRIES = 2;
const TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory scrape cache (fast path within a single process lifetime)
const scrapeCache = new Map<string, { result: CrawlResult; expiresAt: number }>();

// ---------------------------------------------------------------------------
// Disk cache — survives hot reloads and process restarts
// ---------------------------------------------------------------------------

const DISK_CACHE_DIR = join(process.cwd(), ".cache", "scraper");

function diskCacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function readDiskCache(url: string): CrawlResult | null {
  try {
    const filePath = join(DISK_CACHE_DIR, `${diskCacheKey(url)}.json`);
    if (!existsSync(filePath)) return null;
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (data.expiresAt > Date.now()) {
      return data.result as CrawlResult;
    }
  } catch {
    // corrupted or unreadable — treat as miss
  }
  return null;
}

function writeDiskCache(url: string, result: CrawlResult): void {
  try {
    mkdirSync(DISK_CACHE_DIR, { recursive: true });
    const filePath = join(DISK_CACHE_DIR, `${diskCacheKey(url)}.json`);
    writeFileSync(
      filePath,
      JSON.stringify({ url, result, expiresAt: Date.now() + CACHE_TTL_MS }),
    );
  } catch {
    // best-effort — don't break the pipeline over a cache write
  }
}

/** Crawl a batch of URLs via the scraper service. Cache-aware. */
export async function crawlUrls(
  urls: string[],
): Promise<Map<string, CrawlResult>> {
  const results = new Map<string, CrawlResult>();
  const uncached: string[] = [];
  const now = Date.now();

  let memHits = 0;
  let diskHits = 0;

  for (const url of urls) {
    // 1. Check in-memory cache
    const entry = scrapeCache.get(url);
    if (entry && entry.expiresAt > now) {
      results.set(url, entry.result);
      memHits++;
      continue;
    }

    // 2. Check disk cache (survives hot reloads)
    const diskResult = readDiskCache(url);
    if (diskResult) {
      results.set(url, diskResult);
      // Promote back into memory for subsequent calls this process
      scrapeCache.set(url, { result: diskResult, expiresAt: now + CACHE_TTL_MS });
      diskHits++;
      continue;
    }

    uncached.push(url);
  }

  if (uncached.length === 0) {
    console.log(`[scraper] all ${urls.length} URLs served from cache (${memHits} mem, ${diskHits} disk)`);
    return results;
  }

  console.log(
    `[scraper] crawling ${uncached.length} URLs (${memHits} mem cached, ${diskHits} disk cached)`,
  );

  // Fetch only URLs not in either cache
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    const batchResults = await crawlBatch(batch);
    for (const [url, result] of batchResults) {
      results.set(url, result);
      scrapeCache.set(url, { result, expiresAt: now + CACHE_TTL_MS });
      // Only persist successful scrapes to disk
      if (result.success) {
        writeDiskCache(url, result);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// /crawl endpoint — returns links + metadata + raw markdown
// ---------------------------------------------------------------------------

async function crawlBatch(
  urls: string[],
  attempt = 0,
): Promise<Map<string, CrawlResult>> {
  const results = new Map<string, CrawlResult>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const response = await fetch(`${SCRAPER_BASE_URL}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls,
        crawler_config: {
          type: "CrawlerType.ASYNC_PLAYWRIGHT",
          parser_type: "lxml",
          exclude_social_media_domains: true,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timer);
      if (attempt < BATCH_MAX_RETRIES) {
        console.error(`[scraper] HTTP ${response.status} for batch of ${urls.length}, retry ${attempt + 1}/${BATCH_MAX_RETRIES}`);
        return crawlBatch(urls, attempt + 1);
      }
      console.error(`[scraper] HTTP ${response.status} for batch of ${urls.length}, giving up after ${BATCH_MAX_RETRIES} retries`);
      for (const url of urls) {
        results.set(url, failedResult(url));
      }
      return results;
    }

    const data = await response.json();
    const items: unknown[] = Array.isArray(data) ? data : data.results ?? [];

    // Fetch cleaned article markdown in parallel via /md endpoint
    const mdPromises = urls.map((url) => fetchMd(url));
    const mdResults = await Promise.all(mdPromises);

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const item = items[i] as Record<string, unknown> | undefined;
      if (!item || item.success === false) {
        results.set(url, failedResult(url));
        fail++;
        continue;
      }

      // Get raw markdown as fallback
      const mdField = item.markdown as Record<string, unknown> | string | undefined;
      const rawMarkdown =
        typeof mdField === "string"
          ? mdField
          : typeof mdField === "object" && mdField !== null
            ? (mdField.raw_markdown as string) ?? ""
            : "";

      // Prefer /md fit content, fall back to stripped raw markdown
      const fitMarkdown = mdResults[i];
      const markdown = pickBestContent(fitMarkdown, rawMarkdown);

      if (!markdown) {
        results.set(url, failedResult(url));
        fail++;
        continue;
      }

      const meta = (item.metadata ?? {}) as Record<string, string>;
      // Prefer og:title (article headline) over <title> (often includes site name / nav text)
      const title = meta["og:title"] ?? meta.title ?? "";
      const linksField = item.links as Record<string, unknown[]> | unknown[] | undefined;
      const links = parseLinks(linksField);

      results.set(url, { url, success: true, markdown, title, links, metadata: meta });
      ok++;
    }

    console.log(
      `[scraper] batch done (${Date.now() - t0}ms): ${ok} ok, ${fail} failed`,
    );
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt < BATCH_MAX_RETRIES) {
      console.error(`[scraper] batch request failed (${Date.now() - t0}ms): ${msg}, retry ${attempt + 1}/${BATCH_MAX_RETRIES}`);
      return crawlBatch(urls, attempt + 1);
    }
    console.error(`[scraper] batch request failed (${Date.now() - t0}ms): ${msg}, giving up after ${BATCH_MAX_RETRIES} retries`);
    for (const url of urls) {
      if (!results.has(url)) {
        results.set(url, failedResult(url));
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return results;
}

// ---------------------------------------------------------------------------
// /md endpoint — returns cleaner article content
// ---------------------------------------------------------------------------

async function fetchMd(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${SCRAPER_BASE_URL}/md`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, f: "fit", q: null, c: "0" }),
        signal: controller.signal,
      });
      if (!response.ok) return "";
      const data = await response.json();
      return typeof data.markdown === "string" ? data.markdown : "";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Pick the best markdown content between /md fit and raw.
 * The fit version is preferred, but if it's still mostly nav boilerplate,
 * fall back to stripping the raw markdown ourselves.
 */
function pickBestContent(fitMarkdown: string, rawMarkdown: string): string {
  const stripped = fitMarkdown ? stripBoilerplate(fitMarkdown) : "";
  if (stripped.length > 500) return stripRelatedContent(stripped);

  // Fall back to stripping the raw markdown
  const strippedRaw = rawMarkdown ? stripBoilerplate(rawMarkdown) : "";
  if (strippedRaw.length > 500) return stripRelatedContent(strippedRaw);

  // Last resort: use whatever we have
  const best = stripped || strippedRaw || rawMarkdown;
  return best ? stripRelatedContent(best) : best;
}

/**
 * Strip "Related Articles" / "More from" / "You may also like" sections.
 * These leak sidebar/footer links into the LLM's view, causing off-topic
 * sourceUrl extraction. Only cuts if the heading appears in the back 70%
 * of the document to avoid false positives in article body.
 */
function stripRelatedContent(markdown: string): string {
  const lines = markdown.split("\n");
  const cutoffLine = Math.floor(lines.length * 0.3); // only cut in back 70%

  const pattern =
    /^#{1,4}\s*(related\s+(articles?|stories|posts|coverage|news|topics?|content)|more\s+(from|on|stories|coverage|news|in)|you\s+(may|might)\s+also\s+(like|enjoy)|also\s+(read|see|watch)|trending|popular\s+(now|stories|articles?)|recommended|what\s+to\s+read\s+next|don['']?t\s+miss|top\s+stories|editors['']?\s+picks?|latest\s+(news|stories|articles?))\s*$/i;

  for (let i = cutoffLine; i < lines.length; i++) {
    if (pattern.test(lines[i].trim())) {
      return lines.slice(0, i).join("\n").trim();
    }
  }

  return markdown;
}

/**
 * Strip nav/sidebar boilerplate from markdown using text density.
 * Article paragraphs are long lines with few links.
 * Nav sections are short lines packed with links.
 */
function stripBoilerplate(markdown: string): string {
  const lines = markdown.split("\n");
  const scored: { line: string; score: number }[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      scored.push({ line, score: 0 });
      continue;
    }

    // Count markdown links in this line
    const linkCount = (trimmed.match(/\[([^\]]*)\]\([^)]*\)/g) || []).length;
    // Text length after removing link syntax
    const plainText = trimmed
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[#*_`>|]/g, "");
    const textLen = plainText.length;

    // High score = likely article content (long text, few links per char)
    // Low score = likely nav (short text, many links)
    if (textLen < 10) {
      scored.push({ line, score: -1 });
    } else {
      const linkDensity = linkCount / (textLen / 100);
      scored.push({ line, score: textLen - linkDensity * 30 });
    }
  }

  // Find the best contiguous block of high-scoring lines.
  // Use a sliding window: find the region with highest cumulative score.
  let bestStart = 0;
  let bestEnd = 0;
  let bestSum = -Infinity;

  // For each potential start, extend forward while score is positive-ish
  for (let start = 0; start < scored.length; start++) {
    if (scored[start].score < 5) continue;

    let sum = 0;
    let consecutiveWeak = 0;
    for (let end = start; end < scored.length; end++) {
      sum += scored[end].score;
      if (scored[end].score < 1) {
        consecutiveWeak++;
      } else {
        consecutiveWeak = 0;
      }
      // Stop if too many weak lines in a row (left the article body)
      if (consecutiveWeak > 5) break;
      if (sum > bestSum) {
        bestSum = sum;
        bestStart = start;
        bestEnd = end;
      }
    }
  }

  if (bestEnd <= bestStart) return markdown;

  return lines.slice(bestStart, bestEnd + 1).join("\n").trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failedResult(url: string): CrawlResult {
  return { url, success: false, markdown: "", title: "", links: [], metadata: {} };
}

function parseLinks(raw: unknown): CrawlLink[] {
  if (typeof raw !== "object" || raw === null) return [];

  if (!Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const internal = Array.isArray(obj.internal) ? obj.internal : [];
    const external = Array.isArray(obj.external) ? obj.external : [];
    return [
      ...toLinkArray(internal, true),
      ...toLinkArray(external, false),
    ];
  }

  return toLinkArray(raw, false);
}

function toLinkArray(items: unknown[], internal: boolean): CrawlLink[] {
  return items
    .filter(
      (l): l is { href: string; text?: string } =>
        typeof l === "object" && l !== null && typeof (l as Record<string, unknown>).href === "string",
    )
    .map((l) => ({ href: l.href, text: l.text ?? "", internal }));
}
