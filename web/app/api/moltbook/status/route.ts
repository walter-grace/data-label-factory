import { NextResponse } from "next/server";

const DLF_API = process.env.DLF_API_URL || "http://localhost:8400";

export async function GET() {
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
