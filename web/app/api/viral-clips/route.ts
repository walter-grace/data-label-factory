// /api/viral-clips — stubbed (originally SSH + ffmpeg on Mac mini).
// Original implementation in `git log -- this-file`.
import { selfHostedOnlyResponse } from "@/lib/dlf-api";

export const runtime = "nodejs";

export async function POST() {
  return selfHostedOnlyResponse("viral-clips (local ffmpeg via SSH)");
}
