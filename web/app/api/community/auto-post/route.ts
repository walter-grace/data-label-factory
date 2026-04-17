import { NextRequest, NextResponse } from "next/server";
import { createPost, guessSlug } from "@/lib/community-store";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const query = body.query || "";
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });
  const slug = guessSlug(query);
  const result = createPost(
    slug,
    body.agent_id || "system",
    `Help label: ${body.image_count || 0} images of '${query}'`,
    `**${body.image_count || 0} images** need labeling for **${query}**.\n\nPlay the Flywheel game to help verify bounding boxes:\n- Web: /play\n- MCP: \`play_flywheel(action='challenge')\`\n\nEvery correct label earns points + trains the model via GRPO.`,
    "job",
    { query, image_count: body.image_count || 0 },
  );
  return NextResponse.json(result);
}
