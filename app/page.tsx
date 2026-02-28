"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { ArrowRightIcon } from "@phosphor-icons/react";

interface RecentAnalysis {
  url: string;
  title: string;
  publisher: string;
  createdAt: string;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function Page() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<RecentAnalysis[]>([]);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/analyze")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: RecentAnalysis[]) => setRecent(data))
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Analysis failed");
      }

      router.push(`/results?url=${encodeURIComponent(url)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-lg space-y-8">
        <div className="space-y-3">
          <h1 className="text-2xl font-bold tracking-tight">demediator</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Trace the epistemic quality of any article through its entire source
            chain. See where meaning shifts, bias enters, and claims lose
            fidelity.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex gap-2">
            <Input
              type="url"
              placeholder="https://..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              className="flex-1"
              disabled={loading}
            />
            <Button type="submit" disabled={loading || !url}>
              {loading ? "analyzing..." : <ArrowRightIcon />}
            </Button>
          </div>
          {error && (
            <p className="text-destructive text-xs">{error}</p>
          )}
        </form>

        {recent.length > 0 && (
          <div className="space-y-2">
            <p className="text-muted-foreground text-[10px] font-bold uppercase tracking-wider">
              recent analyses
            </p>
            <ul className="space-y-1">
              {recent.map((item) => (
                <li key={item.url}>
                  <Link
                    href={`/results?url=${encodeURIComponent(item.url)}`}
                    className="group flex items-baseline justify-between gap-2 rounded px-1 py-0.5 -mx-1 transition-colors hover:bg-muted"
                  >
                    <span className="text-xs truncate">
                      <span className="group-hover:underline">{item.title || item.url}</span>
                      {item.publisher && (
                        <span className="text-muted-foreground ml-1.5">
                          {item.publisher}
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground text-[10px] shrink-0">
                      {timeAgo(item.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="text-muted-foreground border-t pt-4 text-xs leading-relaxed">
          <p>
            Not a fact-checker. A tool for seeing the epistemic structure behind
            what you read.
          </p>
        </div>
      </div>
    </main>
  );
}
