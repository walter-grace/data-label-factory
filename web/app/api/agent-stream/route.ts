// /api/agent-stream — proxies the upstream identify server's SSE event bus
// (text/event-stream) so the browser can subscribe same-origin via
// `new EventSource('/api/agent-stream')`. The browser doesn't need to know
// the upstream URL or worry about CORS.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FALCON_URL = process.env.FALCON_URL ?? "http://localhost:8500/api/falcon";

export async function GET(req: Request) {
    const upstream = new URL(FALCON_URL);
    upstream.pathname = "/api/agent/stream";
    upstream.search = "";

    let upstreamResp: Response;
    try {
        upstreamResp = await fetch(upstream.toString(), {
            method: "GET",
            headers: { Accept: "text/event-stream" },
            // Forward client abort so we don't leak connections to upstream
            signal: req.signal,
        });
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: `upstream unreachable: ${String(e)}` },
            { status: 502 },
        );
    }

    if (!upstreamResp.ok || !upstreamResp.body) {
        return NextResponse.json(
            { ok: false, error: `upstream ${upstreamResp.status}` },
            { status: 502 },
        );
    }

    // Pass the raw byte stream straight through to the browser. Setting these
    // headers tells intermediaries (and the browser) that this is a long-lived
    // event stream that must not be buffered or transformed.
    return new Response(upstreamResp.body, {
        status: 200,
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
