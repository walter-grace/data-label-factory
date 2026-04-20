import { NextRequest, NextResponse } from "next/server";
import { DLF_API, isSelfHostedOnly, selfHostedOnlyResponse } from "@/lib/dlf-api";

/**
 * POST /api/cluster — proxy to DLF backend `/api/cluster`.
 *
 * Body: multipart/form-data with one or more `files[]` PDFs.
 * We enforce the same 50-file / 50 MB-per-file caps at the edge so
 * the Next runtime doesn't buffer bad batches into the Python backend.
 *
 * See `data_label_factory/serve.py::cluster_documents`.
 */

const MAX_MB = Number(process.env.DLF_MAX_PARSE_MB || 50);
const MAX_FILES = Number(process.env.DLF_CLUSTER_MAX_FILES || 50);
const SUPPORTED = [".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".tiff", ".tif"];

export const runtime = "nodejs";
export const maxDuration = 300; // 5 min — parsing 50 PDFs sequentially takes a while

export async function POST(req: NextRequest) {
  if (isSelfHostedOnly()) return selfHostedOnlyResponse("Cluster documents");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  // Collect all File entries under any field name (we accept `files`, `files[]`, `file`).
  const files: File[] = [];
  for (const [, v] of form.entries()) {
    if (v instanceof File) files.push(v);
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "no files uploaded" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `too many files (${files.length} > ${MAX_FILES})` },
      { status: 413 },
    );
  }

  for (const f of files) {
    const lower = (f.name || "").toLowerCase();
    if (!SUPPORTED.some((ext) => lower.endsWith(ext))) {
      return NextResponse.json(
        { error: `unsupported file type: ${f.name}`, supported: SUPPORTED },
        { status: 400 },
      );
    }
    if (f.size / (1024 * 1024) > MAX_MB) {
      return NextResponse.json(
        { error: `file too large: ${f.name} (> ${MAX_MB} MB cap)` },
        { status: 413 },
      );
    }
  }

  // Rebuild upstream form — FastAPI expects the field name `files` repeated.
  const upstream = new FormData();
  for (const f of files) {
    upstream.append("files", f, f.name);
  }

  try {
    const res = await fetch(`${DLF_API}/api/cluster`, {
      method: "POST",
      body: upstream,
    });
    const data = await res.json().catch(() => ({
      error: `upstream returned non-JSON (status ${res.status})`,
    }));
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: `DLF backend unreachable: ${e.message}`, dlf_api: DLF_API },
      { status: 502 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    usage: "POST multipart/form-data with one or more `files` fields (PDFs)",
    max_files: MAX_FILES,
    max_mb: MAX_MB,
    supported: SUPPORTED,
  });
}
