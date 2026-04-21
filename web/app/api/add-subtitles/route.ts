// /api/add-subtitles — stubbed (originally SSH + MLX Whisper + ffmpeg on Mac mini).
// Original implementation in `git log -- this-file`.
import { selfHostedOnlyResponse } from "@/lib/dlf-api";

export const runtime = "nodejs";

export async function POST() {
  return selfHostedOnlyResponse("add-subtitles (local Whisper + ffmpeg via SSH)");
}
