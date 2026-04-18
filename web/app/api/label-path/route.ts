import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

/**
 * POST /api/label-path — label an image.
 *   backend="openrouter" → Gemma 4 via OpenRouter (default)
 *   backend="falcon"     → Falcon Perception on Mac Mini via Cloudflare tunnel
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const imgPath = (body.path || "").trim();
  const queries = body.queries || "object";
  const backend = body.backend || "openrouter";

  if (!imgPath) return NextResponse.json({ error: "path/url required" }, { status: 400 });

  if (backend === "falcon") {
    return labelWithFalcon(imgPath, queries);
  }

  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").trim();
  const model = (process.env.LLM_MODEL || "google/gemma-4-26b-a4b-it").trim();

  if (!apiKey) {
    return NextResponse.json({ error: "LLM_API_KEY not configured" }, { status: 500 });
  }

  try {
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
              { type: "image_url", image_url: { url: imgPath } },
            ],
          },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
    });

    const elapsed = (Date.now() - start) / 1000;
    const llmData = await llmResp.json();
    if (!llmResp.ok || llmData.error) {
      const errMsg = llmData.error?.message || `LLM HTTP ${llmResp.status}`;
      return NextResponse.json({
        annotations: [], elapsed, backend, image_size: [0, 0],
        n_detections: 0, path: imgPath, error: errMsg,
      });
    }
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

async function labelWithFalcon(imgUrl: string, queries: string) {
  const proxyUrl = process.env.FALCON_PROXY_URL?.trim();
  if (!proxyUrl) {
    return NextResponse.json({
      annotations: [], elapsed: 0, backend: "falcon", image_size: [0, 0],
      n_detections: 0, path: imgUrl, error: "FALCON_PROXY_URL not configured",
    });
  }

  const start = Date.now();
  try {
    const imgResp = await fetch(imgUrl, { signal: AbortSignal.timeout(15000) });
    if (!imgResp.ok) {
      return NextResponse.json({
        annotations: [], elapsed: 0, backend: "falcon", image_size: [0, 0],
        n_detections: 0, path: imgUrl, error: `Failed to fetch image: ${imgResp.status}`,
      });
    }
    const imgBlob = await imgResp.blob();
    const contentType = imgResp.headers.get("content-type") || "image/jpeg";
    const ext = contentType.split("/")[1]?.split(";")[0] || "jpg";

    const form = new FormData();
    form.append("image", imgBlob, `image.${ext}`);
    form.append("query", queries);

    const falconResp = await fetch(`${proxyUrl.replace(/\/$/, "")}/api/falcon`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(55000),
    });
    const data = await falconResp.json();
    const elapsed = (Date.now() - start) / 1000;

    if (!falconResp.ok || data.error) {
      return NextResponse.json({
        annotations: [], elapsed, backend: "falcon", image_size: [0, 0],
        n_detections: 0, path: imgUrl, error: data.error || `Falcon HTTP ${falconResp.status}`,
      });
    }

    const [iw, ih] = data.image_size || [0, 0];
    const annotations = (data.masks || []).map((m: any) => {
      const { x1, y1, x2, y2 } = m.bbox_norm || {};
      return {
        category: queries.split(",")[0].trim(),
        bbox: [
          Math.round(x1 * iw),
          Math.round(y1 * ih),
          Math.round((x2 - x1) * iw),
          Math.round((y2 - y1) * ih),
        ],
        score: m.score ?? 0.9,
        pass_rate: 1.0,
        failed_rules: [],
      };
    });

    return NextResponse.json({
      annotations,
      elapsed: Math.round(elapsed * 100) / 100,
      backend: "falcon",
      image_size: [iw, ih],
      n_detections: annotations.length,
      path: imgUrl,
    });
  } catch (e: any) {
    return NextResponse.json({
      annotations: [], elapsed: (Date.now() - start) / 1000, backend: "falcon",
      image_size: [0, 0], n_detections: 0, path: imgUrl, error: e.message,
    });
  }
}
