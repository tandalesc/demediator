import { eq } from "drizzle-orm";
import { db } from ".";
import {
  analyses,
  claims,
  claimTriples,
  edgeConcerns,
  entities,
  phantomClaims,
  sourceEdges,
  sourceNodes,
} from "./schema";
import type { AnalysisResult, ExtractedClaim } from "../types";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getAnalysisByUrl(
  url: string,
): Promise<AnalysisResult | null> {
  const row = await db.query.analyses.findFirst({
    where: eq(analyses.articleUrl, url),
    with: {
      nodes: {
        with: { phantomClaims: { orderBy: (c, { asc }) => [asc(c.sortOrder)] } },
      },
      edges: {
        with: { concerns: { orderBy: (c, { asc }) => [asc(c.sortOrder)] } },
      },
      claims: true,
    },
  });

  if (!row) return null;

  // Group claims by source node ID (without embeddings)
  const claimsRecord: Record<string, { claim: string; entities: string[]; attribution: string }[]> = {};
  for (const c of row.claims) {
    const nodeId = c.sourceNodeId;
    if (!claimsRecord[nodeId]) claimsRecord[nodeId] = [];
    // Parse entities from claim text is not needed — we stored them in the entities table.
    // For the API response, we return the claim text and attribution only.
    claimsRecord[nodeId].push({
      claim: c.claimText,
      entities: [],  // entities are in the KG, not duplicated in API response
      attribution: c.attribution,
    });
  }

  return {
    article: {
      title: row.articleTitle,
      url: row.articleUrl,
      publisher: row.articlePublisher,
      date: row.articleDate,
      snippet: row.articleSnippet,
    },
    nodes: row.nodes.map((n) => ({
      id: n.nodeId,
      title: n.title,
      url: n.url,
      publisher: n.publisher,
      date: n.date,
      sourceType: n.sourceType,
      snippet: n.snippet,
      ...(n.phantom && {
        phantom: true,
        phantomKey: n.phantomKey ?? undefined,
        attributedClaims: n.phantomClaims.map((c) => c.claim),
      }),
    })),
    edges: row.edges.map((e) => ({
      id: e.edgeId,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      metrics: {
        sourceFidelity: e.sourceFidelity,
        editorialization: e.editorialization,
        sourceType: e.metricSourceType,
        corroboration: e.corroboration,
      },
      concerns: e.concerns.map((c) => c.concern),
    })),
    claims: claimsRecord,
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function insertAnalysis(
  data: AnalysisResult,
  claimData?: Map<string, ExtractedClaim[]>,
): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Insert analysis
    const [analysis] = await tx
      .insert(analyses)
      .values({
        articleUrl: data.article.url,
        articleTitle: data.article.title,
        articlePublisher: data.article.publisher,
        articleDate: data.article.date,
        articleSnippet: data.article.snippet,
      })
      .returning({ id: analyses.id });

    // 2. Insert nodes
    const nodeDbIds = new Map<string, string>();
    if (data.nodes.length > 0) {
      const inserted = await tx
        .insert(sourceNodes)
        .values(
          data.nodes.map((n) => ({
            nodeId: n.id,
            analysisId: analysis.id,
            title: n.title,
            url: n.url,
            publisher: n.publisher,
            date: n.date,
            sourceType: n.sourceType,
            snippet: n.snippet,
            phantom: n.phantom ?? false,
            phantomKey: n.phantomKey ?? null,
          })),
        )
        .returning({ id: sourceNodes.id, nodeId: sourceNodes.nodeId });
      for (const row of inserted) {
        nodeDbIds.set(row.nodeId, row.id);
      }
    }

    // 3. Insert edges + concerns
    for (const e of data.edges) {
      const [edge] = await tx
        .insert(sourceEdges)
        .values({
          edgeId: e.id,
          analysisId: analysis.id,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          sourceFidelity: e.metrics.sourceFidelity,
          editorialization: e.metrics.editorialization,
          metricSourceType: e.metrics.sourceType,
          corroboration: e.metrics.corroboration,
        })
        .returning({ id: sourceEdges.id });

      if (e.concerns.length > 0) {
        await tx.insert(edgeConcerns).values(
          e.concerns.map((concern, i) => ({
            edgeId: edge.id,
            concern,
            sortOrder: i,
          })),
        );
      }

      // Insert phantom claims for the source node of this edge
      const sourceNode = data.nodes.find((n) => n.id === e.source);
      if (sourceNode?.phantom && sourceNode.attributedClaims?.length) {
        const nodeDbId = nodeDbIds.get(sourceNode.id);
        if (nodeDbId) {
          await tx.insert(phantomClaims).values(
            sourceNode.attributedClaims.map((claim, i) => ({
              nodeId: nodeDbId,
              edgeId: edge.id,
              claim,
              sortOrder: i,
            })),
          );
        }
      }
    }

    // 4. Insert knowledge graph data (entities, claims, triples)
    if (claimData && claimData.size > 0) {
      // Collect all unique entities across all claims
      const entityMap = new Map<string, { name: string; type: string }>();
      for (const [, extractedClaims] of claimData) {
        for (const ec of extractedClaims) {
          for (const triple of ec.triples) {
            const subKey = triple.subject.toLowerCase();
            if (!entityMap.has(subKey)) {
              entityMap.set(subKey, { name: triple.subject, type: triple.subjectType });
            }
            const objKey = triple.object.toLowerCase();
            if (!entityMap.has(objKey)) {
              entityMap.set(objKey, { name: triple.object, type: triple.objectType });
            }
          }
          // Also add entities from claim.entities that might not appear in triples
          for (const entityName of ec.entities) {
            const key = entityName.toLowerCase();
            if (!entityMap.has(key)) {
              entityMap.set(key, { name: entityName, type: "concept" });
            }
          }
        }
      }

      // Bulk insert entities
      const entityDbIds = new Map<string, string>(); // lowercase name → DB UUID
      if (entityMap.size > 0) {
        const entityValues = [...entityMap.values()].map((e) => ({
          analysisId: analysis.id,
          canonicalName: e.name,
          entityType: e.type as "person" | "organization" | "place" | "event" | "document" | "concept",
        }));
        const insertedEntities = await tx
          .insert(entities)
          .values(entityValues)
          .returning({ id: entities.id, canonicalName: entities.canonicalName });
        for (const row of insertedEntities) {
          entityDbIds.set(row.canonicalName.toLowerCase(), row.id);
        }
      }

      // Insert claims with embeddings, then triples
      for (const [nodeId, extractedClaims] of claimData) {
        for (const ec of extractedClaims) {
          const [insertedClaim] = await tx
            .insert(claims)
            .values({
              analysisId: analysis.id,
              sourceNodeId: nodeId,
              claimText: ec.claim,
              attribution: ec.attribution,
              embedding: ec.embedding,
            })
            .returning({ id: claims.id });

          // Insert triples for this claim
          const tripleValues = ec.triples
            .map((t) => {
              const subjectId = entityDbIds.get(t.subject.toLowerCase());
              const objectId = entityDbIds.get(t.object.toLowerCase());
              if (!subjectId || !objectId) return null;
              return {
                claimId: insertedClaim.id,
                subjectId,
                predicate: t.predicate,
                objectId,
                context: t.context ?? null,
              };
            })
            .filter((v): v is NonNullable<typeof v> => v !== null);

          if (tripleValues.length > 0) {
            await tx.insert(claimTriples).values(tripleValues);
          }
        }
      }
    }
  });
}
