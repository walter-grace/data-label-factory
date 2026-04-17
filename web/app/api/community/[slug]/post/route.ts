import { NextRequest, NextResponse } from "next/server";
import { createPost } from "@/lib/community-store";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await req.json();
  if (!body.title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
  const result = createPost(slug, body.author || "anonymous", body.title, body.body || "", body.post_type, body.metadata);
  if ("error" in result) return NextResponse.json(result, { status: 404 });
  return NextResponse.json(result);
}
