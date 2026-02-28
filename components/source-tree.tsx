"use client";

import type { SourceTreeNode } from "@/lib/tree";
import type { EpistemicMetrics, SourceType } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const sourceTypeLabels: Record<SourceType, string> = {
  "primary-study": "primary study",
  "press-release": "press release",
  "wire-service": "wire service",
  "secondary-reporting": "reporting",
  opinion: "opinion",
  "official-statement": "statement",
  "data-source": "data",
  interview: "interview",
};

function fidelityLevel(v: number): "high" | "medium" | "low" {
  if (v >= 0.75) return "high";
  if (v >= 0.5) return "medium";
  return "low";
}

function editLevel(v: number): "high" | "medium" | "low" {
  if (v >= 0.6) return "high";
  if (v >= 0.3) return "medium";
  return "low";
}

const levelColors = {
  high: "text-red-500 dark:text-red-400",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-muted-foreground",
} as const;

const fidelityColors = {
  high: "text-muted-foreground",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-red-500 dark:text-red-400",
} as const;

function MetricsBadges({ metrics }: { metrics: EpistemicMetrics }) {
  const fid = fidelityLevel(metrics.sourceFidelity);
  const edit = editLevel(metrics.editorialization);

  return (
    <span className="inline-flex flex-wrap gap-1.5">
      <span className={cn("text-[10px] font-bold uppercase tracking-wider", fidelityColors[fid])}>
        fidelity:{fid}
      </span>
      {edit !== "low" && (
        <span className={cn("text-[10px] font-bold uppercase tracking-wider", levelColors[edit])}>
          editorial:{edit}
        </span>
      )}
      {metrics.corroboration !== "strong" && (
        <span
          className={cn(
            "text-[10px] font-bold uppercase tracking-wider",
            metrics.corroboration === "none"
              ? "text-red-500 dark:text-red-400"
              : "text-yellow-600 dark:text-yellow-400"
          )}
        >
          corroboration:{metrics.corroboration}
        </span>
      )}
    </span>
  );
}

function TreeNode({
  treeNode,
  depth,
  isLast,
}: {
  treeNode: SourceTreeNode;
  depth: number;
  isLast: boolean;
}) {
  const { node, edge, children } = treeNode;
  const isRoot = depth === 0;

  return (
    <article
      className={cn(
        "relative",
        !isRoot && "ml-4 border-l border-border pl-4 sm:ml-6 sm:pl-6",
        isLast && !isRoot && "border-l-transparent"
      )}
    >
      {/* Tree branch connector */}
      {!isRoot && (
        <div className="border-border absolute top-0 -left-px h-4 w-4 border-b border-l sm:w-6" />
      )}

      <div className={cn("space-y-1.5", !isRoot && "pt-2")}>
        {/* Transmission metrics (on the edge into this node) */}
        {edge && (
          <div className="mb-1">
            <MetricsBadges metrics={edge.metrics} />
          </div>
        )}

        {/* Source header */}
        <header>
          <h3 className={cn("font-semibold leading-snug", isRoot ? "text-base" : "text-sm")}>
            <a
              href={node.url}
              className="hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {node.title}
            </a>
          </h3>
          <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
            <span>{node.publisher}</span>
            <span className="text-border">|</span>
            <span>{node.date}</span>
            <Badge variant="secondary" className="px-1 py-0 text-[9px]">
              {sourceTypeLabels[node.sourceType]}
            </Badge>
          </p>
        </header>

        {/* Snippet */}
        <p className="text-muted-foreground text-xs leading-relaxed">{node.snippet}</p>

        {/* Epistemic concerns */}
        {edge && edge.concerns.length > 0 && (
          <details className="group">
            <summary className="text-[11px] font-medium cursor-pointer select-none hover:underline">
              <span className="text-yellow-600 dark:text-yellow-400">
                {edge.concerns.length} concern{edge.concerns.length > 1 ? "s" : ""}
              </span>
            </summary>
            <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
              {edge.concerns.map((concern, i) => (
                <li key={i} className="before:text-border before:mr-2 before:content-['—']">
                  {concern}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Children (sources of this node) */}
      {children.length > 0 && (
        <div className="mt-3 space-y-0">
          {children.map((child, i) => (
            <TreeNode
              key={child.node.id}
              treeNode={child}
              depth={depth + 1}
              isLast={i === children.length - 1}
            />
          ))}
        </div>
      )}
    </article>
  );
}

export function SourceTree({ root }: { root: SourceTreeNode }) {
  return (
    <section aria-label="Source chain analysis">
      <TreeNode treeNode={root} depth={0} isLast={true} />
    </section>
  );
}
