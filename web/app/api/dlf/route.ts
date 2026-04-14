import { NextRequest, NextResponse } from "next/server";

const DLF_API = process.env.DLF_API_URL || "http://localhost:8400";

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") || "/api/health";
  try {
    const res = await fetch(`${DLF_API}${path}`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") || "/api/filter";
  try {
    // Forward the raw request body + content-type header to preserve multipart boundaries
    const contentType = req.headers.get("content-type") || "";
    const body = await req.arrayBuffer();

    const res = await fetch(`${DLF_API}${path}`, {
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
