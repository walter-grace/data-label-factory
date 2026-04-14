import { NextRequest, NextResponse } from "next/server";
import { isR2Configured, putObject, putJson, presignGet, listAll, getJson } from "@/lib/r2";

/**
 * POST /api/jobs — Save a completed pipeline job to R2
 *
 * Body (multipart form):
 *   - meta: JSON string with { jobId, target, backend, labelBackend, results[] }
 *   - images[]: the image files
 *   - coco: JSON string with COCO annotations
 */
export async function POST(req: NextRequest) {
  if (!isR2Configured()) {
    return NextResponse.json({ error: "R2 not configured", saved: false }, { status: 200 });
  }

  try {
    const form = await req.formData();
    const metaStr = form.get("meta") as string;
    const cocoStr = form.get("coco") as string;

    if (!metaStr || !cocoStr) {
      return NextResponse.json({ error: "Missing meta or coco field" }, { status: 400 });
    }

    const meta = JSON.parse(metaStr);
    const jobId = meta.jobId as string;
    const prefix = `jobs/${jobId}`;

    // Save images
    const imageFiles = form.getAll("images") as File[];
    for (const file of imageFiles) {
      const buf = Buffer.from(await file.arrayBuffer());
      await putObject(`${prefix}/images/${file.name}`, buf, file.type || "image/jpeg");
    }

    // Save COCO JSON
    const coco = JSON.parse(cocoStr);
    await putJson(`${prefix}/coco.json`, coco);

    // Save job metadata
    await putJson(`${prefix}/meta.json`, {
      ...meta,
      created: new Date().toISOString(),
      n_images: imageFiles.length,
      n_annotations: coco.annotations?.length ?? 0,
    });

    return NextResponse.json({
      saved: true,
      jobId,
      prefix,
      n_images: imageFiles.length,
      n_annotations: coco.annotations?.length ?? 0,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * GET /api/jobs — List jobs or get a specific job's download links
 *
 * ?list=true          — list all job IDs
 * ?jobId=xxx          — get presigned download URLs for a job
 */
export async function GET(req: NextRequest) {
  if (!isR2Configured()) {
    return NextResponse.json({ error: "R2 not configured", jobs: [] }, { status: 200 });
  }

  try {
    const { searchParams } = req.nextUrl;

    // List all jobs
    if (searchParams.get("list") === "true") {
      const keys = await listAll("jobs/");
      const jobIds = new Set<string>();
      for (const key of keys) {
        const parts = key.split("/");
        if (parts.length >= 2) jobIds.add(parts[1]);
      }
      // Fetch meta for each
      const jobs = [];
      for (const id of jobIds) {
        const meta = await getJson<any>(`jobs/${id}/meta.json`);
        jobs.push({ jobId: id, ...meta });
      }
      return NextResponse.json({ jobs });
    }

    // Get download links for a specific job
    const jobId = searchParams.get("jobId");
    if (jobId) {
      const keys = await listAll(`jobs/${jobId}/`);
      const urls: Record<string, string> = {};
      for (const key of keys) {
        urls[key] = await presignGet(key, 3600);
      }
      const meta = await getJson<any>(`jobs/${jobId}/meta.json`);
      return NextResponse.json({ jobId, meta, files: urls });
    }

    return NextResponse.json({ error: "Pass ?list=true or ?jobId=xxx" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
