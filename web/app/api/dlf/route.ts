import { NextRequest, NextResponse } from "next/server";

// In dev: proxy to local FastAPI server (http://localhost:8400)
// On Vercel: DLF_API_URL should be set to the Python backend URL
//   Same-project: uses VERCEL_URL automatically
//   Separate project: set DLF_API_URL=https://your-api.vercel.app
function getBaseUrl(): string {
  if (process.env.DLF_API_URL) return process.env.DLF_API_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:8400";
}

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") || "/api/health";
  const base = getBaseUrl();

  // On Vercel same-project: route through /backend prefix so the rewrite
  // sends it to the Python function. Locally: hit FastAPI directly.
  const url = process.env.VERCEL ? `${base}/backend${path}` : `${base}${path}`;

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
  const url = process.env.VERCEL ? `${base}/backend${path}` : `${base}${path}`;

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
