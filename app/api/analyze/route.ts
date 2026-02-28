import { NextRequest, NextResponse } from "next/server";
import { mockAnalysis } from "@/lib/mock-data";

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

  // Simulate processing delay
  await new Promise((resolve) => setTimeout(resolve, 800));

  return NextResponse.json({
    ...mockAnalysis,
    article: {
      ...mockAnalysis.article,
      url,
    },
  });
}
