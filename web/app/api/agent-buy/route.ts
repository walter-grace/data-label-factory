// /api/agent-buy — proxies POST /api/agent/buy on the upstream identify
// server so the browser demo button can fire a "buy" without dealing with
// CORS or knowing the upstream URL.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FALCON_URL = process.env.FALCON_URL ?? "http://localhost:8500/api/falcon";

export async function POST(req: Request) {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
    }

    const upstream = new URL(FALCON_URL);
    upstream.pathname = "/api/agent/buy";
    upstream.search = "";

    try {
        const r = await fetch(upstream.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await r.json();
        return NextResponse.json(data, { status: r.status });
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: `upstream unreachable: ${String(e)}` },
            { status: 502 },
        );
    }
}
