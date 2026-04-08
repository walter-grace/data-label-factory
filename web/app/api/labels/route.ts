import { NextResponse } from "next/server";
import { getJson, putJson, presignGet } from "@/lib/r2";
import type { LabelPartial, ImageReview, VerifiedRun } from "@/lib/types";

/**
 * GET /api/labels
 *   → returns the labeled dataset converted to ImageReview[] format,
 *     with one presigned image URL per entry, plus Qwen VLM verdicts,
 *     plus any saved human reviews.
 *
 * Reads from R2:
 *   labels/partial.json          ← Falcon bboxes (live snapshot from pod)
 *   labels/run1.verified.json    ← Qwen yes/no verdict per bbox
 *   labels/reviews.json          ← Human verdicts (saved by this UI)
 */
export async function GET() {
    // Try the live partial first
    let partial = await getJson<LabelPartial>("labels/partial.json");
    if (!partial || !partial.results) {
        const finalRun = await getJson<LabelPartial>("labels/run1_partial.json");
        if (finalRun) partial = finalRun;
    }

    if (!partial || !partial.results) {
        return NextResponse.json({ images: [], total: 0, error: "no labels found in r2 yet" });
    }

    // Load Qwen verdicts (if they exist) — try run2 first, fall back to run1
    let verified = await getJson<VerifiedRun>("labels/run2.verified.json");
    if (!verified?.annotations) {
        verified = await getJson<VerifiedRun>("labels/run1.verified.json");
    }
    const verdictById = new Map<number, { verdict: "YES" | "NO" | "UNSURE"; reasoning: string }>();
    if (verified?.annotations) {
        for (const v of verified.annotations) {
            verdictById.set(v.annotation_id, { verdict: v.verdict, reasoning: v.reasoning });
        }
    }

    // Load any existing human reviews
    const reviews = (await getJson<Record<string, ImageReview>>("labels/reviews.json")) ?? {};

    const images: (ImageReview & { url: string })[] = [];
    for (const [path, res] of Object.entries(partial.results)) {
        if (res.error || !res.queries) continue;
        // Convert pod-side path to R2 key, supporting both v1 and v2 layouts:
        //   /workspace/images/...        → raw/...        (v1)
        //   /workspace/images_v2/...     → raw_v2/...     (v2)
        let r2Key: string;
        const idx2 = path.indexOf("/images_v2/");
        const idx1 = path.indexOf("/images/");
        if (idx2 !== -1) {
            r2Key = "raw_v2/" + path.slice(idx2 + "/images_v2/".length);
        } else if (idx1 !== -1) {
            r2Key = "raw/" + path.slice(idx1 + "/images/".length);
        } else {
            continue;
        }
        const stripPrefix = r2Key.startsWith("raw_v2/") ? "raw_v2/" : "raw/";
        const bucket = r2Key.slice(stripPrefix.length).split("/").slice(0, 2).join("/");

        // Flatten queries → bboxes with query labels + Qwen verdicts
        const flatBboxes: ImageReview["bboxes"] = [];
        for (const [query, qres] of Object.entries(res.queries)) {
            if (qres.error) continue;
            for (const b of qres.bboxes) {
                const v = b.annotation_id != null ? verdictById.get(b.annotation_id) : undefined;
                flatBboxes.push({
                    ...b,
                    query,
                    vlm_verdict: v?.verdict,
                    vlm_reasoning: v?.reasoning,
                });
            }
        }
        if (flatBboxes.length === 0) continue;  // skip empty for now

        const existing = reviews[r2Key];
        // Merge existing verdicts onto fresh bboxes (match by index for now)
        if (existing) {
            for (let i = 0; i < flatBboxes.length && i < existing.bboxes.length; i++) {
                flatBboxes[i].verdict = existing.bboxes[i].verdict;
                flatBboxes[i].note = existing.bboxes[i].note;
            }
        }

        const url = await presignGet(r2Key, 3600);

        images.push({
            image_path: r2Key,
            bucket,
            width: res.width,
            height: res.height,
            bboxes: flatBboxes,
            image_verdict: existing?.image_verdict,
            reviewed_at: existing?.reviewed_at,
            url,
        });
    }

    // Sort by bucket priority (positive first, then most detections)
    const PRIORITY: Record<string, number> = {
        "positive/fiber_spool_drone": 0,
        "positive/spool_only": 1,
        "distractor/round_things": 2,
        "negative/drones_no_spool": 3,
        "background/empty": 4,
    };
    images.sort((a, b) => {
        const pa = PRIORITY[a.bucket] ?? 99;
        const pb = PRIORITY[b.bucket] ?? 99;
        if (pa !== pb) return pa - pb;
        return b.bboxes.length - a.bboxes.length;
    });

    return NextResponse.json({ images, total: images.length });
}

/**
 * POST /api/labels — save a single image's review back to R2.
 */
export async function POST(req: Request) {
    const body = (await req.json()) as ImageReview;
    if (!body.image_path) {
        return NextResponse.json({ error: "missing image_path" }, { status: 400 });
    }
    const reviews = (await getJson<Record<string, ImageReview>>("labels/reviews.json")) ?? {};
    reviews[body.image_path] = { ...body, reviewed_at: new Date().toISOString() };
    await putJson("labels/reviews.json", reviews);
    return NextResponse.json({ ok: true, total_reviewed: Object.keys(reviews).length });
}
