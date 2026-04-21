// /api/upload-video — stubbed (originally scp to Mac mini).
// Original implementation in `git log -- this-file`.
import { selfHostedOnlyResponse } from "@/lib/dlf-api";

export const runtime = "nodejs";

export async function POST() {
  return selfHostedOnlyResponse("upload-video (scp to local Mac mini)");
}
