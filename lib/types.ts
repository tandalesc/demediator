import type { sourceTypeEnum, corroborationEnum } from "./db/schema";

export type SourceType =
  | "primary-study"
  | "press-release"
  | "wire-service"
  | "secondary-reporting"
  | "opinion"
  | "official-statement"
  | "data-source"
  | "interview";

export type Corroboration = "strong" | "partial" | "none" | "unverified";

export type SeverityLevel = "low" | "medium" | "high";

// Compile-time assertions: app types ↔ DB enums stay in sync
type DbSourceType = (typeof sourceTypeEnum.enumValues)[number];
type DbCorroboration = (typeof corroborationEnum.enumValues)[number];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertSourceType = DbSourceType extends SourceType
  ? SourceType extends DbSourceType
    ? true
    : never
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertCorroboration = DbCorroboration extends Corroboration
  ? Corroboration extends DbCorroboration
    ? true
    : never
  : never;

export type EntityType = "person" | "organization" | "place" | "event" | "document" | "concept";

export interface Triple {
  subject: string;       // canonical entity name
  subjectType: EntityType;
  predicate: string;     // normalized verb
  object: string;        // canonical entity name
  objectType: EntityType;
  context?: string;
}

export interface Claim {
  /** e.g. "Anthropic refused Pentagon's demand for unrestricted AI access" */
  claim: string;
  /** Named entities involved, e.g. ["Anthropic", "Pentagon", "Dario Amodei"] */
  entities: string[];
  /** Source attribution, e.g. "Dario Amodei statement" or "AP reporting" */
  attribution: string;
}

export interface ExtractedClaim extends Claim {
  triples: Triple[];
  embedding: number[];
}

export interface EpistemicMetrics {
  /** How accurately this source represents its parent (0-1, 1 = perfect fidelity) */
  sourceFidelity: number;
  /** Degree of editorial spin added vs original material (0-1, 0 = none) */
  editorialization: number;
  /** Classification of this source */
  sourceType: SourceType;
  /** Whether claims are independently corroborated */
  corroboration: Corroboration;
}

export interface SourceNode {
  id: string;
  title: string;
  url: string | null;
  publisher: string;
  date: string;
  sourceType: SourceType;
  snippet: string;
  phantom?: boolean;
  phantomKey?: string;
  unscrapable?: boolean;
  attributedClaims?: string[];
}

export interface SourceEdge {
  id: string;
  source: string;
  target: string;
  metrics: EpistemicMetrics;
  concerns: string[];
}

export interface AnalysisSummary {
  text: string;
  overallFidelity: number;
  concernCount: number;
  strongCorroboration: number;
  weakCorroboration: number;
  unverifiedClaims: string[];
}

export interface AnalysisResult {
  article: {
    title: string;
    url: string;
    publisher: string;
    date: string;
    snippet: string;
  };
  nodes: SourceNode[];
  edges: SourceEdge[];
  claims: Record<string, Claim[]>;  // nodeId → claims (no embeddings/triples in API response)
  summary?: AnalysisSummary;
}
