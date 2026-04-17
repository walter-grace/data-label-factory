import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

/**
 * POST /api/gather — search images for a query.
 *
 * Primary: DDG via Mac Mini proxy (residential IP, no bot detection).
 * Fallback: Wikimedia Commons if the Mini tunnel is unreachable.
 *
 * Configure with env vars:
 *   DDG_PROXY_URL    — Cloudflare tunnel URL (e.g. https://xxx.trycloudflare.com)
 *   DDG_PROXY_TOKEN  — shared secret matching the Mini's DDG_PROXY_TOKEN
 */

const DDG_PROXY_URL = process.env.DDG_PROXY_URL || "";
const DDG_PROXY_TOKEN = process.env.DDG_PROXY_TOKEN || "";

type ImageResult = { filename: string; url: string; path: string; source: string; title: string };

export async function POST(req: NextRequest) {
  const body = await req.json();
  const query = (body.query || "").trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  const maxImages = Math.min(body.max_images || 10, 30);

  let images: ImageResult[] = [];
  let upstream = "none";

  // Try Mac Mini DDG proxy first
  if (DDG_PROXY_URL) {
    images = await ddgProxy(query, maxImages);
    if (images.length > 0) upstream = "ddg-mini";
  }

  // Fallback to Wikimedia Commons
  if (images.length === 0) {
    images = await wikimediaFallback(query, maxImages);
    if (images.length > 0) upstream = "wikimedia";
  }

  return NextResponse.json({
    query,
    count: images.length,
    upstream,
    session_id: `gather_${Date.now()}_${query.replace(/\s+/g, "_").slice(0, 20)}`,
    images,
  });
}

async function ddgProxy(query: string, max: number): Promise<ImageResult[]> {
  const images: ImageResult[] = [];
  try {
    const url = `${DDG_PROXY_URL}/ddg/images?q=${encodeURIComponent(query)}&max_results=${max}&token=${DDG_PROXY_TOKEN}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) return [];
    const data = await resp.json();

    for (const r of data.images || []) {
      if (images.length >= max) break;
      const imgUrl = r.url;
      if (!imgUrl) continue;
      const ext = imgUrl.match(/\.(png|webp|gif)/i)?.[1] || "jpg";
      images.push({
        filename: `img_${String(images.length).padStart(4, "0")}.${ext}`,
        url: imgUrl,
        path: imgUrl,
        source: "duckduckgo",
        title: (r.title || "").slice(0, 200),
      });
    }
  } catch (e: any) {
    console.log(`DDG proxy error: ${e.message}`);
  }
  return images;
}

async function wikimediaFallback(query: string, max: number): Promise<ImageResult[]> {
  const images: ImageResult[] = [];
  try {
    const limit = Math.min(max, 30);
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${limit}&gsrnamespace=6&prop=imageinfo&iiprop=url|mime&iiurlwidth=640&format=json`;
    const resp = await fetch(url);
    const data = await resp.json();
    const pages = data.query?.pages || {};
    for (const page of Object.values(pages) as any[]) {
      if (images.length >= max) break;
      const info = page.imageinfo?.[0];
      if (!info) continue;
      const mime = info.mime || "";
      if (!mime.startsWith("image/") || mime.includes("svg")) continue;
      const imgUrl = info.thumburl || info.url;
      if (!imgUrl) continue;
      const ext = mime.includes("png") ? "png" : "jpg";
      images.push({
        filename: `img_${String(images.length).padStart(4, "0")}.${ext}`,
        url: imgUrl,
        path: imgUrl,
        source: "wikimedia",
        title: (page.title || "").replace("File:", "").slice(0, 200),
      });
    }
  } catch {}
  return images;
}
