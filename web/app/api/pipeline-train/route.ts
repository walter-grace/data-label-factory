// /api/pipeline-train — stubbed.
//
// The original implementation SSHed into a Mac mini to run YOLO training.
// That only ever worked in dev on the author's LAN; Vercel can't open
// outbound SSH, and the upcoming Cloudflare Worker runtime can't bundle
// `child_process` at all. The route now returns a clean self-hosted-only
// 503. The auto-loop / agent pipeline uses /v1/train-yolo on the gateway
// instead, which runs on RunPod.
//
// Full original implementation is recoverable via `git log -- this-file`.

import { selfHostedOnlyResponse } from "@/lib/dlf-api";

export const runtime = "nodejs";

export async function POST() {
  return selfHostedOnlyResponse("pipeline-train (local SSH training)");
}
