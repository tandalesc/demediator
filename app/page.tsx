"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { ArrowRightIcon } from "@phosphor-icons/react";

export default function Page() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

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
