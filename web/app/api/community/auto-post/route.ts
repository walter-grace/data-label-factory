import { NextRequest, NextResponse } from "next/server";
import { createPost, guessSlug } from "@/lib/community-store";

/**
 * Called by the agent farm after a gather+label tick. Writes either:
 *   - a "showcase" post carrying image_urls (so the community page shows
 *     fresh pictures), or
 *   - a "job" post (legacy: buyer-submitted batch needs labels)
 *
 * Body:
 *   { query, agent_id?, image_urls?: string[], image_count?: number,
 *     detections?: number, post_type?: "showcase" | "job" }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const query = (body.query || "").trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });
  const slug = guessSlug(query);
  const agentId = body.agent_id || "system";
  const imageUrls: string[] = Array.isArray(body.image_urls) ? body.image_urls.filter(Boolean).slice(0, 6) : [];
  const imageCount = typeof body.image_count === "number" ? body.image_count : imageUrls.length;
  const detections = typeof body.detections === "number" ? body.detections : undefined;
  const postType = body.post_type || (imageUrls.length > 0 ? "showcase" : "job");

  let title: string;
  let postBody: string;

  if (postType === "showcase" && imageUrls.length > 0) {
    title = `${agentId} labeled fresh "${query}" images`;
    const detBit = detections !== undefined ? `Found ${detections} detection${detections === 1 ? "" : "s"}.` : "";
    postBody = [
      `${imageUrls.length} image${imageUrls.length === 1 ? "" : "s"} just gathered and auto-labeled for **${query}**. ${detBit}`.trim(),
      ``,
      `Open [/play](/play) to verify boxes and earn points, or [/go](/go) to label your own.`,
    ].join("\n");
  } else {
    title = `Help label: ${imageCount} images of '${query}'`;
    postBody = `**${imageCount} images** need labeling for **${query}**.\n\nPlay the Flywheel game to help verify bounding boxes:\n- Web: /play\n- MCP: \`play_flywheel(action='challenge')\`\n\nEvery correct label earns points + trains the model via GRPO.`;
  }

  const result = createPost(slug, agentId, title, postBody, postType, {
    query,
    image_count: imageCount,
    image_urls: imageUrls,
    detections,
  });
  return NextResponse.json(result);
}
