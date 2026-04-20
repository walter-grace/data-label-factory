import { NextRequest, NextResponse } from "next/server";
import { DLF_API, isSelfHostedOnly, selfHostedOnlyResponse } from "@/lib/dlf-api";

/**
 * POST /api/render-page — render a document page to PNG via the DLF backend.
 *
 * Body: multipart/form-data with `file`, optional `page` (default 1), `dpi` (default 150)
 * Returns: image/png binary
 *
 * Used by the template editor to show the actual rendered page as a
 * background for drawing field boxes.
 */

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (isSelfHostedOnly()) return selfHostedOnlyResponse("Render page");
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

  const upstream = new FormData();
  upstream.append("file", file, file.name);
  upstream.append("page", (form.get("page") as string) || "1");
  upstream.append("dpi", (form.get("dpi") as string) || "150");

  try {
    const res = await fetch(`${DLF_API}/api/render-page`, {
      method: "POST",
      body: upstream,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: text || `render failed: ${res.status}` },
        { status: res.status },
      );
    }
    // Stream the PNG back
    const blob = await res.blob();
    return new Response(blob, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" },
    });
  } catch (e: any) {
    return NextResponse.json({ error: `backend unreachable: ${e.message}` }, { status: 502 });
  }
}
