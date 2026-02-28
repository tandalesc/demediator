import type { AnalysisResult, SourceNode, SourceEdge, Claim, Corroboration, ExtractedClaim } from "./types";
import { normalizeUrl, isAnalyzableUrl } from "./url-filter";
import { crawlUrls, type CrawlResult } from "./scraper";
import {
  classifySource,
  analyzeEdge,
  analyzePhantomEdge,
  extractClaims,
  embedClaims,
  cosineSimilarity,
  matchPhantomsToReals,
  type ClassificationResult,
  type NodeMatchCandidate,
  type EdgeKGContext,
} from "./llm";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_DEPTH = int(process.env.PIPELINE_MAX_DEPTH, 2);
const MAX_URLS = int(process.env.PIPELINE_MAX_URLS, 50);
const MIN_TOPIC_OVERLAP = int(process.env.PIPELINE_MIN_TOPIC_OVERLAP, 2);
const MAX_URLS_PER_LEVEL = int(process.env.PIPELINE_MAX_URLS_PER_LEVEL, 15);
const LLM_CONCURRENCY = int(process.env.PIPELINE_LLM_CONCURRENCY, 4);
const MAX_PHANTOM_EDGES = int(process.env.PIPELINE_MAX_PHANTOM_EDGES, 15);
const MAX_PHANTOM_PER_PARENT = int(process.env.PIPELINE_MAX_PHANTOM_PER_PARENT, 5);
const MAX_PHANTOM_DEPTH = int(process.env.PIPELINE_MAX_PHANTOM_DEPTH, 1);
const MIN_EDGE_RELEVANCE = 0.2;

function int(val: string | undefined, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

function createLimiter(concurrency: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    while (running >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineOutput {
  result: AnalysisResult;
  claimData: Map<string, ExtractedClaim[]>;
}

export async function runPipeline(articleUrl: string): Promise<PipelineOutput> {
  const pipelineStart = Date.now();
  console.log(`[pipeline] START: ${articleUrl}`);
  console.log(
    `[pipeline] config: maxDepth=${MAX_DEPTH} maxUrls=${MAX_URLS} maxPerLevel=${MAX_URLS_PER_LEVEL} concurrency=${LLM_CONCURRENCY} maxPhantomEdges=${MAX_PHANTOM_EDGES} maxPhantomPerParent=${MAX_PHANTOM_PER_PARENT} maxPhantomDepth=${MAX_PHANTOM_DEPTH}`,
  );

  const limit = createLimiter(LLM_CONCURRENCY);

  // State
  const visited = new Set<string>();
  const nodes: SourceNode[] = [];
  const edges: SourceEdge[] = [];
  let nodeCounter = 0;
  let phantomCounter = 0;
  let totalUrlsProcessed = 0;

  // Maps normalized URL → { nodeId, markdown, date }
  const nodeByUrl = new Map<string, { nodeId: string; markdown: string; date: string }>();
  // Maps normalized candidate URL → parent nodeIds that linked to it
  const parentMap = new Map<string, Set<string>>();
  // Maps phantom canonicalKey → phantom node entry
  const phantomByKey = new Map<string, { nodeId: string; claims: string[] }>();
  let phantomEdgeCount = 0;
  const phantomEdgesProcessed = new Set<string>();

  // Knowledge graph state
  const claimsByNode = new Map<string, ExtractedClaim[]>();
  const entityIndex = new Map<string, Set<string>>();  // canonical_name → Set<nodeIds that mention it>

  // -----------------------------------------------------------------------
  // Step 1: Scrape the root article
  // -----------------------------------------------------------------------
  console.log(`[pipeline] step 1: scraping root article`);
  const normalizedArticleUrl = normalizeUrl(articleUrl);
  visited.add(normalizedArticleUrl);

  const rootCrawl = await crawlUrls([articleUrl]);
  const rootResult = rootCrawl.get(articleUrl);
  if (!rootResult?.success) {
    throw new Error(`Failed to scrape article: ${articleUrl}`);
  }
  console.log(
    `[pipeline] root scraped: "${rootResult.title}" (${rootResult.markdown.length} chars, ${rootResult.links.length} links)`,
  );

  // -----------------------------------------------------------------------
  // Step 2: Classify root article
  // -----------------------------------------------------------------------
  console.log(`[pipeline] step 2: classifying root article`);
  const rootClassification = await classifySource(
    articleUrl,
    rootResult.markdown,
    rootResult.title,
    rootResult.links,
  );

  const rootNode: SourceNode = {
    id: "article",
    title: rootClassification.title || rootResult.title || rootClassification.publisher || articleUrl,
    url: articleUrl,
    publisher: rootClassification.publisher,
    date: rootClassification.date,
    sourceType: rootClassification.sourceType,
    snippet: rootClassification.snippet,
  };
  nodes.push(rootNode);
  nodeByUrl.set(normalizedArticleUrl, {
    nodeId: "article",
    markdown: rootResult.markdown,
    date: rootClassification.date,
  });
  totalUrlsProcessed++;

  // -----------------------------------------------------------------------
  // Step 2b: Extract claims from root article + embed
  // -----------------------------------------------------------------------
  console.log(`[pipeline] step 2b: extracting claims from root article`);
  const rootExtracted = await extractClaimsChunked(rootResult.markdown, rootNode.title);
  claimsByNode.set("article", rootExtracted);
  indexEntities("article", rootExtracted);

  // Backwards-compatible alias for root claims (used by entity/topic filtering below)
  const rootClaims: Claim[] = rootExtracted;

  // Build claim entity set (specific proper nouns from claims)
  const claimEntities = new Set<string>();
  for (const claim of rootClaims) {
    for (const entity of claim.entities) {
      claimEntities.add(entity.toLowerCase());
    }
  }

  // Narrow topic terms: title + snippet only (not 3000 chars of markdown)
  const rootTopicTerms = extractContentWords(
    `${rootNode.title} ${rootClassification.snippet}`,
  );

  console.log(
    `[pipeline] root classified: type=${rootClassification.sourceType}, ${rootClassification.sourceUrls.length} LLM-identified sourceUrls, ${rootClaims.length} claims, ${claimEntities.size} claim entities, ${rootTopicTerms.size} topic terms`,
  );

  // -----------------------------------------------------------------------
  // Step 3: Gather initial candidates from root
  // -----------------------------------------------------------------------
  // LLM-selected sourceUrls get highest priority
  const rootCandidates = gatherCandidates(
    rootClassification.sourceUrls,
    "article",
    visited,
    parentMap,
    100,
  );

  // Inline article links as lower-priority fallback — only those whose anchor
  // text mentions a claim entity. Catches cited sources the LLM missed.
  const allInlineLinks = extractInlineLinks(rootResult.markdown);
  const relevantInlineUrls = filterInlineLinksByEntities(allInlineLinks, claimEntities);
  const inlineCandidates = gatherCandidates(
    relevantInlineUrls,
    "article",
    visited,
    parentMap,
    50,
  );
  rootCandidates.push(...inlineCandidates);

  console.log(
    `[pipeline] ${rootCandidates.length} candidates from root (${rootClassification.sourceUrls.length} LLM-selected, ${inlineCandidates.length} inline from ${allInlineLinks.length} total)`,
  );

  // Process phantom (unlinked) sources from root classification
  await processPhantoms(rootClassification, "article", rootResult.markdown, 0);

  console.log(
    `[pipeline] ${phantomByKey.size} phantom nodes after root`,
  );

  // -----------------------------------------------------------------------
  // Step 4: BFS loop
  // -----------------------------------------------------------------------
  let currentCandidates = rootCandidates;

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    if (currentCandidates.length === 0 || totalUrlsProcessed >= MAX_URLS) {
      console.log(
        `[pipeline] depth ${depth}: stopping (${currentCandidates.length} candidates, ${totalUrlsProcessed}/${MAX_URLS} processed)`,
      );
      break;
    }

    const depthStart = Date.now();

    // Prioritize and cap
    const sorted = currentCandidates.sort((a, b) => b.priority - a.priority);
    const budget = Math.min(
      MAX_URLS_PER_LEVEL,
      MAX_URLS - totalUrlsProcessed,
    );
    const selected = sorted.slice(0, budget);

    console.log(
      `[pipeline] depth ${depth}: scraping ${selected.length} URLs (budget=${budget}, ${currentCandidates.length} candidates)`,
    );

    // Batch scrape
    const urls = selected.map((c) => c.url);
    const crawlResults = await crawlUrls(urls);

    // Phase 1: classify all scraped pages (concurrency-limited)
    const classified = new Map<
      string,
      { candidate: Candidate; crawl: CrawlResult; nodeId: string; classification: Awaited<ReturnType<typeof classifySource>> }
    >();

    const classifyTasks = selected.map((candidate) =>
      limit(async () => {
        const crawl = crawlResults.get(candidate.url);
        if (!crawl?.success) {
          // Server error or network failure — skip silently, retries
          // already happened in the scraper
          console.log(`[pipeline]   skip (scrape failed): ${candidate.url}`);
          return;
        }

        if (crawl.markdown.length < 200) {
          // Page loaded but has no real content — video, paywall, thin page.
          // Create an unverifiable node so it's visible in the graph.
          nodeCounter++;
          const nodeId = `s-${nodeCounter}`;
          const normalizedUrl = normalizeUrl(candidate.url);
          const guessTitle = crawl.title || titleFromUrl(candidate.url);
          const node: SourceNode = {
            id: nodeId,
            title: guessTitle,
            url: candidate.url,
            publisher: publisherFromUrl(candidate.url),
            date: "",
            sourceType: "data-source",
            snippet: "Content not available for verification",
            unscrapable: true,
          };
          nodes.push(node);
          nodeByUrl.set(normalizedUrl, { nodeId, markdown: "", date: "" });

          // Create unverified edge to parent(s)
          const parents = parentMap.get(normalizedUrl);
          if (parents) {
            for (const parentNodeId of parents) {
              edges.push({
                id: `${parentNodeId}-${nodeId}`,
                source: nodeId,
                target: parentNodeId,
                metrics: {
                  sourceFidelity: 0.5,
                  editorialization: 0.5,
                  sourceType: "data-source",
                  corroboration: "unverified",
                },
                concerns: ["Source content could not be scraped — may be video, paywalled, or non-text content"],
              });
            }
          }

          console.log(`[pipeline]   unscrapable node ${nodeId}: ${candidate.url} ("${guessTitle}")`);
          totalUrlsProcessed++;
          return;
        }

        // Check topical relevance at ALL depths using claim entities +
        // narrow topic terms. A page is relevant if it mentions at least 1
        // claim entity OR has 3+ topic term overlap.
        {
          const pageText = `${crawl.title} ${crawl.markdown.slice(0, 1000)}`.toLowerCase();
          const hasClaimEntity = [...claimEntities].some((entity) => pageText.includes(entity));
          if (!hasClaimEntity) {
            const pageTerms = extractContentWords(crawl.title);
            let overlap = 0;
            for (const w of pageTerms) {
              if (rootTopicTerms.has(w)) overlap++;
            }
            if (overlap < MIN_TOPIC_OVERLAP) {
              console.log(`[pipeline]   skip (off-topic, no entity match, overlap=${overlap}): "${crawl.title}"`);
              return;
            }
          }
        }

        totalUrlsProcessed++;
        const normalizedUrl = normalizeUrl(candidate.url);

        // Skip LLM classification for link-heavy / content-light pages
        // (category indexes, video listings, tag pages).
        if (isLinkHeavy(crawl.markdown)) {
          nodeCounter++;
          const nodeId = `s-${nodeCounter}`;
          const guessTitle = crawl.title || titleFromUrl(candidate.url);
          const node: SourceNode = {
            id: nodeId,
            title: guessTitle,
            url: candidate.url,
            publisher: publisherFromUrl(candidate.url),
            date: "",
            sourceType: "data-source",
            snippet: "Link-heavy page (index or listing)",
          };
          nodes.push(node);
          nodeByUrl.set(normalizedUrl, { nodeId, markdown: crawl.markdown, date: "" });

          const parents = parentMap.get(normalizedUrl);
          if (parents) {
            for (const parentNodeId of parents) {
              edges.push({
                id: `${parentNodeId}-${nodeId}`,
                source: nodeId,
                target: parentNodeId,
                metrics: {
                  sourceFidelity: 0.5,
                  editorialization: 0.5,
                  sourceType: "data-source",
                  corroboration: "unverified",
                },
                concerns: ["Page is mostly links — likely an index or listing page"],
              });
            }
          }

          console.log(`[pipeline]   skip (link-heavy): ${candidate.url} ("${guessTitle}")`);
          return;
        }

        // Skip LLM classification for product / marketing pages
        if (isProductPage(candidate.url, crawl.title, crawl.markdown)) {
          nodeCounter++;
          const nodeId = `s-${nodeCounter}`;
          const guessTitle = crawl.title || titleFromUrl(candidate.url);
          const node: SourceNode = {
            id: nodeId,
            title: guessTitle,
            url: candidate.url,
            publisher: publisherFromUrl(candidate.url),
            date: "",
            sourceType: "data-source",
            snippet: "Product or marketing page",
          };
          nodes.push(node);
          nodeByUrl.set(normalizedUrl, { nodeId, markdown: crawl.markdown, date: "" });

          const parents = parentMap.get(normalizedUrl);
          if (parents) {
            for (const parentNodeId of parents) {
              edges.push({
                id: `${parentNodeId}-${nodeId}`,
                source: nodeId,
                target: parentNodeId,
                metrics: {
                  sourceFidelity: 0.5,
                  editorialization: 0.5,
                  sourceType: "data-source",
                  corroboration: "unverified",
                },
                concerns: ["Product/marketing page — not an epistemic source"],
              });
            }
          }

          console.log(`[pipeline]   skip (product page): ${candidate.url} ("${guessTitle}")`);
          return;
        }

        const classification = await classifySource(
          candidate.url,
          crawl.markdown,
          crawl.title,
          crawl.links,
        );

        // Override sourceType for knowledge base / reference pages
        if (isKnowledgeBase(candidate.url, crawl.title, crawl.markdown)) {
          classification.sourceType = "data-source";
          console.log(`[pipeline]   knowledge-base detected, downgraded to data-source: "${crawl.title}"`);
        }

        nodeCounter++;
        const nodeId = `s-${nodeCounter}`;
        const nodeTitle = classification.title || crawl.title || classification.publisher || candidate.url;

        const node: SourceNode = {
          id: nodeId,
          title: nodeTitle,
          url: candidate.url,
          publisher: classification.publisher,
          date: classification.date,
          sourceType: classification.sourceType,
          snippet: classification.snippet,
        };
        nodes.push(node);
        nodeByUrl.set(normalizedUrl, { nodeId, markdown: crawl.markdown, date: classification.date });

        // Extract claims + embed for knowledge graph (inside same concurrency slot).
        // Uses chunked extraction: large documents get split into ~3K passages,
        // each gets a fast extractClaims call, triples merge into the KG.
        if (classification.sourceType !== "data-source" && crawl.markdown.length >= 200) {
          const extracted = await extractClaimsChunked(crawl.markdown, nodeTitle);
          claimsByNode.set(nodeId, extracted);
          indexEntities(nodeId, extracted);
        }

        classified.set(normalizedUrl, { candidate, crawl, nodeId, classification });
      }),
    );

    await Promise.all(classifyTasks);
    console.log(
      `[pipeline] depth ${depth}: classified ${classified.size} nodes`,
    );

    // Process phantom sources from each classified node
    // Skip data-source nodes — category/knowledge-base pages list general facts,
    // not specific attributed sources worth phantom-tracking.
    // NOTE: do NOT wrap in limit() — processPhantoms uses limit() internally,
    // and nesting would cause deadlock (all outer slots taken, inner waits forever).
    const phantomTasks = [...classified.values()]
      .filter((entry) => entry.classification.sourceType !== "data-source")
      .map((entry) =>
        processPhantoms(entry.classification, entry.nodeId, entry.crawl.markdown, depth),
      );
    await Promise.all(phantomTasks);

    // Phase 2: compute corroboration via graph overlap, then analyze edges
    // Track which nodes have at least one relevant edge
    const relevantNodes = new Set<string>();
    const edgeTasks: Promise<void>[] = [];

    for (const [normalizedUrl, entry] of classified) {
      const { crawl, nodeId, classification } = entry;
      const parents = parentMap.get(normalizedUrl);

      if (parents) {
        const parentList = [...parents];
        for (const parentNodeId of parentList) {
          const parentData = [...nodeByUrl.values()].find(
            (n) => n.nodeId === parentNodeId,
          );
          if (!parentData) continue;

          const edgeLabel = `${nodeId}→${parentNodeId}`;

          // Compute corroboration via graph overlap (cheap, no LLM)
          const corroboration = computeCorroboration(nodeId, parentNodeId);

          // Gate analyzeEdge(): only call LLM for fidelity+editorialization
          // when there's at least partial corroboration overlap
          if (corroboration === "none" || corroboration === "unverified") {
            // No graph overlap — use defaults, skip expensive LLM call
            const edgeId = `${parentNodeId}-${nodeId}`;
            edges.push({
              id: edgeId,
              source: nodeId,
              target: parentNodeId,
              metrics: {
                sourceFidelity: 0.5,
                editorialization: 0.5,
                sourceType: classification.sourceType,
                corroboration,
              },
              concerns: [],
            });
            console.log(`[pipeline]   edge ${edgeLabel}: corr=${corroboration} (skipped LLM)`);
            if (corroboration !== "none") {
              relevantNodes.add(nodeId);
            }
          } else {
            edgeTasks.push(
              limit(async () => {
                // Build KG context: shared entity pairs + temporal note
                const kgContext = buildEdgeKGContext(
                  nodeId, parentNodeId,
                  classification.date, parentData.date,
                );

                const edgeMetrics = await analyzeEdge(
                  crawl.markdown,
                  parentData.markdown,
                  edgeLabel,
                  { sourceDate: classification.date, downstreamDate: parentData.date },
                  kgContext,
                );

                const edgeId = `${parentNodeId}-${nodeId}`;
                edges.push({
                  id: edgeId,
                  source: nodeId,
                  target: parentNodeId,
                  metrics: {
                    sourceFidelity: edgeMetrics.sourceFidelity,
                    editorialization: edgeMetrics.editorialization,
                    sourceType: classification.sourceType,
                    corroboration,
                  },
                  concerns: edgeMetrics.concerns,
                });

                // This branch only runs for "strong"/"partial" corroboration,
                // so the node always has a relevant edge
                relevantNodes.add(nodeId);
              }),
            );
          }
        }
      }
    }

    console.log(
      `[pipeline] depth ${depth}: analyzing ${edgeTasks.length} edges (${[...classified.values()].reduce((n, e) => n + (parentMap.get(normalizeUrl(e.candidate.url))?.size ?? 0), 0) - edgeTasks.length} skipped via graph gate)`,
    );
    await Promise.all(edgeTasks);

    // Phase 3: only gather next-level candidates from nodes with relevant edges
    // AND that mention at least 1 claim entity (prevents chain drift)
    const nextCandidates: Candidate[] = [];
    if (depth < MAX_DEPTH && totalUrlsProcessed < MAX_URLS) {
      for (const [, entry] of classified) {
        if (!relevantNodes.has(entry.nodeId)) {
          console.log(`[pipeline]   pruned ${entry.nodeId} (no relevant edges)`);
          continue;
        }

        // Data-source nodes (category pages, knowledge bases) — don't follow
        // their links, they lead to unrelated content. Just keep the node.
        if (entry.classification.sourceType === "data-source") {
          console.log(`[pipeline]   skipping links from ${entry.nodeId} (data-source)`);
          continue;
        }

        // Root-drift check: node content must mention at least 1 claim entity
        const nodeText = `${entry.crawl.title} ${entry.crawl.markdown.slice(0, 1000)}`.toLowerCase();
        const mentionsEntity = [...claimEntities].some((entity) => nodeText.includes(entity));
        if (!mentionsEntity) {
          console.log(`[pipeline]   pruned ${entry.nodeId} (no claim entity in content, preventing drift)`);
          continue;
        }

        const newCandidates = gatherCandidates(
          entry.classification.sourceUrls,
          entry.nodeId,
          visited,
          parentMap,
          100,
        );
        // Also include entity-relevant inline links as lower-priority fallback
        const depthInlineLinks = extractInlineLinks(entry.crawl.markdown);
        const depthRelevantUrls = filterInlineLinksByEntities(depthInlineLinks, claimEntities);
        const depthInlineCandidates = gatherCandidates(
          depthRelevantUrls,
          entry.nodeId,
          visited,
          parentMap,
          50,
        );
        nextCandidates.push(...newCandidates, ...depthInlineCandidates);
      }
    }

    console.log(
      `[pipeline] depth ${depth} done (${Date.now() - depthStart}ms): ${nodes.length} nodes, ${edges.length} edges, ${relevantNodes.size}/${classified.size} relevant, ${nextCandidates.length} next candidates`,
    );
    currentCandidates = nextCandidates;
  }

  // -----------------------------------------------------------------------
  // Phantom helpers (closures over pipeline state)
  // -----------------------------------------------------------------------

  async function processPhantoms(
    classification: ClassificationResult,
    parentNodeId: string,
    parentMarkdown: string,
    depth: number,
  ): Promise<void> {
    if (classification.unlinkedSources.length === 0) return;

    if (depth > MAX_PHANTOM_DEPTH) {
      console.log(`[pipeline] phantoms: skipping ${parentNodeId} — depth ${depth} > max ${MAX_PHANTOM_DEPTH}`);
      return;
    }
    if (phantomEdgeCount >= MAX_PHANTOM_EDGES) {
      console.log(`[pipeline] phantoms: skipping ${parentNodeId} — global budget exhausted (${phantomEdgeCount}/${MAX_PHANTOM_EDGES})`);
      return;
    }

    const sources = classification.unlinkedSources.slice(0, MAX_PHANTOM_PER_PARENT);
    console.log(
      `[pipeline] phantoms: processing ${sources.length}/${classification.unlinkedSources.length} unlinked sources for ${parentNodeId} (depth=${depth}, budget=${phantomEdgeCount}/${MAX_PHANTOM_EDGES})`,
    );

    let analyzed = 0;
    let skipped = 0;

    const tasks = sources.map((unlinked) =>
      limit(async () => {
        const key = unlinked.canonicalKey;
        if (!key) return;

        if (phantomEdgeCount >= MAX_PHANTOM_EDGES) {
          skipped++;
          return;
        }

        let phantomNodeId: string;
        const existing = phantomByKey.get(key);

        if (existing) {
          phantomNodeId = existing.nodeId;
        } else {
          phantomCounter++;
          phantomNodeId = `p-${phantomCounter}`;
          const phantomNode: SourceNode = {
            id: phantomNodeId,
            title: unlinked.description,
            url: null,
            publisher: unlinked.publisher,
            date: unlinked.date,
            sourceType: unlinked.sourceType,
            snippet: "",
            phantom: true,
            phantomKey: key,
            attributedClaims: [],
          };
          nodes.push(phantomNode);
          phantomByKey.set(key, { nodeId: phantomNodeId, claims: [] });
        }

        const edgePairKey = `${parentNodeId}-${phantomNodeId}`;
        if (phantomEdgesProcessed.has(edgePairKey)) {
          skipped++;
          return;
        }
        phantomEdgeCount++;
        phantomEdgesProcessed.add(edgePairKey);

        // Analyze the phantom edge
        const edgeLabel = `${phantomNodeId}→${parentNodeId}`;
        const phantomResult = await analyzePhantomEdge(
          parentMarkdown,
          unlinked.description,
          edgeLabel,
        );
        analyzed++;

        const edgeId = `${parentNodeId}-${phantomNodeId}`;
        edges.push({
          id: edgeId,
          source: phantomNodeId,
          target: parentNodeId,
          metrics: {
            sourceFidelity: phantomResult.sourceFidelity,
            editorialization: phantomResult.editorialization,
            sourceType: unlinked.sourceType,
            corroboration: phantomResult.corroboration,
          },
          concerns: phantomResult.concerns,
        });

        // Accumulate attributed claims on the phantom node
        const entry = phantomByKey.get(key)!;
        entry.claims.push(...phantomResult.attributedClaims);

        const phantomNode = nodes.find((n) => n.id === phantomNodeId);
        if (phantomNode) {
          phantomNode.attributedClaims = [...entry.claims];
          phantomNode.snippet =
            entry.claims.slice(0, 2).join("; ").slice(0, 200) || phantomNode.snippet;
        }
      }),
    );

    await Promise.all(tasks);
    console.log(
      `[pipeline] phantoms: ${parentNodeId} done — ${analyzed} analyzed, ${skipped} skipped (total budget: ${phantomEdgeCount}/${MAX_PHANTOM_EDGES})`,
    );
  }

  /**
   * Merge nodeB into nodeA: redirect all edges, combine claims, remove nodeB.
   */
  function mergeNodes(keepId: string, removeId: string): void {
    console.log(`[pipeline] merging ${removeId} → ${keepId}`);

    // Redirect edges
    for (const edge of edges) {
      if (edge.source === removeId) edge.source = keepId;
      if (edge.target === removeId) edge.target = keepId;
    }

    // Remove duplicate self-edges that may result from merge
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].source === keepId && edges[i].target === keepId) {
        edges.splice(i, 1);
      }
    }

    // Copy attributed claims
    const keepNode = nodes.find((n) => n.id === keepId);
    const removeNode = nodes.find((n) => n.id === removeId);
    if (keepNode && removeNode?.attributedClaims?.length) {
      keepNode.attributedClaims = [
        ...(keepNode.attributedClaims ?? []),
        ...removeNode.attributedClaims,
      ];
    }

    // Merge KG claim sets and re-index entities
    const removeClaims = claimsByNode.get(removeId);
    if (removeClaims) {
      const keepClaims = claimsByNode.get(keepId) ?? [];
      keepClaims.push(...removeClaims);
      claimsByNode.set(keepId, keepClaims);
      claimsByNode.delete(removeId);
      // Re-index: point entity references from removeId to keepId
      for (const [, nodeSet] of entityIndex) {
        if (nodeSet.has(removeId)) {
          nodeSet.delete(removeId);
          nodeSet.add(keepId);
        }
      }
    }

    // Remove duplicate node
    const idx = nodes.findIndex((n) => n.id === removeId);
    if (idx !== -1) nodes.splice(idx, 1);
  }

  // -----------------------------------------------------------------------
  // Step 5: Consolidation pass — merge duplicate nodes
  // -----------------------------------------------------------------------
  console.log(`[pipeline] step 5: consolidation pass`);

  // 5a. Real↔real: merge nodes whose content is the same article
  //     (e.g., wire story republished on multiple outlets)
  const realNodes = nodes.filter((n) => !n.phantom && !n.unscrapable && n.id !== "article");
  const fingerprints = new Map<string, Set<string>>();
  for (const node of realNodes) {
    const data = [...nodeByUrl.values()].find((d) => d.nodeId === node.id);
    if (data?.markdown) {
      fingerprints.set(node.id, contentShingles(data.markdown));
    }
  }

  const mergedAwayReal = new Set<string>();
  for (let i = 0; i < realNodes.length; i++) {
    if (mergedAwayReal.has(realNodes[i].id)) continue;
    const fpA = fingerprints.get(realNodes[i].id);
    if (!fpA || fpA.size === 0) continue;

    for (let j = i + 1; j < realNodes.length; j++) {
      if (mergedAwayReal.has(realNodes[j].id)) continue;
      const fpB = fingerprints.get(realNodes[j].id);
      if (!fpB || fpB.size === 0) continue;

      const sim = jaccardSimilarity(fpA, fpB);
      if (sim >= 0.5) {
        console.log(
          `[pipeline] consolidate: real↔real merge (similarity=${sim.toFixed(2)}): "${realNodes[j].title}" → "${realNodes[i].title}"`,
        );
        mergeNodes(realNodes[i].id, realNodes[j].id);
        mergedAwayReal.add(realNodes[j].id);
      }
    }
  }

  // 5b. Phantom↔phantom: merge phantoms with high description overlap
  const phantomNodes = nodes.filter((n) => n.phantom);
  const mergedAwayPhantom = new Set<string>();
  for (let i = 0; i < phantomNodes.length; i++) {
    if (mergedAwayPhantom.has(phantomNodes[i].id)) continue;
    const wordsA = extractContentWords(`${phantomNodes[i].title} ${phantomNodes[i].publisher}`);
    if (wordsA.size < 2) continue;

    for (let j = i + 1; j < phantomNodes.length; j++) {
      if (mergedAwayPhantom.has(phantomNodes[j].id)) continue;
      const wordsB = extractContentWords(`${phantomNodes[j].title} ${phantomNodes[j].publisher}`);
      if (wordsB.size < 2) continue;

      const sim = jaccardSimilarity(wordsA, wordsB);
      if (sim >= 0.4) {
        console.log(
          `[pipeline] consolidate: phantom↔phantom merge (similarity=${sim.toFixed(2)}): "${phantomNodes[j].title}" → "${phantomNodes[i].title}"`,
        );
        mergeNodes(phantomNodes[i].id, phantomNodes[j].id);
        mergedAwayPhantom.add(phantomNodes[j].id);
      }
    }
  }

  // 5c. Phantom→real: use LLM to match remaining phantoms to real nodes
  //     Exclude data-source nodes — a phantom describing a specific document
  //     should never merge into a generic category/knowledge-base page.
  const remainingPhantoms = nodes.filter((n) => n.phantom);
  const remainingReals = nodes.filter(
    (n) => !n.phantom && !n.unscrapable && n.id !== "article" && n.sourceType !== "data-source",
  );
  const matchCandidates: NodeMatchCandidate[] = [];
  for (const phantom of remainingPhantoms) {
    for (const real of remainingReals) {
      matchCandidates.push({
        phantomId: phantom.id,
        phantomDescription: phantom.title,
        realId: real.id,
        realTitle: real.title,
        realPublisher: real.publisher,
      });
    }
  }

  if (matchCandidates.length > 0) {
    // Cap at 50 pairs per LLM call to keep prompt reasonable
    const capped = matchCandidates.slice(0, 50);
    const matchResults = await matchPhantomsToReals(capped);
    const mergedPhantoms = new Set<string>();
    for (const result of matchResults) {
      if (result.match && !mergedPhantoms.has(result.phantomId)) {
        const phantom = nodes.find((n) => n.id === result.phantomId);
        const real = nodes.find((n) => n.id === result.realId);
        if (phantom && real) {
          console.log(
            `[pipeline] consolidate: phantom→real merge (LLM): "${phantom.title}" → "${real.title}"`,
          );
          mergeNodes(result.realId, result.phantomId);
          mergedPhantoms.add(result.phantomId);
        }
      }
    }
  }

  // Deduplicate edges that now share the same source→target after merges
  const edgeKeys = new Set<string>();
  for (let i = edges.length - 1; i >= 0; i--) {
    const key = `${edges[i].source}->${edges[i].target}`;
    if (edgeKeys.has(key)) {
      edges.splice(i, 1);
    } else {
      edgeKeys.add(key);
    }
  }

  console.log(
    `[pipeline] consolidation done: ${mergedAwayReal.size} real merges, ${mergedAwayPhantom.size} phantom merges, ${nodes.length} nodes, ${edges.length} edges`,
  );

  // -----------------------------------------------------------------------
  // Step 6: Prune noise nodes
  // -----------------------------------------------------------------------
  // Remove non-root scraped nodes where every edge has low fidelity and no
  // corroboration — these are likely "related articles" sidebar links, not
  // actual epistemic sources.
  const prunedNodeIds = new Set<string>();
  for (const node of nodes) {
    if (node.id === "article" || node.phantom) continue;
    const nodeEdges = edges.filter(
      (e) => e.source === node.id || e.target === node.id,
    );
    if (nodeEdges.length === 0) {
      prunedNodeIds.add(node.id);
      continue;
    }
    const hasRelevantEdge = nodeEdges.some(
      (e) =>
        e.metrics.sourceFidelity >= MIN_EDGE_RELEVANCE ||
        e.metrics.corroboration !== "none",
    );
    if (!hasRelevantEdge) {
      prunedNodeIds.add(node.id);
    }
  }

  if (prunedNodeIds.size > 0) {
    console.log(
      `[pipeline] pruning ${prunedNodeIds.size} noise nodes: ${[...prunedNodeIds].join(", ")}`,
    );
  }

  const finalNodes = nodes.filter((n) => !prunedNodeIds.has(n.id));
  const finalEdges = edges.filter(
    (e) => !prunedNodeIds.has(e.source) && !prunedNodeIds.has(e.target),
  );

  // -----------------------------------------------------------------------
  // Step 7: Build result
  // -----------------------------------------------------------------------

  // Build claims record for API response (without embeddings/triples)
  const claimsRecord: Record<string, Claim[]> = {};
  for (const [nodeId, extractedClaims] of claimsByNode) {
    if (prunedNodeIds.has(nodeId)) continue;
    claimsRecord[nodeId] = extractedClaims.map((c) => ({
      claim: c.claim,
      entities: c.entities,
      attribution: c.attribution,
    }));
  }

  console.log(
    `[pipeline] DONE (${Date.now() - pipelineStart}ms): ${finalNodes.length} nodes (${prunedNodeIds.size} pruned), ${finalEdges.length} edges, ${Object.keys(claimsRecord).length} nodes with claims`,
  );

  return {
    result: {
      article: {
        title: rootNode.title,
        url: articleUrl,
        publisher: rootNode.publisher,
        date: rootNode.date,
        snippet: rootNode.snippet,
      },
      nodes: finalNodes,
      edges: finalEdges,
      claims: claimsRecord,
    },
    claimData: claimsByNode,
  };

  // -----------------------------------------------------------------------
  // Knowledge Graph Helpers (closures over claimsByNode/entityIndex)
  // -----------------------------------------------------------------------

  function indexEntities(nodeId: string, extracted: ExtractedClaim[]): void {
    for (const claim of extracted) {
      for (const entity of claim.entities) {
        const key = entity.toLowerCase();
        const set = entityIndex.get(key) ?? new Set();
        set.add(nodeId);
        entityIndex.set(key, set);
      }
      for (const triple of claim.triples) {
        for (const name of [triple.subject, triple.object]) {
          const key = name.toLowerCase();
          const set = entityIndex.get(key) ?? new Set();
          set.add(nodeId);
          entityIndex.set(key, set);
        }
      }
    }
  }

  function computeCorroboration(nodeA: string, nodeB: string): Corroboration {
    const claimsA = claimsByNode.get(nodeA);
    const claimsB = claimsByNode.get(nodeB);

    if (!claimsA?.length || !claimsB?.length) return "unverified";

    const triplesA = claimsA.flatMap((c) => c.triples);
    const triplesB = claimsB.flatMap((c) => c.triples);

    // Find shared entity pairs (both subject AND object match between the two nodes)
    let matchedEntityPairs = 0;
    const checkedPairs = new Set<string>();

    for (const tA of triplesA) {
      const subA = tA.subject.toLowerCase();
      const objA = tA.object.toLowerCase();
      const pairKey = `${subA}::${objA}`;
      if (checkedPairs.has(pairKey)) continue;
      checkedPairs.add(pairKey);

      const hasMatch = triplesB.some((tB) => {
        const subB = tB.subject.toLowerCase();
        const objB = tB.object.toLowerCase();
        return (subA === subB && objA === objB) || (subA === objB && objA === subB);
      });

      if (hasMatch) matchedEntityPairs++;
    }

    if (matchedEntityPairs >= 2) return "strong";
    if (matchedEntityPairs >= 1) return "partial";

    // Fallback: check claim embeddings for semantic similarity
    const SIMILARITY_THRESHOLD = 0.85;
    for (const cA of claimsA) {
      if (!cA.embedding || cA.embedding.every((v) => v === 0)) continue;
      for (const cB of claimsB) {
        if (!cB.embedding || cB.embedding.every((v) => v === 0)) continue;
        const sim = cosineSimilarity(cA.embedding, cB.embedding);
        if (sim >= SIMILARITY_THRESHOLD) {
          console.log(
            `[pipeline] embedding fallback: ${nodeA}↔${nodeB} sim=${sim.toFixed(3)} → partial`,
          );
          return "partial";
        }
      }
    }

    return "none";
  }

  /**
   * Build KG context for analyzeEdge: shared entity pairs with their
   * predicates from each node, plus a temporal note if dates are available.
   */
  function buildEdgeKGContext(
    sourceNodeId: string,
    downstreamNodeId: string,
    sourceDate: string,
    downstreamDate: string,
  ): EdgeKGContext | undefined {
    const claimsA = claimsByNode.get(sourceNodeId);
    const claimsB = claimsByNode.get(downstreamNodeId);
    if (!claimsA?.length || !claimsB?.length) return undefined;

    const triplesA = claimsA.flatMap((c) => c.triples);
    const triplesB = claimsB.flatMap((c) => c.triples);
    if (triplesA.length === 0 || triplesB.length === 0) return undefined;

    // Index triples by entity pair for each node
    type PairEntry = { predicates: Set<string> };
    const indexTriples = (triples: typeof triplesA) => {
      const map = new Map<string, PairEntry>();
      for (const t of triples) {
        const key = [t.subject.toLowerCase(), t.object.toLowerCase()].sort().join("::");
        const entry = map.get(key) ?? { predicates: new Set() };
        entry.predicates.add(t.predicate);
        map.set(key, entry);
      }
      return map;
    };

    const indexA = indexTriples(triplesA);
    const indexB = indexTriples(triplesB);

    const sharedTriples: EdgeKGContext["sharedTriples"] = [];
    for (const [pairKey, entryA] of indexA) {
      const entryB = indexB.get(pairKey);
      if (!entryB) continue;
      const [sub, obj] = pairKey.split("::");
      sharedTriples.push({
        subject: sub,
        object: obj,
        sourcePredicates: [...entryA.predicates],
        downstreamPredicates: [...entryB.predicates],
      });
    }

    if (sharedTriples.length === 0) return undefined;

    // Compute temporal note
    let temporalNote: string | undefined;
    if (sourceDate && downstreamDate) {
      const srcMs = Date.parse(sourceDate);
      const dstMs = Date.parse(downstreamDate);
      if (!isNaN(srcMs) && !isNaN(dstMs)) {
        const diffDays = Math.round((dstMs - srcMs) / (1000 * 60 * 60 * 24));
        if (diffDays > 14) {
          const diffWeeks = Math.round(diffDays / 7);
          const diffMonths = Math.round(diffDays / 30);
          const gap = diffMonths >= 2
            ? `~${diffMonths} months`
            : `~${diffWeeks} weeks`;
          temporalNote = `Note: Source is ${gap} older than downstream. Divergences in predicates may reflect events that occurred after the source was published.`;
        } else if (diffDays < -14) {
          const gap = Math.round(Math.abs(diffDays) / 7);
          temporalNote = `Note: Source is ~${gap} weeks NEWER than downstream.`;
        }
      }
    }

    return { sharedTriples: sharedTriples.slice(0, 10), temporalNote };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Candidate {
  url: string;
  priority: number;
}

/**
 * Only LLM-identified sourceUrls become candidates.
 * The LLM has already filtered the link list for epistemic relevance.
 */
const STOP_WORDS = new Set([
  // articles, conjunctions, prepositions
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "if", "so", "up", "out", "about",
  "into", "over", "after", "before", "between", "through", "during",
  "without", "within", "along", "across", "than", "while", "since", "until",
  // pronouns
  "it", "its", "he", "she", "his", "her", "they", "them", "their", "we",
  "our", "you", "your", "who", "what", "which", "whom", "whose", "how",
  "this", "that", "these", "those",
  // common verbs
  "is", "was", "are", "were", "be", "been", "being", "has", "had", "have",
  "do", "did", "does", "can", "could", "will", "would", "shall", "should",
  "may", "might", "must", "get", "got", "make", "made", "take", "took",
  "say", "said", "says", "told", "tell", "think", "know", "see", "come",
  "want", "use", "used", "find", "give", "also", "just", "more", "most",
  "not", "no", "now", "way", "very", "when", "well", "then",
  // web/UI chrome
  "home", "menu", "search", "login", "sign", "subscribe", "newsletter",
  "cookie", "cookies", "privacy", "terms", "contact", "share", "follow",
  "click", "read", "view", "show", "close", "open", "next", "previous",
  "page", "site", "link", "links", "comment", "comments", "reply",
  // journalism boilerplate
  "new", "news", "report", "reports", "reported", "reporting", "article",
  "story", "stories", "update", "updated", "source", "sources", "according",
  "press", "media", "editor", "published", "wrote", "writing",
  // time words
  "today", "yesterday", "tomorrow", "week", "month", "year", "time",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "june", "july", "august",
  "september", "october", "november", "december",
  // generic nouns
  "people", "company", "companies", "world", "part", "number", "first",
  "last", "long", "great", "little", "own", "other", "old", "right",
  "big", "high", "different", "small", "large", "early", "young",
  "important", "few", "public", "bad", "same", "able",
  // misc
  "s", "t", "don", "doesn", "didn", "isn", "wasn", "aren", "won",
]);

function extractContentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function gatherCandidates(
  llmSourceUrls: string[],
  parentNodeId: string,
  visited: Set<string>,
  parentMap: Map<string, Set<string>>,
  priority = 100,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const url of llmSourceUrls) {
    if (!isAnalyzableUrl(url)) continue;

    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) {
      const existing = parentMap.get(normalized);
      if (existing) existing.add(parentNodeId);
      continue;
    }

    visited.add(normalized);

    const parents = parentMap.get(normalized) ?? new Set();
    parents.add(parentNodeId);
    parentMap.set(normalized, parents);

    candidates.push({ url, priority });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Content chunking for incremental KG construction
// ---------------------------------------------------------------------------

const CHUNK_TARGET = 3_000;  // chars per chunk
const CHUNK_OVERLAP = 200;   // overlap between consecutive chunks for context
const CHUNK_THRESHOLD = 4_000; // don't bother chunking below this

/**
 * Split markdown into passages at paragraph boundaries (~3K each).
 * Returns the original text as a single-element array if below threshold.
 */
function chunkMarkdown(markdown: string): string[] {
  if (markdown.length <= CHUNK_THRESHOLD) return [markdown];

  const paragraphs = markdown.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length > CHUNK_TARGET && current.length > 0) {
      chunks.push(current.trim());
      // Keep tail of previous chunk as overlap for context
      const overlap = current.slice(-CHUNK_OVERLAP);
      current = overlap + "\n\n" + para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Extract claims from a document by chunking and building triples
 * incrementally. Each chunk gets its own fast extractClaims call;
 * results are merged and deduplicated before embedding.
 */
async function extractClaimsChunked(
  markdown: string,
  title: string,
): Promise<ExtractedClaim[]> {
  const chunks = chunkMarkdown(markdown);

  if (chunks.length <= 1) {
    // Small document — single call, no chunking needed
    const raw = await extractClaims(markdown, title);
    const embeddings = await embedClaims(raw.map((c) => c.claim));
    return raw.map((c, i) => ({ ...c, embedding: embeddings[i] }));
  }

  console.log(`[pipeline] chunked extraction: ${chunks.length} chunks from ${markdown.length} chars`);

  // Extract claims from each chunk sequentially (within the same concurrency slot)
  const allRaw: Omit<ExtractedClaim, "embedding">[] = [];
  const seenClaims = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    const chunkClaims = await extractClaims(chunks[i], `${title} [part ${i + 1}/${chunks.length}]`);
    for (const claim of chunkClaims) {
      // Deduplicate claims that appear in overlapping regions
      const key = claim.claim.toLowerCase().slice(0, 80);
      if (!seenClaims.has(key)) {
        seenClaims.add(key);
        allRaw.push(claim);
      }
    }
  }

  // Batch embed all claims at once
  const embeddings = await embedClaims(allRaw.map((c) => c.claim));
  return allRaw.map((c, i) => ({ ...c, embedding: embeddings[i] }));
}

/**
 * Extract URLs that are hyperlinked inline in the article markdown.
 * Returns {url, anchorText} pairs so callers can filter by relevance.
 */
function extractInlineLinks(markdown: string): { url: string; anchor: string }[] {
  const links: { url: string; anchor: string }[] = [];
  const seen = new Set<string>();
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(markdown)) !== null) {
    const url = m[2];
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ url, anchor: m[1] });
    }
  }
  return links;
}

/**
 * Filter inline links to only those whose anchor text mentions a claim entity.
 * This prevents nav/sidebar links from flooding the candidate pool.
 */
function filterInlineLinksByEntities(
  links: { url: string; anchor: string }[],
  entities: Set<string>,
): string[] {
  return links
    .filter((link) => {
      const anchorLower = link.anchor.toLowerCase();
      return [...entities].some((entity) => anchorLower.includes(entity));
    })
    .map((link) => link.url);
}

// ---------------------------------------------------------------------------
// Content fingerprinting for same-article detection
// ---------------------------------------------------------------------------

/** Build a set of 3-word shingles from the first ~2000 words of content. */
function contentShingles(markdown: string): Set<string> {
  const words = markdown
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const shingles = new Set<string>();
  const limit = Math.min(words.length - 2, 2000);
  for (let i = 0; i < limit; i++) {
    shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return shingles;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const x of smaller) {
    if (larger.has(x)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Link-heavy page detection (category indexes, video listings, tag pages)
// ---------------------------------------------------------------------------

/**
 * Returns true if the page is mostly links — e.g. a category index, video
 * listing, or tag page. Splits the markdown by link patterns and checks
 * whether any substantial prose block exists. Real articles always have
 * at least one paragraph of continuous text between links; index pages
 * have only short fragments.
 */
function isLinkHeavy(markdown: string): boolean {
  // Split on markdown links — the chunks between them are prose fragments.
  const chunks = markdown.split(/\[[^\]]*\]\([^)]*\)/);
  const longestProse = Math.max(0, ...chunks.map((c) => c.trim().length));
  // If no prose block reaches 200 chars, the page is all links and chrome.
  return longestProse < 200;
}

// ---------------------------------------------------------------------------
// Knowledge base / reference page detection
// ---------------------------------------------------------------------------

const KB_URL_PATTERNS = [
  /\/wiki\//i,
  /\/help\//i,
  /\/faq/i,
  /\/docs?\//i,
  /\/reference\//i,
  /\/glossary/i,
  /\/about\//i,
  /\/guide\//i,
  /wikipedia\.org/i,
  /wikimedia\.org/i,
  /britannica\.com/i,
  /investopedia\.com/i,
];

// ---------------------------------------------------------------------------
// Product / marketing page detection
// ---------------------------------------------------------------------------

const PRODUCT_URL_PATTERNS = [
  /\/(pricing|plans|features|product|solutions|enterprise|platform|demo|tour)\b/i,
  /\/(download|install|get-started|signup|sign-up)\b/i,
];

const PRODUCT_CTA_PATTERNS = [
  /get started/i,
  /try .{0,10}free/i,
  /sign up/i,
  /start .{0,10}(free )?trial/i,
  /book a demo/i,
  /contact sales/i,
  /request .{0,5}demo/i,
  /download now/i,
  /\bpric(e|ing)\b/i,
  /\bper month\b/i,
  /\bfree tier\b/i,
  /\bapi key\b/i,
  /\binstall\b.*\b(npm|pip|brew|curl)\b/i,
];

const JOURNALISTIC_MARKERS = [
  /\bsaid\b/,
  /\baccording to\b/,
  /\breported(ly)?\b/,
  /\bsources?\b.{0,20}\b(say|told|confirm)/,
  /\balleged(ly)?\b/,
  /\bannounced\b.{0,30}\b(today|yesterday|monday|tuesday|wednesday|thursday|friday)/i,
];

/**
 * Returns true if the page is a product/marketing page rather than an article
 * or editorial. Product pages are epistemically irrelevant — they don't
 * corroborate or contradict news claims, they're marketing material.
 *
 * Signals: marketing CTAs, absence of journalistic markers, feature-list
 * structure (many headings, short prose blocks).
 */
function isProductPage(url: string, title: string, markdown: string): boolean {
  // Strong URL signals
  if (PRODUCT_URL_PATTERNS.some((p) => p.test(url))) return true;

  const text = markdown.slice(0, 4000).toLowerCase();

  // Count CTA signals
  let ctaCount = 0;
  for (const pattern of PRODUCT_CTA_PATTERNS) {
    if (pattern.test(text)) ctaCount++;
  }

  // Count journalistic markers
  let journoCount = 0;
  for (const pattern of JOURNALISTIC_MARKERS) {
    if (pattern.test(text)) journoCount++;
  }

  // High CTA density + no journalism = product page
  if (ctaCount >= 3 && journoCount === 0) return true;

  // Heading-heavy with short prose = feature list / marketing page
  const headingCount = (markdown.match(/^#{1,3}\s/gm) || []).length;
  const wordCount = markdown.split(/\s+/).length;
  // More than 1 heading per 80 words with no journalistic markers
  if (headingCount >= 6 && wordCount / headingCount < 80 && journoCount === 0) return true;

  return false;
}

function isKnowledgeBase(url: string, title: string, markdown: string): boolean {
  // URL pattern match
  if (KB_URL_PATTERNS.some((p) => p.test(url))) return true;

  // Content heuristic: very long with no date signals and encyclopedic tone
  // Check first 500 chars for date-like patterns
  const head = markdown.slice(0, 500);
  const hasDate = /\b20\d{2}[-/]\d{2}[-/]\d{2}\b/.test(head) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i.test(head);
  const titleLower = title.toLowerCase();
  const genericTitleSignals = [
    "what is", "how to", "definition", "overview", "guide to",
    "explained", "understanding", "introduction to", "basics of",
  ];
  if (!hasDate && genericTitleSignals.some((s) => titleLower.includes(s))) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Unscrapable content helpers
// ---------------------------------------------------------------------------

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    // Extract last meaningful path segment
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      return segments[segments.length - 1]
        .replace(/[-_]/g, " ")
        .replace(/\.\w+$/, "")
        .slice(0, 100);
    }
    return u.hostname;
  } catch {
    return url.slice(0, 80);
  }
}

function publisherFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
