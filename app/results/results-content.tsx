"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { SourceTree } from "@/components/source-tree";
import { buildSourceTree, type SourceTreeNode } from "@/lib/tree";
import type { AnalysisResult } from "@/lib/types";
import { ArrowLeftIcon } from "@phosphor-icons/react";

export function ResultsContent() {
  const searchParams = useSearchParams();
  const url = searchParams.get("url");
  const [data, setData] = useState<AnalysisResult | null>(null);
  const [tree, setTree] = useState<SourceTreeNode | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!url) {
      setError("No URL provided");
      setLoading(false);
      return;
    }

    fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("Analysis failed");
        return res.json();
      })
      .then((result: AnalysisResult) => {
        setData(result);
        setTree(buildSourceTree(result));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [url]);

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <header className="mb-8 flex items-center justify-between">
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs transition-colors"
          >
            <ArrowLeftIcon className="h-3 w-3" />
            new analysis
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-xs">demediator</span>
            <ThemeToggle />
          </div>
        </header>

        {/* Loading state */}
        {loading && (
          <div className="text-muted-foreground space-y-2 text-sm">
            <p>analyzing source chain...</p>
            <p className="text-xs">tracing {url}</p>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="space-y-2">
            <p className="text-destructive text-sm">{error}</p>
            <Link href="/" className="text-muted-foreground text-xs hover:underline">
              try again
            </Link>
          </div>
        )}

        {/* Results */}
        {data && tree && (
          <div className="space-y-6">
            {/* Analyzed URL */}
            <div className="border-b pb-4">
              <p className="text-muted-foreground text-[10px] font-bold uppercase tracking-wider">
                analyzed
              </p>
              <p className="text-muted-foreground mt-1 break-all text-xs">{data.article.url}</p>
            </div>

            {/* Summary stats */}
            <div className="flex gap-6 text-xs">
              <div>
                <span className="text-muted-foreground">sources traced</span>{" "}
                <span className="font-semibold">{data.nodes.length}</span>
              </div>
              <div>
                <span className="text-muted-foreground">links analyzed</span>{" "}
                <span className="font-semibold">{data.edges.length}</span>
              </div>
              <div>
                <span className="text-muted-foreground">concerns</span>{" "}
                <span className="font-semibold text-yellow-600 dark:text-yellow-400">
                  {data.edges.reduce((sum, e) => sum + e.concerns.length, 0)}
                </span>
              </div>
            </div>

            {/* Source tree */}
            <SourceTree root={tree} />

            {/* Footer */}
            <footer className="border-t pt-4 text-[10px] text-muted-foreground">
              <p>
                This analysis traces epistemic quality through the source chain.
                It does not determine truth — it shows where meaning shifts between sources.
              </p>
            </footer>
          </div>
        )}
      </div>
    </main>
  );
}
