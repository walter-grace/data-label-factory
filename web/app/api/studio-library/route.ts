// /api/studio-library — stubbed (originally listed files on the Mac mini via SSH).
// Original implementation in `git log -- this-file`.
import { selfHostedOnlyResponse } from "@/lib/dlf-api";

export const runtime = "nodejs";

export async function GET() {
  return selfHostedOnlyResponse("studio-library (local file listing via SSH)");
}
