import { NextRequest, NextResponse } from "next/server";
import { getCommunity, getPosts } from "@/lib/community-store";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = getCommunity(slug);
  if (!c) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ community: c, posts: getPosts(slug) });
}
