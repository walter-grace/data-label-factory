import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * POST /api/gather — search for images and return URLs.
 * Uses DDG with browser-like headers. Falls back to returning
 * placeholder results if DDG blocks the request.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const query = (body.query || "").trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  const maxImages = Math.min(body.max_images || 10, 30);

  // Try DDG image search
  const images = await ddgImageSearch(query, maxImages);

  return NextResponse.json({
    query,
    count: images.length,
    session_id: `gather_${Date.now()}_${query.replace(/\s+/g, "_").slice(0, 20)}`,
    images,
  });
}

async function ddgImageSearch(query: string, max: number) {
  const images: { filename: string; url: string; path: string; source: string; title: string }[] = [];

  try {
    // Step 1: get vqd token
    const tokenResp = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
      {
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Referer": "https://duckduckgo.com/",
        },
      },
    );
    const html = await tokenResp.text();
    const match = html.match(/vqd=['"]?([\d-]+)['"]?/);
    if (!match) {
      console.log("DDG: no vqd token found, trying fallback");
      return fallbackSearch(query, max);
    }
    const vqd = match[1];

    // Step 2: fetch image results
    const params = new URLSearchParams({
      l: "us-en", o: "json", q: query, vqd, f: ",,,,,", p: "1",
    });
    const searchResp = await fetch(`https://duckduckgo.com/i.js?${params}`, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    const text = await searchResp.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      console.log("DDG i.js returned non-JSON, trying fallback");
      return fallbackSearch(query, max);
    }

    const seen = new Set<string>();
    for (const item of data.results || []) {
      if (images.length >= max) break;
      const imgUrl = item.image;
      if (!imgUrl || seen.has(imgUrl)) continue;
      seen.add(imgUrl);
      const ext = imgUrl.match(/\.(png|webp|gif)/i)?.[1] || "jpg";
      images.push({
        filename: `img_${String(images.length).padStart(4, "0")}.${ext}`,
        url: imgUrl,
        path: imgUrl,
        source: "duckduckgo",
        title: (item.title || "").slice(0, 200),
      });
    }
  } catch (e: any) {
    console.log(`DDG search error: ${e.message}, trying fallback`);
    return fallbackSearch(query, max);
  }

  return images.length > 0 ? images : fallbackSearch(query, max);
}

/**
 * Fallback: use Unsplash search API (no auth needed for napi).
 * Returns real, direct image URLs.
 */
async function fallbackSearch(query: string, max: number) {
  const images: { filename: string; url: string; path: string; source: string; title: string }[] = [];

  try {
    const perPage = Math.min(max, 20);
    const resp = await fetch(
      `https://unsplash.com/napi/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}`,
      { headers: { "User-Agent": UA, "Accept": "application/json" } },
    );
    const data = await resp.json();
    for (const result of data.results || []) {
      if (images.length >= max) break;
      const url = result.urls?.small || result.urls?.regular || result.urls?.thumb;
      if (!url) continue;
      images.push({
        filename: `img_${String(images.length).padStart(4, "0")}.jpg`,
        url,
        path: url,
        source: "unsplash",
        title: (result.alt_description || result.description || query).slice(0, 200),
      });
    }
  } catch {
    // Return empty if even fallback fails
  }

  return images;
}
