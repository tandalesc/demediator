import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const sourceTypeEnum = pgEnum("source_type", [
  "primary-study",
  "press-release",
  "wire-service",
  "secondary-reporting",
  "opinion",
  "official-statement",
  "data-source",
  "interview",
]);

export const corroborationEnum = pgEnum("corroboration", [
  "strong",
  "partial",
  "none",
  "unverified",
]);

export const entityTypeEnum = pgEnum("entity_type", [
  "person",
  "organization",
  "place",
  "event",
  "document",
  "concept",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const analyses = pgTable("analyses", {
  id: uuid().defaultRandom().primaryKey(),
  articleUrl: text("article_url").notNull().unique(),
  articleTitle: text("article_title").notNull(),
  articlePublisher: text("article_publisher").notNull(),
  articleDate: text("article_date").notNull(),
  articleSnippet: text("article_snippet").notNull(),
  summaryText: text("summary_text"),
  summaryFidelity: real("summary_fidelity"),
  summaryConcernCount: integer("summary_concern_count"),
  summaryStrongCorroboration: integer("summary_strong_corroboration"),
  summaryWeakCorroboration: integer("summary_weak_corroboration"),
  summaryUnverifiedClaims: text("summary_unverified_claims"),  // JSON array
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const sourceNodes = pgTable(
  "source_nodes",
  {
    id: uuid().defaultRandom().primaryKey(),
    nodeId: varchar("node_id").notNull(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => analyses.id, { onDelete: "cascade" }),
    title: text().notNull(),
    url: text(),
    publisher: text().notNull(),
    date: text().notNull(),
    sourceType: sourceTypeEnum("source_type").notNull(),
    snippet: text().notNull(),
    phantom: boolean().default(false).notNull(),
    phantomKey: varchar("phantom_key"),
  },
  (t) => [uniqueIndex("uq_node").on(t.analysisId, t.nodeId)],
);

export const sourceEdges = pgTable(
  "source_edges",
  {
    id: uuid().defaultRandom().primaryKey(),
    edgeId: varchar("edge_id").notNull(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => analyses.id, { onDelete: "cascade" }),
    sourceNodeId: varchar("source_node_id").notNull(),
    targetNodeId: varchar("target_node_id").notNull(),
    sourceFidelity: real("source_fidelity").notNull(),
    editorialization: real().notNull(),
    metricSourceType: sourceTypeEnum("metric_source_type").notNull(),
    corroboration: corroborationEnum().notNull(),
  },
  (t) => [uniqueIndex("uq_edge").on(t.analysisId, t.edgeId)],
);

export const edgeConcerns = pgTable("edge_concerns", {
  id: uuid().defaultRandom().primaryKey(),
  edgeId: uuid("edge_id")
    .notNull()
    .references(() => sourceEdges.id, { onDelete: "cascade" }),
  concern: text().notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const phantomClaims = pgTable("phantom_claims", {
  id: uuid().defaultRandom().primaryKey(),
  nodeId: uuid("node_id")
    .notNull()
    .references(() => sourceNodes.id, { onDelete: "cascade" }),
  edgeId: uuid("edge_id")
    .notNull()
    .references(() => sourceEdges.id, { onDelete: "cascade" }),
  claim: text().notNull(),
  sortOrder: integer("sort_order").notNull(),
});

// ---------------------------------------------------------------------------
// Knowledge Graph Tables
// ---------------------------------------------------------------------------

export const entities = pgTable(
  "entities",
  {
    id: uuid().defaultRandom().primaryKey(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => analyses.id, { onDelete: "cascade" }),
    canonicalName: text("canonical_name").notNull(),
    entityType: entityTypeEnum("entity_type").notNull(),
  },
  (t) => [uniqueIndex("uq_entity").on(t.analysisId, t.canonicalName)],
);

export const claims = pgTable("claims", {
  id: uuid().defaultRandom().primaryKey(),
  analysisId: uuid("analysis_id")
    .notNull()
    .references(() => analyses.id, { onDelete: "cascade" }),
  sourceNodeId: varchar("source_node_id").notNull(),
  claimText: text("claim_text").notNull(),
  attribution: text().notNull(),
  embedding: vector({ dimensions: 768 }),
});

export const claimTriples = pgTable("claim_triples", {
  id: uuid().defaultRandom().primaryKey(),
  claimId: uuid("claim_id")
    .notNull()
    .references(() => claims.id, { onDelete: "cascade" }),
  subjectId: uuid("subject_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  predicate: text().notNull(),
  objectId: uuid("object_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  context: text(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const analysesRelations = relations(analyses, ({ many }) => ({
  nodes: many(sourceNodes),
  edges: many(sourceEdges),
  entities: many(entities),
  claims: many(claims),
}));

export const sourceNodesRelations = relations(sourceNodes, ({ one, many }) => ({
  analysis: one(analyses, {
    fields: [sourceNodes.analysisId],
    references: [analyses.id],
  }),
  phantomClaims: many(phantomClaims),
}));

export const sourceEdgesRelations = relations(sourceEdges, ({ one, many }) => ({
  analysis: one(analyses, {
    fields: [sourceEdges.analysisId],
    references: [analyses.id],
  }),
  concerns: many(edgeConcerns),
}));

export const edgeConcernsRelations = relations(edgeConcerns, ({ one }) => ({
  edge: one(sourceEdges, {
    fields: [edgeConcerns.edgeId],
    references: [sourceEdges.id],
  }),
}));

export const phantomClaimsRelations = relations(phantomClaims, ({ one }) => ({
  node: one(sourceNodes, {
    fields: [phantomClaims.nodeId],
    references: [sourceNodes.id],
  }),
  edge: one(sourceEdges, {
    fields: [phantomClaims.edgeId],
    references: [sourceEdges.id],
  }),
}));

export const entitiesRelations = relations(entities, ({ one, many }) => ({
  analysis: one(analyses, {
    fields: [entities.analysisId],
    references: [analyses.id],
  }),
  subjectTriples: many(claimTriples, { relationName: "subject" }),
  objectTriples: many(claimTriples, { relationName: "object" }),
}));

export const claimsRelations = relations(claims, ({ one, many }) => ({
  analysis: one(analyses, {
    fields: [claims.analysisId],
    references: [analyses.id],
  }),
  triples: many(claimTriples),
}));

export const claimTriplesRelations = relations(claimTriples, ({ one }) => ({
  claim: one(claims, {
    fields: [claimTriples.claimId],
    references: [claims.id],
  }),
  subject: one(entities, {
    fields: [claimTriples.subjectId],
    references: [entities.id],
    relationName: "subject",
  }),
  object: one(entities, {
    fields: [claimTriples.objectId],
    references: [entities.id],
    relationName: "object",
  }),
}));
