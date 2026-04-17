import { NextRequest, NextResponse } from "next/server";

// In dev: proxy to local FastAPI server
// On Vercel: proxy to same-origin Next.js API routes (native TS endpoints)
function getBaseUrl(): string {
  if (process.env.DLF_API_URL) return process.env.DLF_API_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:8400";
}

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") || "/api/health";
  const base = getBaseUrl();
  const url = `${base}${path}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") || "/api/filter";
  const base = getBaseUrl();
  const url = `${base}${path}`;

  try {
    const contentType = req.headers.get("content-type") || "";
    const body = await req.arrayBuffer();

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: body,
    });

    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
