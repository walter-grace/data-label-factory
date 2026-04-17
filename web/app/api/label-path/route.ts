import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

/**
 * POST /api/label-path — label an image using OpenRouter (Gemma 4).
 * On Vercel: receives image URL (not path), fetches it, sends to LLM.
 * Locally: the Python backend handles this via filesystem paths.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const imgPath = (body.path || "").trim(); // URL on Vercel, path locally
  const queries = body.queries || "object";
  const backend = body.backend || "openrouter";

  if (!imgPath) return NextResponse.json({ error: "path/url required" }, { status: 400 });

  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
  const model = process.env.LLM_MODEL || "google/gemma-4-26b-a4b-it";

  if (!apiKey) {
    return NextResponse.json({ error: "LLM_API_KEY not configured" }, { status: 500 });
  }

  try {
    // Fetch the image and convert to base64
    const imgResp = await fetch(imgPath, { signal: AbortSignal.timeout(10000) });
    if (!imgResp.ok) {
      return NextResponse.json({
        annotations: [], elapsed: 0, backend, image_size: [0, 0],
        n_detections: 0, path: imgPath, error: `Failed to fetch image: ${imgResp.status}`,
      });
    }
    const imgBuffer = await imgResp.arrayBuffer();
    const contentType = imgResp.headers.get("content-type") || "image/jpeg";
    const b64 = Buffer.from(imgBuffer).toString("base64");
    const dataUrl = `data:${contentType};base64,${b64}`;

    const queryList = queries.split(",").map((q: string) => q.trim());
    const prompt = `You are an object detection model. Find all instances of: ${queryList.join(", ")} in this image.

For each detection, output a JSON array of objects with:
- "category": the object class name
- "bbox": [x, y, width, height] in pixels (estimate based on image proportions, assume 640x480 if unsure)
- "score": confidence 0-1

Output ONLY the JSON array, no markdown, no explanation. If nothing found, output [].`;

    const start = Date.now();
    const llmResp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
    });

    const elapsed = (Date.now() - start) / 1000;
    const llmData = await llmResp.json();
    const text = llmData.choices?.[0]?.message?.content || "[]";

    // Parse the JSON from the LLM response
    let annotations: any[] = [];
    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      annotations = JSON.parse(cleaned);
      if (!Array.isArray(annotations)) annotations = [];
    } catch {
      annotations = [];
    }

    // Add pass_rate for compatibility
    const scored = annotations.map((ann: any) => ({
      ...ann,
      pass_rate: 1.0,
      failed_rules: [],
    }));

    return NextResponse.json({
      annotations: scored,
      elapsed: Math.round(elapsed * 100) / 100,
      backend,
      image_size: [640, 480], // estimated
      n_detections: scored.length,
      path: imgPath,
    });
  } catch (e: any) {
    return NextResponse.json({
      annotations: [], elapsed: 0, backend, image_size: [0, 0],
      n_detections: 0, path: imgPath, error: e.message,
    });
  }
}
