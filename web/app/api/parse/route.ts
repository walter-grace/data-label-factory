import { NextRequest, NextResponse } from "next/server";
import { DLF_API, isSelfHostedOnly, selfHostedOnlyResponse } from "@/lib/dlf-api";

/**
 * POST /api/parse — document parsing via the DLF backend (liteparse / chandra).
 *
 * Body: multipart/form-data with:
 *   file:        the document (PDF/DOCX/XLSX/PPTX/PNG/JPG/TIFF)
 *   backend:     "liteparse" (default) | "chandra"
 *   ocr:         "true" | "false"  (defaults to false — RAM-heavy)
 *   timeout_sec: kill subprocess after N seconds (default 60)
 *
 * RAM safety: we reject at the edge before streaming to the Mac Mini.
 * If DLF runs on the Mini and OCR is on, concurrent jobs can spike RAM; the
 * backend enforces a separate size cap + timeout as a second line of defense.
 */

const MAX_MB = Number(process.env.DLF_MAX_PARSE_MB || 50);
const SUPPORTED = [".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".tiff", ".tif"];

export const runtime = "nodejs";
export const maxDuration = 120; // 2 min — long enough for OCR, short enough to bail

export async function POST(req: NextRequest) {
  if (isSelfHostedOnly()) return selfHostedOnlyResponse("Parse documents");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file field" }, { status: 400 });
  }

  // Extension whitelist
  const lower = file.name.toLowerCase();
  if (!SUPPORTED.some((ext) => lower.endsWith(ext))) {
    return NextResponse.json(
      {
        error: `unsupported file type. Supported: ${SUPPORTED.join(", ")}`,
        got: file.name,
      },
      { status: 400 },
    );
  }

  // Size cap — reject before shipping to the Mini
  const sizeMb = file.size / (1024 * 1024);
  if (sizeMb > MAX_MB) {
    return NextResponse.json(
      {
        error: `file too large (${sizeMb.toFixed(1)} MB > ${MAX_MB} MB cap)`,
        hint: "Split the document or raise DLF_MAX_PARSE_MB.",
      },
      { status: 413 },
    );
  }

  const backend = (form.get("backend") as string) || "liteparse";
  const ocr = (form.get("ocr") as string) === "true";
  const timeoutSec = Number(form.get("timeout_sec") || 60);

  // Rebuild the form for the upstream call (normalize boolean / number formatting)
  const upstream = new FormData();
  upstream.append("file", file, file.name);
  upstream.append("backend", backend);
  upstream.append("ocr", ocr ? "true" : "false");
  upstream.append("timeout_sec", String(timeoutSec));

  try {
    const res = await fetch(`${DLF_API}/api/parse`, {
      method: "POST",
      body: upstream,
      // No content-type — let fetch set the multipart boundary
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
    usage: "POST multipart/form-data with `file` field",
    backends: ["liteparse", "chandra"],
    max_mb: MAX_MB,
    supported: SUPPORTED,
  });
}
