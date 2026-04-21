// /api/pick-thumbnails — stubbed (originally SSH + YOLO on Mac mini).
// Original implementation in `git log -- this-file`.
import { selfHostedOnlyResponse } from "@/lib/dlf-api";

export const runtime = "nodejs";

export async function POST() {
  return selfHostedOnlyResponse("pick-thumbnails (local YOLO via SSH)");
}
