import { mockAnalysis } from "../mock-data";
import { insertAnalysis } from "./queries";

async function main() {
  console.log("Seeding database…");
  await insertAnalysis(mockAnalysis);
  console.log("Done — inserted mock analysis for:", mockAnalysis.article.url);
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
