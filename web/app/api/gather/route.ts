import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

/**
 * POST /api/gather — search DuckDuckGo for images and return URLs.
 * On Vercel we can't write to disk, so we return image URLs + metadata
 * instead of downloading. The frontend will display them directly.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const query = (body.query || "").trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  const maxImages = Math.min(body.max_images || 10, 30);
  const ua = "data-label-factory/0.2 (bot)";

  try {
    // Step 1: get vqd token from DDG
    const tokenUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;
    const tokenResp = await fetch(tokenUrl, {
      headers: { "User-Agent": ua },
    });
    const html = await tokenResp.text();
    const match = html.match(/vqd=['"]([\d-]+)['"]/);
    if (!match) {
      return NextResponse.json({ error: "Could not get DDG token", query, count: 0, images: [] });
    }
    const vqd = match[1];

    // Step 2: fetch image results from i.js
    const params = new URLSearchParams({
      l: "us-en", o: "json", q: query, vqd, f: ",,,,,", p: "1",
    });
    const searchUrl = `https://duckduckgo.com/i.js?${params}`;
    const searchResp = await fetch(searchUrl, {
      headers: { "User-Agent": ua },
    });
    const data = await searchResp.json();

    const seen = new Set<string>();
    const images: { filename: string; url: string; path: string; source: string; title: string }[] = [];

    for (const item of data.results || []) {
      if (images.length >= maxImages) break;
      const imgUrl = item.image;
      if (!imgUrl || seen.has(imgUrl)) continue;
      seen.add(imgUrl);

      const ext = imgUrl.match(/\.(png|webp|gif)/i) ? imgUrl.match(/\.(png|webp|gif)/i)![1] : "jpg";
      const fname = `img_${String(images.length).padStart(4, "0")}.${ext}`;

      images.push({
        filename: fname,
        url: imgUrl,
        path: imgUrl, // on Vercel, path IS the URL (no disk)
        source: "duckduckgo",
        title: (item.title || "").slice(0, 200),
      });
    }

    return NextResponse.json({
      query,
      count: images.length,
      session_id: `gather_${Date.now()}_${query.replace(/\s+/g, "_").slice(0, 20)}`,
      images,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `DDG search failed: ${e.message}`, query, count: 0, images: [] }, { status: 502 });
  }
}
