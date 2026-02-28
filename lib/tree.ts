import type { AnalysisResult, SourceNode, SourceEdge } from "./types";

export interface SourceTreeNode {
  node: SourceNode;
  edge: SourceEdge | null;
  children: SourceTreeNode[];
}

/**
 * Convert flat nodes + edges into a tree rooted at the article node.
 * Each edge points from a source (edge.source) to the node that cites it (edge.target).
 * So children of nodeX are all edges where edge.target === nodeX.id.
 */
export function buildSourceTree(analysis: AnalysisResult): SourceTreeNode {
  const nodeMap = new Map<string, SourceNode>();
  for (const node of analysis.nodes) {
    nodeMap.set(node.id, node);
  }

  const edgesByTarget = new Map<string, SourceEdge[]>();
  for (const edge of analysis.edges) {
    const existing = edgesByTarget.get(edge.target) || [];
    existing.push(edge);
    edgesByTarget.set(edge.target, existing);
  }

  function buildNode(nodeId: string, incomingEdge: SourceEdge | null): SourceTreeNode {
    const node = nodeMap.get(nodeId)!;
    const childEdges = edgesByTarget.get(nodeId) || [];

    return {
      node,
      edge: incomingEdge,
      children: childEdges.map((edge) => buildNode(edge.source, edge)),
    };
  }

  return buildNode("article", null);
}
