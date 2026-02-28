export type SourceType =
  | "primary-study"
  | "press-release"
  | "wire-service"
  | "secondary-reporting"
  | "opinion"
  | "official-statement"
  | "data-source"
  | "interview";

export type SeverityLevel = "low" | "medium" | "high";

export interface EpistemicMetrics {
  /** How accurately this source represents its parent (0-1, 1 = perfect fidelity) */
  sourceFidelity: number;
  /** Degree of editorial spin added vs original material (0-1, 0 = none) */
  editorialization: number;
  /** Classification of this source */
  sourceType: SourceType;
  /** Whether claims are independently corroborated */
  corroboration: "strong" | "partial" | "none" | "unverified";
}

export interface SourceNode {
  id: string;
  title: string;
  url: string;
  publisher: string;
  date: string;
  sourceType: SourceType;
  snippet: string;
}

export interface SourceEdge {
  id: string;
  source: string;
  target: string;
  metrics: EpistemicMetrics;
  concerns: string[];
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
}
