import { NextRequest, NextResponse } from "next/server";
import { getAnalysisByUrl, insertAnalysis } from "@/lib/db/queries";
import { runPipeline } from "@/lib/pipeline";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { url } = body;

  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  try {
    new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  // Fast path: return cached analysis
  const cached = await getAnalysisByUrl(url);
  if (cached) {
    return NextResponse.json(cached);
  }

  // Slow path: run the real analysis pipeline
  try {
    const { result, claimData } = await runPipeline(url);
    await insertAnalysis(result, claimData);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Pipeline failed:", err);
    return NextResponse.json(
      { error: "Analysis failed. Please try again." },
      { status: 502 },
    );
  }
}
