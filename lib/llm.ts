import OpenAI from "openai";
import type { SourceType, Corroboration, Claim, Triple, EntityType, ExtractedClaim } from "./types";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const smallLlm = new OpenAI({
  baseURL: process.env.SMALL_LLM_BASE_URL ?? "http://rrh-llm-1:8001/v1",
  apiKey: "dummy",
  timeout: 60_000,
});

const largeLlm = new OpenAI({
  baseURL: process.env.LARGE_LLM_BASE_URL ?? "http://rrh-llm-1:8003/v1",
  apiKey: "dummy",
  timeout: 120_000,
});

const embeddingClient = new OpenAI({
  baseURL: process.env.EMBEDDING_BASE_URL ?? "http://rrh-llm-1:8002/v1",
  apiKey: "dummy",
  timeout: 30_000,
});

const SMALL_MODEL = process.env.SMALL_LLM_MODEL ?? "ramblerun/Multimodal-AI";
const LARGE_MODEL = process.env.LARGE_LLM_MODEL ?? "ramblerun/Reasoning-AI";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "ramblerun/TextEmbedding-AI";

const MAX_CONTENT_CHARS = 16_000;
const MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnlinkedSource {
  description: string;
  canonicalKey: string;
  sourceType: SourceType;
  publisher: string;
  date: string;
}

export interface ClassificationResult {
  title: string;
  sourceType: SourceType;
  publisher: string;
  date: string;
  snippet: string;
  sourceUrls: string[];
  unlinkedSources: UnlinkedSource[];
}

export interface EdgeKGContext {
  sharedTriples: {
    subject: string;
    object: string;
    sourcePredicates: string[];
    downstreamPredicates: string[];
  }[];
  temporalNote?: string;
}

export interface EdgeAnalysisResult {
  sourceFidelity: number;
  editorialization: number;
  concerns: string[];
}

export interface PhantomEdgeResult {
  sourceFidelity: number;
  editorialization: number;
  corroboration: Corroboration;
  concerns: string[];
  attributedClaims: string[];
}

// ---------------------------------------------------------------------------
// Valid enums
// ---------------------------------------------------------------------------

const SOURCE_TYPES: Set<string> = new Set([
  "primary-study",
  "press-release",
  "wire-service",
  "secondary-reporting",
  "opinion",
  "official-statement",
  "data-source",
  "interview",
]);

const CORROBORATION_VALUES: Set<string> = new Set([
  "strong",
  "partial",
  "none",
  "unverified",
]);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM = `You are an epistemic source classifier. You will receive a page URL, its markdown content, and a list of links found on the page.

Return a JSON object with exactly these fields:
- "title": the actual headline/title of THIS specific article as it appears in the content. Do NOT use sidebar headlines, related article titles, or navigation text. If the content is not an article, use a short descriptive title.
- "sourceType": one of "primary-study", "press-release", "wire-service", "secondary-reporting", "opinion", "official-statement", "data-source", "interview"
  IMPORTANT: Use "data-source" for general reference content — wikis, knowledge bases, FAQ pages, documentation, glossaries, "about" pages, or any content that provides general background information rather than reporting on specific events. These pages lack specific dates, named sources, or event-driven claims. Do NOT classify them as "secondary-reporting" or "wire-service".
- "publisher": the publishing organization name
- "date": publication date in YYYY-MM-DD format, or "" if unknown
- "snippet": a 1-2 sentence summary of the key epistemic claim or finding (max 200 chars)
- "sourceUrls": array of UP TO 10 URLs from the LINKS LIST that this article directly cites, references, or relies on for its factual claims. Be VERY selective — only include links where the article explicitly draws information from that source. Examples of what TO include: a study the article cites, a press release it quotes, a prior news report it references by name, an official document it mentions. Examples of what NOT to include: "related stories" sidebars, navigation links, topic pages, newsletter signups, social media links, ads, author bios, or other articles that happen to be about a similar topic but are not cited. When in doubt, leave it out. Return an empty array if the article does not cite any sources from the links list.
- "unlinkedSources": array of sources mentioned/referenced in the article text that have NO corresponding URL in the links list. Only include sources the article ATTRIBUTES SPECIFIC FACTUAL CLAIMS TO — skip vague "experts say" or "some people believe." For each object include:
  - "description": what the source is (e.g., "Trump's Truth Social post criticizing Anthropic")
  - "canonicalKey": stable lowercase hyphenated dedup key using pattern "{entity}-{platform/type}-{topic}-{approx-date}" (e.g., "trump-truth-social-anthropic-2026-02")
  - "sourceType": same enum as above
  - "publisher": the publishing organization or platform
  - "date": best-guess date in YYYY-MM-DD format, or ""

Return ONLY valid JSON. No markdown fences, no explanation.`;

const PHANTOM_EDGE_SYSTEM = `You are an epistemic attribution analyst. You are given a single article that references a source which is NOT available for direct comparison. The referenced source is described below.

Your task: extract what factual claims the article attributes to this source, and assess how precisely the attribution is made.

Return a JSON object with exactly these fields:
- "sourceFidelity": number 0-1. How precisely the article attributes claims to this source. 1 = direct quotes with clear attribution. 0 = vague hand-waving. Consider: does the article use direct quotes? Named attribution? Specific details?
- "editorialization": number 0-1. How much editorial spin the article appears to add to what this source said. 0 = neutral reporting of what the source said. 1 = heavy editorialization around the source's claims.
- "corroboration": always "unverified" (we cannot check the original source).
- "concerns": array of specific concern strings about how the article represents this source. E.g., "Article paraphrases without direct quotes, attribution is vague." Empty array if attribution seems clean.
- "attributedClaims": array of specific factual claims the article says came from this source. Each claim should be a concise, standalone statement. E.g., ["Trump called Anthropic's AI safety efforts 'a waste'", "The post was made on Thursday morning"]. Empty array if no specific claims are attributed.

Return ONLY valid JSON. No markdown fences, no explanation.`;

const EXTRACT_CLAIMS_SYSTEM = `You are an epistemic claim extractor. You will receive a news article's markdown content and title.

Extract the 5-15 key FACTUAL CLAIMS made in the article. Focus on:
- Specific factual assertions (who did what, when, where)
- Named entities: people, organizations, places, documents
- Claims that could be verified or contradicted by other sources

For each claim, provide:
- "claim": a concise standalone factual statement (1 sentence)
- "entities": array of specific named entities mentioned in this claim (proper nouns only — people, orgs, places, documents, not generic nouns). Use CANONICAL names consistently (always "Joe Biden", never "Biden" or "the president").
- "attribution": who or what source this claim is attributed to (e.g. "Reuters reporting", "official statement by X", "unnamed sources")
- "triples": array of structured relationship triples extracted from this claim. Each triple has:
  - "subject": canonical entity name (e.g. "Joe Biden")
  - "subjectType": one of "person", "organization", "place", "event", "document", "concept"
  - "predicate": concise normalized verb/relationship (e.g. "accused", "signed", "reported", "denied", "announced", "met_with", "criticized")
  - "object": canonical entity name
  - "objectType": one of "person", "organization", "place", "event", "document", "concept"
  - "context": optional additional context for the relationship (e.g. "erasing history", "during summit")

IMPORTANT for triples:
- Use canonical entity names consistently across all claims
- Use concise normalized predicates (lowercase verbs)
- Each claim should have at least 1 triple if it involves 2+ entities
- A claim may have multiple triples if it expresses multiple relationships

Return a JSON object: { "claims": [ ... ] }

Return ONLY valid JSON. No markdown fences, no explanation.`;

const EDGE_ANALYSIS_SYSTEM = `You are an epistemic fidelity analyst. You are given two documents: a SOURCE document (upstream/original) and a DOWNSTREAM document (which cites or references the source). Analyze how faithfully the downstream document represents the claims it draws from the source.

You may also receive KNOWLEDGE GRAPH CONTEXT showing entity relationships extracted from both documents. This shows where the documents agree, and where their predicates diverge. When you see a divergence, consider the publication dates — if the source is weeks or months older, a "contradiction" may simply be the world moving on since the source was published. An old source that accurately reported what was known at the time is a GOOD source, even if the facts have since changed.

CRITICAL — Time-aware fidelity:
- The core question is: does the downstream FAIRLY REPRESENT what the source said at the time it was published?
- A source from months ago won't contain recent developments. That's not inaccuracy — the source simply predates those events. Do NOT penalize fidelity for this.
- When you see a divergence in the knowledge graph (e.g., source says "proposed", downstream says "signed"), check the dates. If weeks/months have passed, this likely reflects events progressing — not the downstream misrepresenting the source.
- Only flag a fidelity concern when the downstream MISREPRESENTS what the source actually said — e.g., claiming the source reported X when it actually reported Y.
- Editorialization means adding spin or misleading framing to the source's original claims — NOT adding later developments.

Return a JSON object with exactly these fields:
- "sourceFidelity": number 0-1. How accurately the downstream represents what the source reported AT THE TIME of its publication. 1 = faithfully represents what the source said. 0 = misrepresents the source's claims. An older source that correctly reported earlier events should score HIGH.
- "editorialization": number 0-1. 0 = neutral representation of the source. 1 = heavy editorial spin on what the source said.
- "concerns": array of specific concern strings about actual misrepresentation of the source's claims. Do NOT flag temporal divergence as a concern. Empty array if no concerns.

Return ONLY valid JSON. No markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function classifySource(
  url: string,
  markdown: string,
  title: string,
  links?: { href: string; text: string }[],
): Promise<ClassificationResult> {
  const t0 = Date.now();
  console.log(`[llm] classifySource start: ${url}`);

  const content = truncate(markdown);
  let userPrompt = `URL: ${url}\nTitle: ${title}\n\nContent:\n${content}`;

  if (links && links.length > 0) {
    // Deduplicate and cap link list to keep prompt reasonable
    const seen = new Set<string>();
    const uniqueLinks: { href: string; text: string }[] = [];
    for (const link of links) {
      if (!seen.has(link.href)) {
        seen.add(link.href);
        uniqueLinks.push(link);
      }
      if (uniqueLinks.length >= 100) break;
    }
    const linkList = uniqueLinks
      .map((l) => l.text ? `- ${l.href} ("${l.text}")` : `- ${l.href}`)
      .join("\n");
    userPrompt += `\n\nLINKS LIST:\n${linkList}`;
  }

  const raw = await callWithRetry(smallLlm, SMALL_MODEL, CLASSIFY_SYSTEM, userPrompt);
  const parsed = safeParseJson(raw);

  const rawUnlinked = Array.isArray(parsed?.unlinkedSources) ? parsed.unlinkedSources : [];
  const unlinkedSources: UnlinkedSource[] = rawUnlinked
    .filter(
      (s: unknown): s is Record<string, unknown> =>
        typeof s === "object" && s !== null && typeof (s as Record<string, unknown>).description === "string",
    )
    .map((s: Record<string, unknown>) => ({
      description: String(s.description),
      canonicalKey: typeof s.canonicalKey === "string" ? s.canonicalKey : "",
      sourceType: validSourceType(s.sourceType),
      publisher: typeof s.publisher === "string" ? s.publisher : "",
      date: typeof s.date === "string" ? s.date : "",
    }))
    .slice(0, 10);

  const result: ClassificationResult = {
    title: typeof parsed?.title === "string" ? parsed.title : "",
    sourceType: validSourceType(parsed?.sourceType),
    publisher: typeof parsed?.publisher === "string" ? parsed.publisher : "",
    date: typeof parsed?.date === "string" ? parsed.date : "",
    snippet: typeof parsed?.snippet === "string" ? parsed.snippet.slice(0, 300) : "",
    sourceUrls: Array.isArray(parsed?.sourceUrls)
      ? parsed.sourceUrls.filter((u: unknown) => typeof u === "string").slice(0, 10)
      : [],
    unlinkedSources,
  };

  console.log(
    `[llm] classifySource done (${Date.now() - t0}ms): ${url} → ${result.sourceType}, ${result.sourceUrls.length} sourceUrls, ${result.unlinkedSources.length} unlinked`,
  );
  return result;
}

export async function extractClaims(
  markdown: string,
  title: string,
): Promise<Omit<ExtractedClaim, "embedding">[]> {
  const t0 = Date.now();
  console.log(`[llm] extractClaims start: "${title}"`);

  const content = truncate(markdown);
  const userPrompt = `Title: ${title}\n\nContent:\n${content}`;

  const raw = await callWithRetry(smallLlm, SMALL_MODEL, EXTRACT_CLAIMS_SYSTEM, userPrompt);
  const parsed = safeParseJson(raw);

  const rawClaims = Array.isArray(parsed?.claims) ? parsed.claims : [];
  const claims: Omit<ExtractedClaim, "embedding">[] = rawClaims
    .filter(
      (c: unknown): c is Record<string, unknown> =>
        typeof c === "object" && c !== null && typeof (c as Record<string, unknown>).claim === "string",
    )
    .map((c: Record<string, unknown>) => ({
      claim: String(c.claim),
      entities: Array.isArray(c.entities)
        ? c.entities.filter((e: unknown) => typeof e === "string")
        : [],
      attribution: typeof c.attribution === "string" ? c.attribution : "",
      triples: parseTriples(c.triples),
    }))
    .slice(0, 15);

  const tripleCount = claims.reduce((n, c) => n + c.triples.length, 0);
  console.log(
    `[llm] extractClaims done (${Date.now() - t0}ms): ${claims.length} claims, ${claims.reduce((n, c) => n + c.entities.length, 0)} entities, ${tripleCount} triples`,
  );
  return claims;
}

export async function analyzeEdge(
  sourceContent: string,
  downstreamContent: string,
  label?: string,
  dates?: { sourceDate?: string; downstreamDate?: string },
  kgContext?: EdgeKGContext,
): Promise<EdgeAnalysisResult> {
  const t0 = Date.now();
  console.log(`[llm] analyzeEdge start: ${label ?? "?"}`);

  let dateContext = "";
  if (dates?.sourceDate || dates?.downstreamDate) {
    dateContext = `\nTemporal context: Source published ${dates.sourceDate || "unknown date"}, Downstream published ${dates.downstreamDate || "unknown date"}.\n`;
  }

  let kgSection = "";
  if (kgContext && kgContext.sharedTriples.length > 0) {
    const lines = kgContext.sharedTriples.map((st) => {
      const srcPreds = st.sourcePredicates.join(", ");
      const dstPreds = st.downstreamPredicates.join(", ");
      return `- (${st.subject}) ↔ (${st.object}): source says [${srcPreds}], downstream says [${dstPreds}]`;
    });
    kgSection = `\nKNOWLEDGE GRAPH CONTEXT — shared entity relationships:\n${lines.join("\n")}`;
    if (kgContext.temporalNote) {
      kgSection += `\n${kgContext.temporalNote}`;
    }
    kgSection += "\n";
  }

  const userPrompt = `${dateContext}${kgSection}SOURCE DOCUMENT:\n${truncate(sourceContent)}\n\n---\n\nDOWNSTREAM DOCUMENT:\n${truncate(downstreamContent)}`;

  const raw = await callWithRetry(largeLlm, LARGE_MODEL, EDGE_ANALYSIS_SYSTEM, userPrompt, {
    chat_template_kwargs: { enable_thinking: false },
  });
  const parsed = safeParseJson(raw);

  const result: EdgeAnalysisResult = {
    sourceFidelity: clamp01(parsed?.sourceFidelity, 0.5),
    editorialization: clamp01(parsed?.editorialization, 0.5),
    concerns: Array.isArray(parsed?.concerns)
      ? parsed.concerns.filter((c: unknown) => typeof c === "string")
      : [],
  };

  console.log(
    `[llm] analyzeEdge done (${Date.now() - t0}ms): ${label ?? "?"} → fidelity=${result.sourceFidelity}`,
  );
  return result;
}

export async function analyzePhantomEdge(
  articleContent: string,
  phantomDescription: string,
  label?: string,
): Promise<PhantomEdgeResult> {
  const t0 = Date.now();
  console.log(`[llm] analyzePhantomEdge start: ${label ?? "?"}`);

  const userPrompt = `REFERENCED SOURCE: ${phantomDescription}\n\nARTICLE:\n${truncate(articleContent)}`;

  const raw = await callWithRetry(largeLlm, LARGE_MODEL, PHANTOM_EDGE_SYSTEM, userPrompt, {
    chat_template_kwargs: { enable_thinking: false },
  });
  const parsed = safeParseJson(raw);

  const result: PhantomEdgeResult = {
    sourceFidelity: clamp01(parsed?.sourceFidelity, 0.5),
    editorialization: clamp01(parsed?.editorialization, 0.5),
    corroboration: "unverified",
    concerns: Array.isArray(parsed?.concerns)
      ? parsed.concerns.filter((c: unknown) => typeof c === "string")
      : [],
    attributedClaims: Array.isArray(parsed?.attributedClaims)
      ? parsed.attributedClaims.filter((c: unknown) => typeof c === "string")
      : [],
  };

  console.log(
    `[llm] analyzePhantomEdge done (${Date.now() - t0}ms): ${label ?? "?"} → ${result.attributedClaims.length} claims`,
  );
  return result;
}

export interface NodeMatchCandidate {
  phantomId: string;
  phantomDescription: string;
  realId: string;
  realTitle: string;
  realPublisher: string;
}

export interface NodeMatchResult {
  phantomId: string;
  realId: string;
  match: boolean;
}

/**
 * Use the small LLM to determine which phantom nodes match real nodes.
 * Batches all candidates into a single LLM call for efficiency.
 */
export async function matchPhantomsToReals(
  candidates: NodeMatchCandidate[],
): Promise<NodeMatchResult[]> {
  if (candidates.length === 0) return [];
  const t0 = Date.now();
  console.log(`[llm] matchPhantomsToReals start: ${candidates.length} candidates`);

  const pairList = candidates
    .map(
      (c, i) =>
        `${i + 1}. PHANTOM: "${c.phantomDescription}" | REAL: "${c.realTitle}" by ${c.realPublisher}`,
    )
    .join("\n");

  const system = `You determine whether an unlinked source description (PHANTOM) refers to the same source as a scraped article (REAL).

A match means they are the SAME source — e.g., the phantom describes "AP report on X" and the real article IS that AP report on X. Similar topic alone is NOT a match. The phantom must be describing the specific real article.

Return a JSON object: { "matches": [1, 3, ...] } — an array of the 1-based pair numbers that are matches. Return { "matches": [] } if none match.

Return ONLY valid JSON. No markdown fences, no explanation.`;

  const raw = await callWithRetry(smallLlm, SMALL_MODEL, system, pairList);
  const parsed = safeParseJson(raw);
  const matchIndices = new Set(
    Array.isArray(parsed?.matches)
      ? parsed.matches.filter((n: unknown) => typeof n === "number").map((n: number) => n - 1)
      : [],
  );

  const results = candidates.map((c, i) => ({
    phantomId: c.phantomId,
    realId: c.realId,
    match: matchIndices.has(i),
  }));

  const matchCount = results.filter((r) => r.match).length;
  console.log(
    `[llm] matchPhantomsToReals done (${Date.now() - t0}ms): ${matchCount}/${candidates.length} matches`,
  );
  return results;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export async function embedClaims(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const t0 = Date.now();
  console.log(`[llm] embedClaims start: ${texts.length} texts`);

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[llm] embedClaims retry ${attempt}/${MAX_RETRIES}`);
      }
      const response = await embeddingClient.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
      });
      const embeddings = response.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
      console.log(`[llm] embedClaims done (${Date.now() - t0}ms): ${embeddings.length} embeddings`);
      return embeddings;
    } catch (err) {
      lastError = err;
      console.warn(`[llm] embedClaims attempt ${attempt} failed:`, (err as Error).message ?? err);
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  console.error(`[llm] embedClaims GAVE UP after ${MAX_RETRIES + 1} attempts:`, lastError);
  // Return zero vectors as fallback
  return texts.map(() => new Array(768).fill(0));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ENTITY_TYPES = new Set<string>([
  "person", "organization", "place", "event", "document", "concept",
]);

function parseTriples(raw: unknown): Triple[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t: unknown): t is Record<string, unknown> =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).subject === "string" &&
        typeof (t as Record<string, unknown>).predicate === "string" &&
        typeof (t as Record<string, unknown>).object === "string",
    )
    .map((t: Record<string, unknown>) => ({
      subject: String(t.subject),
      subjectType: validEntityType(t.subjectType),
      predicate: String(t.predicate).toLowerCase(),
      object: String(t.object),
      objectType: validEntityType(t.objectType),
      ...(typeof t.context === "string" && t.context ? { context: t.context } : {}),
    }));
}

function validEntityType(value: unknown): EntityType {
  if (typeof value === "string" && VALID_ENTITY_TYPES.has(value)) {
    return value as EntityType;
  }
  return "concept";
}

async function callWithRetry(
  client: OpenAI,
  model: string,
  system: string,
  user: string,
  extraParams?: Record<string, unknown>,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[llm] retry ${attempt}/${MAX_RETRIES} for ${model}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        ...extraParams,
      } as any);
      return response.choices[0]?.message?.content ?? "";
    } catch (err) {
      lastError = err;
      console.warn(`[llm] attempt ${attempt} failed for ${model}:`, (err as Error).message ?? err);
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  console.error(`[llm] GAVE UP after ${MAX_RETRIES + 1} attempts for ${model}:`, lastError);
  return "";
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract JSON from surrounding text
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return text.slice(0, MAX_CONTENT_CHARS) + "\n...[truncated]";
}

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== "number" || isNaN(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function validSourceType(value: unknown): SourceType {
  if (typeof value === "string" && SOURCE_TYPES.has(value)) {
    return value as SourceType;
  }
  return "secondary-reporting";
}

function validCorroboration(value: unknown): Corroboration {
  if (typeof value === "string" && CORROBORATION_VALUES.has(value)) {
    return value as Corroboration;
  }
  return "unverified";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
