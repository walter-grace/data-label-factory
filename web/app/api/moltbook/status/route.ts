import { NextResponse } from "next/server";
import { DLF_API, isSelfHostedOnly, selfHostedOnlyResponse } from "@/lib/dlf-api";

export async function GET() {
  if (isSelfHostedOnly()) return selfHostedOnlyResponse("Moltbook status");
  try {
    const r = await fetch(`${DLF_API}/api/moltbook/status`);
    const data = await r.json();
    return NextResponse.json(data, { status: r.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: `DLF backend unreachable: ${e.message}` },
      { status: 502 },
    );
  }
}
