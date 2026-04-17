import { NextRequest, NextResponse } from "next/server";
import { image_search, SafeSearchType } from "duck-duck-scrape";

export const maxDuration = 60;

/**
 * POST /api/gather — search DuckDuckGo for images via duck-duck-scrape.
 * Falls back to Wikimedia Commons if DDG blocks the request.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const query = (body.query || "").trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  const maxImages = Math.min(body.max_images || 10, 30);

  let images = await ddgSearch(query, maxImages);
  if (images.length === 0) {
    images = await wikimediaFallback(query, maxImages);
  }

  return NextResponse.json({
    query,
    count: images.length,
    session_id: `gather_${Date.now()}_${query.replace(/\s+/g, "_").slice(0, 20)}`,
    images,
  });
}

type ImageResult = { filename: string; url: string; path: string; source: string; title: string };

async function ddgSearch(query: string, max: number): Promise<ImageResult[]> {
  const images: ImageResult[] = [];
  try {
    const results = await image_search({
      query,
      moderate: true,
      iterations: 1,
      retries: 2,
    });

    for (const r of results.results || []) {
      if (images.length >= max) break;
      const url = r.image;
      if (!url) continue;
      const ext = url.match(/\.(png|webp|gif)/i)?.[1] || "jpg";
      images.push({
        filename: `img_${String(images.length).padStart(4, "0")}.${ext}`,
        url,
        path: url,
        source: "duckduckgo",
        title: (r.title || "").slice(0, 200),
      });
    }
  } catch (e: any) {
    console.log(`DDG search error: ${e.message}`);
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
