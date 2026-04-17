import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/storage/connected?user_id=...
 *
 * Returns which cloud storage providers are connected for a user.
 * Proxies to the DLF backend — never exposes tokens.
 */

const DLF_API = process.env.DLF_API_URL || "http://localhost:8400";

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("user_id") || "";

  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  try {
    const r = await fetch(
      `${DLF_API}/api/storage/connected?user_id=${encodeURIComponent(userId)}`,
    );
    const data = await r.json();
    return NextResponse.json(data, { status: r.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: `DLF backend unreachable: ${e.message}` },
      { status: 502 },
    );
  }
}
