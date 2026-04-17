// /api/top-prices — proxies the upstream identify server's top-prices endpoint
// so the browser can fetch it same-origin. Falls back to an empty list if the
// upstream doesn't have prices configured.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FALCON_URL = process.env.FALCON_URL ?? "http://localhost:8500/api/falcon";

export async function GET(req: Request) {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit") ?? "50";

    // Derive the upstream base from FALCON_URL (strip the /api/falcon suffix)
    const upstream = new URL(FALCON_URL);
    upstream.pathname = "/api/top-prices";
    upstream.search = `?limit=${encodeURIComponent(limit)}`;

    try {
        const r = await fetch(upstream.toString(), { method: "GET" });
        if (!r.ok) {
            return NextResponse.json({ ok: false, top: [], count: 0, error: `upstream ${r.status}` });
        }
        const data = await r.json();
        return NextResponse.json(data);
    } catch (e) {
        return NextResponse.json({ ok: false, top: [], count: 0, error: String(e) });
    }
}
