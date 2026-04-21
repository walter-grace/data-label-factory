// /api/inspect-url — stubbed (originally drove playwright for screenshots
// + DOM extraction). Equivalent on CF would use the Browser Rendering
// binding; route it to the gateway Worker when that's wired up.
// Original implementation in `git log -- this-file`.
import { selfHostedOnlyResponse } from "@/lib/dlf-api";

export const runtime = "nodejs";

export async function POST() {
  return selfHostedOnlyResponse("inspect-url (local playwright)");
}
