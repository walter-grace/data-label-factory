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
    const formData = await req.formData();
    const res = await fetch(`${DLF_API}${path}`, {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
