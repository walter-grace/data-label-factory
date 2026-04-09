// /api/falcon-frame — proxies a single image+query to a Falcon Perception
// backend and returns the bbox JSON. The browser never sees the upstream URL
// or any credentials.
//
// Configure the upstream via env vars in web/.env.local:
//
//   FALCON_URL=http://localhost:8500/api/falcon          (local mac_tensor)
//   FALCON_URL=https://api.runpod.ai/v2/<endpoint>/runsync   (runpod serverless)
//   FALCON_RUNPOD_TOKEN=rpa_xxxxxxxx                     (only if using runpod)
//
// Request:  multipart/form-data with `image` (Blob) and `query` (string)
// Response: { ok: bool, count: int, bboxes: [{x1,y1,x2,y2,score,label}], elapsed_ms: int, error?: string }

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Canonical bbox shape that the browser tracker consumes
type Bbox = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    score: number;
    label: string;
    ref_url?: string;   // URL to a reference image (for the live tracker sidebar)
    margin?: number;
    confident?: boolean;
};

const FALCON_URL = process.env.FALCON_URL ?? "http://localhost:8500/api/falcon";
const FALCON_RUNPOD_TOKEN = process.env.FALCON_RUNPOD_TOKEN ?? "";
const IS_RUNPOD = FALCON_URL.includes("api.runpod.ai");

export async function POST(req: NextRequest) {
    const t0 = Date.now();
    try {
        const form = await req.formData();
        const image = form.get("image");
        const query = form.get("query");
        if (!(image instanceof File) || typeof query !== "string" || !query) {
            return NextResponse.json(
                { ok: false, error: "image (File) and query (string) are required" },
                { status: 400 },
            );
        }

        let bboxes: Bbox[] = [];
        let imgW = 0;
        let imgH = 0;
        let upstreamCount = 0;

        if (IS_RUNPOD) {
            // Runpod serverless wants base64 in the request body
            const buf = await image.arrayBuffer();
            const b64 = Buffer.from(buf).toString("base64");
            const upstreamReq = await fetch(FALCON_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(FALCON_RUNPOD_TOKEN ? { Authorization: `Bearer ${FALCON_RUNPOD_TOKEN}` } : {}),
                },
                body: JSON.stringify({
                    input: { image_base64: b64, query, task: "segmentation" },
                }),
            });
            if (!upstreamReq.ok) {
                throw new Error(`runpod ${upstreamReq.status}: ${(await upstreamReq.text()).slice(0, 200)}`);
            }
            const data = await upstreamReq.json();
            const out = data.output ?? data;
            upstreamCount = out.count ?? 0;
            imgW = out.image_size?.[0] ?? 0;
            imgH = out.image_size?.[1] ?? 0;
            for (const b of out.bboxes ?? []) {
                bboxes.push({
                    x1: b.x1 ?? 0,
                    y1: b.y1 ?? 0,
                    x2: b.x2 ?? 0,
                    y2: b.y2 ?? 0,
                    score: b.score ?? 1,
                    label: query,
                });
            }
        } else {
            // Local mac_tensor /api/falcon — multipart in, JSON out
            const upstreamForm = new FormData();
            upstreamForm.set("query", query);
            upstreamForm.set("image", image, "frame.jpg");
            const upstreamReq = await fetch(FALCON_URL, {
                method: "POST",
                body: upstreamForm,
            });
            if (!upstreamReq.ok) {
                throw new Error(`mac_tensor ${upstreamReq.status}: ${(await upstreamReq.text()).slice(0, 200)}`);
            }
            const data = await upstreamReq.json();
            upstreamCount = data.count ?? 0;
            imgW = data.image_size?.[0] ?? data.width ?? 0;
            imgH = data.image_size?.[1] ?? data.height ?? 0;
            // mac_tensor returns masks: [{bbox_norm:{x1,y1,x2,y2}, area_fraction, label?, score?, ref_filename?}]
            // The label/score/ref_filename are present in identify-mode (CLIP retrieval).
            // Construct an absolute ref_url from the upstream base + filename so the
            // browser can render the reference card image directly without an extra
            // proxy hop.
            const upstreamBase = new URL(FALCON_URL);
            upstreamBase.pathname = "/refs/";
            for (const m of data.masks ?? []) {
                const bn = m.bbox_norm ?? {};
                if (bn.x1 == null) continue;
                let ref_url: string | undefined = undefined;
                if (typeof m.ref_filename === "string" && m.ref_filename) {
                    ref_url = upstreamBase.toString() + m.ref_filename;
                }
                bboxes.push({
                    x1: bn.x1,
                    y1: bn.y1,
                    x2: bn.x2,
                    y2: bn.y2,
                    score: typeof m.score === "number" ? m.score : (m.area_fraction ?? 1),
                    label: typeof m.label === "string" && m.label ? m.label : query,
                    ref_url,
                    margin: typeof m.margin === "number" ? m.margin : undefined,
                    confident: typeof m.confident === "boolean" ? m.confident : undefined,
                });
            }
        }

        return NextResponse.json({
            ok: true,
            count: upstreamCount || bboxes.length,
            bboxes,
            image_size: { w: imgW, h: imgH },
            elapsed_ms: Date.now() - t0,
            upstream: IS_RUNPOD ? "runpod" : "local",
        });
    } catch (e) {
        return NextResponse.json(
            {
                ok: false,
                error: String(e),
                elapsed_ms: Date.now() - t0,
                hint: "Make sure FALCON_URL in web/.env.local points at a reachable Falcon endpoint, and that the upstream server is running.",
            },
            { status: 502 },
        );
    }
}
