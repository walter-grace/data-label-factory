import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

/**
 * POST /api/label-path — label an image.
 *   backend="openrouter" → Gemma 4 via OpenRouter
 *   backend="falcon"     → Falcon Perception on Mac Mini via Cloudflare tunnel
 *   backend="auto"       → Falcon first; if 0 detections, fall back to Gemma
 */

type LabelResult = {
  annotations: any[];
  elapsed: number;
  backend: string;
  image_size: [number, number];
  n_detections: number;
  path: string;
  error?: string;
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const imgPath = (body.path || "").trim();
  const queries = body.queries || "object";
  const backend = body.backend || "openrouter";

  if (!imgPath) return NextResponse.json({ error: "path/url required" }, { status: 400 });

  if (backend === "falcon") {
    return NextResponse.json(await labelWithFalcon(imgPath, queries));
  }

  if (backend === "auto") {
    const falconResult = await labelWithFalcon(imgPath, queries);
    if (falconResult.n_detections > 0) {
      return NextResponse.json({ ...falconResult, backend: "auto:falcon" });
    }
    const gemmaResult = await labelWithOpenRouter(imgPath, queries);
    return NextResponse.json({ ...gemmaResult, backend: "auto:openrouter" });
  }

  return NextResponse.json(await labelWithOpenRouter(imgPath, queries));
}

async function labelWithOpenRouter(imgUrl: string, queries: string): Promise<LabelResult> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").trim();
  const model = (process.env.LLM_MODEL || "google/gemma-4-26b-a4b-it").trim();

  if (!apiKey) {
    return {
      annotations: [], elapsed: 0, backend: "openrouter", image_size: [0, 0],
      n_detections: 0, path: imgUrl, error: "LLM_API_KEY not configured",
    };
  }

  const start = Date.now();
  try {
    const queryList = queries.split(",").map((q: string) => q.trim());
    const prompt = `You are an object detection model. Find all instances of: ${queryList.join(", ")} in this image.

For each detection, output a JSON array of objects with:
- "category": the object class name
- "bbox": [x, y, width, height] in pixels (estimate based on image proportions, assume 640x480 if unsure)
- "score": confidence 0-1

Output ONLY the JSON array, no markdown, no explanation. If nothing found, output [].`;

    const llmResp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imgUrl } },
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
      return {
        annotations: [], elapsed, backend: "openrouter", image_size: [0, 0],
        n_detections: 0, path: imgUrl,
        error: llmData.error?.message || `LLM HTTP ${llmResp.status}`,
      };
    }
    const text = llmData.choices?.[0]?.message?.content || "[]";

    let annotations: any[] = [];
    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      annotations = JSON.parse(cleaned);
      if (!Array.isArray(annotations)) annotations = [];
    } catch {
      annotations = [];
    }

    const scored = annotations.map((ann: any) => ({
      ...ann,
      pass_rate: 1.0,
      failed_rules: [],
    }));

    return {
      annotations: scored,
      elapsed: Math.round(elapsed * 100) / 100,
      backend: "openrouter",
      image_size: [640, 480],
      n_detections: scored.length,
      path: imgUrl,
    };
  } catch (e: any) {
    return {
      annotations: [], elapsed: (Date.now() - start) / 1000, backend: "openrouter",
      image_size: [0, 0], n_detections: 0, path: imgUrl, error: e.message,
    };
  }
}

async function labelWithFalcon(imgUrl: string, queries: string): Promise<LabelResult> {
  const proxyUrl = process.env.FALCON_PROXY_URL?.trim();
  if (!proxyUrl) {
    return {
      annotations: [], elapsed: 0, backend: "falcon", image_size: [0, 0],
      n_detections: 0, path: imgUrl, error: "FALCON_PROXY_URL not configured",
    };
  }

  const start = Date.now();
  try {
    const imgResp = await fetch(imgUrl, { signal: AbortSignal.timeout(15000) });
    if (!imgResp.ok) {
      return {
        annotations: [], elapsed: 0, backend: "falcon", image_size: [0, 0],
        n_detections: 0, path: imgUrl, error: `Failed to fetch image: ${imgResp.status}`,
      };
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
      return {
        annotations: [], elapsed, backend: "falcon", image_size: [0, 0],
        n_detections: 0, path: imgUrl,
        error: data.error || `Falcon HTTP ${falconResp.status}`,
      };
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

    return {
      annotations,
      elapsed: Math.round(elapsed * 100) / 100,
      backend: "falcon",
      image_size: [iw, ih],
      n_detections: annotations.length,
      path: imgUrl,
    };
  } catch (e: any) {
    return {
      annotations: [], elapsed: (Date.now() - start) / 1000, backend: "falcon",
      image_size: [0, 0], n_detections: 0, path: imgUrl, error: e.message,
    };
  }
}
