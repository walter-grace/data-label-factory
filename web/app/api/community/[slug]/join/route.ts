import { NextRequest, NextResponse } from "next/server";
import { joinCommunity } from "@/lib/community-store";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await req.json();
  const ok = joinCommunity(slug, body.agent_id || "anonymous");
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, slug, agent_id: body.agent_id });
}
