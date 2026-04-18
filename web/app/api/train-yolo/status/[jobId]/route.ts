import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/train-yolo/status/:jobId
 *
 * Proxies to RunPod's /v2/{endpointId}/status/{jobId}. When the job is
 * COMPLETED and `output.ok === true`, the response includes the base64 weights.
 * The weights are strippable by the client; they only need to be surfaced in
 * the final download step. Intermediate polls return { status, progress, ... }
 * without the heavy base64 payload so polling stays cheap.
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
  if (!jobId) {
    return NextResponse.json({ ok: false, error: "jobId required" }, { status: 400 });
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

  // RunPod shape: { status, id, output?, delayTime?, executionTime? }
  // Also may expose a `stream` key with progress updates from progress_update calls.
  const out = data.output || {};
  const progressUpdates = Array.isArray(data.stream)
    ? data.stream.filter((s: any) => s && s.output).map((s: any) => s.output)
    : [];
  const latestProgress = progressUpdates.length ? progressUpdates[progressUpdates.length - 1] : null;

  // Strip weights_b64 from intermediate responses — client hits /weights/{jobId} when done
  const stripped = { ...out };
  if ("weights_b64" in stripped) delete stripped.weights_b64;

  return NextResponse.json({
    ok: true,
    status: data.status,
    job_id: data.id,
    delay_time: data.delayTime,
    execution_time: data.executionTime,
    progress: latestProgress,
    output: stripped,
    has_weights: !!out.weights_b64,
  });
}
