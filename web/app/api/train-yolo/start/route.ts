import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/train-yolo/start
 *
 * Body:
 *   {
 *     query:  "construction hard hats",
 *     images: [{url, image_size:[w,h], annotations:[{bbox:[x,y,w,h], category, score}]}],
 *     epochs?: number,     // default 20
 *     imgsz?: number       // default 640
 *   }
 *
 * Forwards to the DLF YOLO train RunPod serverless endpoint and returns a job_id
 * the client can poll via /api/train-yolo/status/[jobId].
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  const endpointId = (process.env.RUNPOD_TRAIN_ENDPOINT_ID || "vwa5m5stsfuhat").trim();

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "RUNPOD_API_KEY not configured on server" },
      { status: 500 },
    );
  }

  const body = await req.json();
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length === 0) {
    return NextResponse.json({ ok: false, error: "images[] required" }, { status: 400 });
  }

  // Strip noise — only forward what the handler needs
  const payload = {
    input: {
      query: String(body.query || "object"),
      epochs: Math.max(1, Math.min(100, Number(body.epochs) || 20)),
      imgsz: Math.max(320, Math.min(1280, Number(body.imgsz) || 640)),
      model: String(body.model || "yolov8n.pt"),
      images: images.map((im: any) => ({
        url: im.url || im.image_url || im.path,
        image_size: im.image_size,
        annotations: (im.annotations || []).map((a: any) => ({
          bbox: a.bbox,
          category: a.category,
          score: a.score ?? 0.9,
        })),
      })).filter((im: any) => im.url && Array.isArray(im.annotations) && im.annotations.length > 0),
    },
  };

  const resp = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();

  if (!resp.ok) {
    return NextResponse.json(
      { ok: false, error: data.error || `RunPod HTTP ${resp.status}`, detail: data },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    job_id: data.id,
    status: data.status,
    submitted_images: payload.input.images.length,
  });
}
