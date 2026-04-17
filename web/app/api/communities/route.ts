import { NextResponse } from "next/server";
import { listCommunities, communityStats } from "@/lib/community-store";

export async function GET() {
  return NextResponse.json({ communities: listCommunities(), stats: communityStats() });
}
