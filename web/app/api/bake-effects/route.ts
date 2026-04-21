// /api/bake-effects — stubbed (originally SSH + ffmpeg filters on Mac mini).
// Original implementation in `git log -- this-file`.
import { selfHostedOnlyResponse } from "@/lib/dlf-api";

export const runtime = "nodejs";

export async function POST() {
  return selfHostedOnlyResponse("bake-effects (local ffmpeg via SSH)");
}
