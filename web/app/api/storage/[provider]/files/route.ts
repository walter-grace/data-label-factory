import { NextRequest, NextResponse } from "next/server";

/**
 * /api/storage/[provider]/files
 *
 * GET  — List files in a folder (proxied through DLF backend)
 *        Query: ?user_id=...&folder_id=...
 *
 * POST — Download a file from cloud storage
 *        Body: { user_id, file_id }
 *        Returns the file as a blob (streamed from DLF backend)
 */

const DLF_API = process.env.DLF_API_URL || "http://localhost:8400";

type Provider = "gdrive" | "dropbox" | "bitbucket";
const VALID: Set<string> = new Set(["gdrive", "dropbox", "bitbucket"]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;

  if (!VALID.has(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  const userId = req.nextUrl.searchParams.get("user_id") || "";
  const folderId = req.nextUrl.searchParams.get("folder_id") || "";

  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  try {
    const qs = new URLSearchParams({ user_id: userId });
    if (folderId) qs.set("folder_id", folderId);

    const r = await fetch(
      `${DLF_API}/api/storage/${provider}/files?${qs}`,
      { method: "GET" },
    );
    const data = await r.json();
    return NextResponse.json(data, { status: r.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: `DLF backend unreachable: ${e.message}` },
      { status: 502 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;

  if (!VALID.has(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const userId = body?.user_id || "";
  const fileId = body?.file_id || "";

  if (!userId || !fileId) {
    return NextResponse.json(
      { error: "user_id and file_id required" },
      { status: 400 },
    );
  }

  try {
    const r = await fetch(`${DLF_API}/api/storage/${provider}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, file_id: fileId }),
    });

    if (!r.ok) {
      const data = await r.json().catch(() => ({ error: "download failed" }));
      return NextResponse.json(data, { status: r.status });
    }

    // The backend returns { path, filename }. Read the file and return as blob.
    const data = await r.json();
    const filePath = data.path;
    const filename = data.filename || "download";

    // Fetch the file from the backend's tmp directory via a second call
    // In production, this would stream directly. For now, proxy the path info.
    return NextResponse.json({
      path: filePath,
      filename,
      message: "File downloaded to server. Use /api/parse with this path.",
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: `DLF backend unreachable: ${e.message}` },
      { status: 502 },
    );
  }
}
