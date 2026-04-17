import { NextRequest, NextResponse } from "next/server";
import { addComment } from "@/lib/community-store";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; postId: string }> }) {
  const { slug, postId } = await params;
  const body = await req.json();
  if (!body.text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
  const result = addComment(slug, postId, body.author || "anonymous", body.text);
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(result);
}
