import { NextRequest, NextResponse } from "next/server";
import { reactToPost } from "@/lib/community-store";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; postId: string }> }) {
  const { slug, postId } = await params;
  const body = await req.json();
  const result = reactToPost(slug, postId, body.reaction || "fire");
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(result);
}
