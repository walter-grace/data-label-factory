import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/train-yolo/weights/:jobId
 *
 * Fetches the final status from RunPod (only valid once the job is COMPLETED),
 * decodes the base64 weights from output.weights_b64, and streams them back
 * as a .pt file download. Avoids exposing the base64 blob in the browser's
 * JSON response.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await ctx.params;
  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  const endpointId = (process.env.RUNPOD_TRAIN_ENDPOINT_ID || "vwa5m5stsfuhat").trim();

  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "RUNPOD_API_KEY not configured" }, { status: 500 });
  }

  const resp = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${jobId}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  const data = await resp.json();

  if (!resp.ok) {
    return NextResponse.json(
      { ok: false, error: data.error || `RunPod HTTP ${resp.status}` },
      { status: 502 },
    );
  }

  if (data.status !== "COMPLETED") {
    return NextResponse.json(
      { ok: false, error: `job not complete (status: ${data.status})` },
      { status: 409 },
    );
  }

  const out = data.output || {};
  if (!out.ok || !out.weights_b64) {
    return NextResponse.json(
      { ok: false, error: out.error || "no weights in job output" },
      { status: 500 },
    );
  }

  const bytes = Buffer.from(out.weights_b64, "base64");
  const className = String(out.class_name || "model").replace(/[^a-z0-9_-]/gi, "_");
  const filename = `${className}_${jobId.slice(0, 8)}.pt`;

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.length),
    },
  });
}
