CREATE TYPE "public"."corroboration" AS ENUM('strong', 'partial', 'none', 'unverified');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('person', 'organization', 'place', 'event', 'document', 'concept');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('primary-study', 'press-release', 'wire-service', 'secondary-reporting', 'opinion', 'official-statement', 'data-source', 'interview');--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_url" text NOT NULL,
	"article_title" text NOT NULL,
	"article_publisher" text NOT NULL,
	"article_date" text NOT NULL,
	"article_snippet" text NOT NULL,
	"summary_text" text,
	"summary_fidelity" real,
	"summary_concern_count" integer,
	"summary_strong_corroboration" integer,
	"summary_weak_corroboration" integer,
	"summary_unverified_claims" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyses_article_url_unique" UNIQUE("article_url")
);
--> statement-breakpoint
CREATE TABLE "claim_triples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"predicate" text NOT NULL,
	"object_id" uuid NOT NULL,
	"context" text
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"source_node_id" varchar NOT NULL,
	"claim_text" text NOT NULL,
	"attribution" text NOT NULL,
	"embedding" vector(768)
);
--> statement-breakpoint
CREATE TABLE "edge_concerns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edge_id" uuid NOT NULL,
	"concern" text NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"canonical_name" text NOT NULL,
	"entity_type" "entity_type" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phantom_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"edge_id" uuid NOT NULL,
	"claim" text NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edge_id" varchar NOT NULL,
	"analysis_id" uuid NOT NULL,
	"source_node_id" varchar NOT NULL,
	"target_node_id" varchar NOT NULL,
	"source_fidelity" real NOT NULL,
	"editorialization" real NOT NULL,
	"metric_source_type" "source_type" NOT NULL,
	"corroboration" "corroboration" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" varchar NOT NULL,
	"analysis_id" uuid NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"publisher" text NOT NULL,
	"date" text NOT NULL,
	"source_type" "source_type" NOT NULL,
	"snippet" text NOT NULL,
	"phantom" boolean DEFAULT false NOT NULL,
	"phantom_key" varchar
);
--> statement-breakpoint
ALTER TABLE "claim_triples" ADD CONSTRAINT "claim_triples_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_triples" ADD CONSTRAINT "claim_triples_subject_id_entities_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_triples" ADD CONSTRAINT "claim_triples_object_id_entities_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_concerns" ADD CONSTRAINT "edge_concerns_edge_id_source_edges_id_fk" FOREIGN KEY ("edge_id") REFERENCES "public"."source_edges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phantom_claims" ADD CONSTRAINT "phantom_claims_node_id_source_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."source_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phantom_claims" ADD CONSTRAINT "phantom_claims_edge_id_source_edges_id_fk" FOREIGN KEY ("edge_id") REFERENCES "public"."source_edges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_edges" ADD CONSTRAINT "source_edges_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_nodes" ADD CONSTRAINT "source_nodes_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_entity" ON "entities" USING btree ("analysis_id","canonical_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_edge" ON "source_edges" USING btree ("analysis_id","edge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_node" ON "source_nodes" USING btree ("analysis_id","node_id");