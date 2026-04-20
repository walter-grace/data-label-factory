import { NextRequest, NextResponse } from "next/server";
import { DLF_API, isSelfHostedOnly, selfHostedOnlyResponse } from "@/lib/dlf-api";

/**
 * POST /api/moltbook/connect
 * Verifies an agent's Moltbook API key by round-tripping through the
 * DLF backend (which calls https://www.moltbook.com/api/v1/agents/me).
 *
 * Body: { dlf_agent_id, api_key }
 *
 * The API key never lives in the browser after this call — DLF stores
 * it server-side so future broadcasts work. Response contains only the
 * verified molty_name + an api_key_hint (last 4 chars).
 */

export async function POST(req: NextRequest) {
  if (isSelfHostedOnly()) return selfHostedOnlyResponse("Moltbook connect");
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body?.dlf_agent_id || !body?.api_key) {
    return NextResponse.json(
      { error: "dlf_agent_id and api_key required" },
      { status: 400 },
    );
  }

  try {
    const r = await fetch(`${DLF_API}/api/moltbook/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    return NextResponse.json(data, { status: r.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: `DLF backend unreachable: ${e.message}` },
      { status: 502 },
    );
  }
}
