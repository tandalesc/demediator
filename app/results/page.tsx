import { Suspense } from "react";
import { ResultsContent } from "./results-content";

export default function ResultsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl">
            <p className="text-muted-foreground text-sm">loading...</p>
          </div>
        </main>
      }
    >
      <ResultsContent />
    </Suspense>
  );
}
