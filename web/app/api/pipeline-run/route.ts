// /api/pipeline-run — stubbed (originally drove playwright to scrape sites
// + ran local YOLO). The scraping side can't run in a Worker. If we ever
// want this in production it should move to a dedicated Worker with the
// Browser Rendering binding.
// Original implementation in `git log -- this-file`.
import { selfHostedOnlyResponse } from "@/lib/dlf-api";

export const runtime = "nodejs";

export async function GET() {
  return selfHostedOnlyResponse("pipeline-run (local playwright + YOLO)");
}
export const POST = GET;
