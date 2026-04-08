"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { BboxOverlay, colorForQuery, type AnnotatedBbox } from "@/components/BboxOverlay";
import type { ImageReview } from "@/lib/types";

type LoadedImage = ImageReview & { url: string };

export default function Home() {
    const [images, setImages] = useState<LoadedImage[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [bucketFilter, setBucketFilter] = useState<string>("all");
    const [selectedIdx, setSelectedIdx] = useState<number>(0);
    const [activeBbox, setActiveBbox] = useState<number | null>(null);
    const cardRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetch("/api/labels")
            .then((r) => r.json())
            .then((data) => {
                if (data.error) setError(data.error);
                else setImages(data.images ?? []);
            })
            .catch((e) => setError(String(e)))
            .finally(() => setLoading(false));
    }, []);

    const filtered = useMemo(() => {
        if (bucketFilter === "all") return images;
        return images.filter((i) => i.bucket === bucketFilter);
    }, [images, bucketFilter]);

    const current = filtered[selectedIdx];

    const annotated: AnnotatedBbox[] = useMemo(() => {
        if (!current) return [];
        return current.bboxes.map((b, idx) => ({ ...b, idx }));
    }, [current]);

    const queryStats = useMemo(() => {
        if (!current) return [] as { query: string; count: number; approved: number; rejected: number }[];
        const m = new Map<string, { query: string; count: number; approved: number; rejected: number }>();
        for (const b of current.bboxes) {
            const e = m.get(b.query) ?? { query: b.query, count: 0, approved: 0, rejected: 0 };
            e.count++;
            if (b.verdict === "approved") e.approved++;
            if (b.verdict === "rejected") e.rejected++;
            m.set(b.query, e);
        }
        return Array.from(m.values()).sort((a, b) => b.count - a.count);
    }, [current]);

    const totalReviewed = images.filter((i) => i.image_verdict).length;
    const totalApproved = images.filter((i) => i.image_verdict === "approved").length;
    const totalRejected = images.filter((i) => i.image_verdict === "rejected").length;

    const bucketCounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const i of images) m.set(i.bucket, (m.get(i.bucket) ?? 0) + 1);
        return m;
    }, [images]);

    const saveReview = useCallback(async (img: LoadedImage) => {
        try {
            const res = await fetch("/api/labels", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(img),
            });
            const data = await res.json();
            if (data.ok) toast.success(`Saved (${data.total_reviewed} reviewed)`);
            else toast.error(data.error ?? "save failed");
        } catch (e) {
            toast.error(String(e));
        }
    }, []);

    const setImageVerdict = useCallback(
        (verdict: "approved" | "rejected" | "unsure") => {
            if (!current) return;
            const updated = { ...current, image_verdict: verdict };
            setImages((prev) => prev.map((p) => (p.image_path === current.image_path ? updated : p)));
            saveReview(updated);
            setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
            setActiveBbox(null);
        },
        [current, filtered.length, saveReview],
    );

    const setBboxVerdict = useCallback(
        (idx: number, verdict: "approved" | "rejected" | "unsure") => {
            if (!current) return;
            const newBboxes = current.bboxes.map((b, i) => (i === idx ? { ...b, verdict } : b));
            const updated = { ...current, bboxes: newBboxes };
            setImages((prev) => prev.map((p) => (p.image_path === current.image_path ? updated : p)));
            saveReview(updated);
        },
        [current, saveReview],
    );

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement) return;
            if (e.key === "ArrowRight" || e.key === "j") {
                setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
                setActiveBbox(null);
            } else if (e.key === "ArrowLeft" || e.key === "k") {
                setSelectedIdx((i) => Math.max(i - 1, 0));
                setActiveBbox(null);
            } else if (e.key === "y") {
                setImageVerdict("approved");
            } else if (e.key === "n") {
                setImageVerdict("rejected");
            } else if (e.key === "u") {
                setImageVerdict("unsure");
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [filtered.length, setImageVerdict]);

    if (loading) {
        return (
            <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
                <div className="text-2xl">Loading labels from R2…</div>
            </main>
        );
    }

    if (error) {
        return (
            <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
                <h1 className="text-3xl font-bold mb-4">drone-falcon factory</h1>
                <Card className="bg-red-950 border-red-800">
                    <CardContent className="pt-6">
                        <div className="text-red-300">Error: {error}</div>
                        <div className="text-zinc-400 mt-2 text-sm">
                            The labeling pod is probably still running. Sync labels/partial.json to R2 to see them here.
                        </div>
                    </CardContent>
                </Card>
            </main>
        );
    }

    const buckets = ["all", ...Array.from(bucketCounts.keys()).sort()];

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100">
            <Toaster theme="dark" position="bottom-right" />

            <header className="border-b border-zinc-800 px-6 py-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">drone-falcon · review factory</h1>
                        <p className="text-sm text-zinc-400">human verification of Falcon Perception bboxes</p>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                        <Badge variant="outline" className="border-zinc-700 text-zinc-300">{images.length} labeled</Badge>
                        <Badge variant="outline" className="border-emerald-700 text-emerald-400">{totalApproved} approved</Badge>
                        <Badge variant="outline" className="border-red-700 text-red-400">{totalRejected} rejected</Badge>
                        <Badge variant="outline" className="border-zinc-700 text-zinc-300">{totalReviewed}/{images.length} reviewed</Badge>
                    </div>
                </div>
            </header>

            <div className="border-b border-zinc-800 px-6 py-2">
                <Tabs value={bucketFilter} onValueChange={(v) => { setBucketFilter(v); setSelectedIdx(0); }}>
                    <TabsList className="bg-zinc-900">
                        {buckets.map((b) => (
                            <TabsTrigger key={b} value={b} className="data-[state=active]:bg-zinc-800">
                                {b === "all" ? `All (${images.length})` : `${b} (${bucketCounts.get(b) ?? 0})`}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </Tabs>
            </div>

            <div className="grid grid-cols-12 gap-4 p-4">
                <div className="col-span-2 max-h-[calc(100vh-180px)] overflow-y-auto pr-2 space-y-2">
                    {filtered.map((img, idx) => (
                        <button
                            key={img.image_path}
                            onClick={() => { setSelectedIdx(idx); setActiveBbox(null); }}
                            className={`block w-full overflow-hidden rounded border-2 transition-all ${
                                idx === selectedIdx ? "border-blue-500" : "border-zinc-800 hover:border-zinc-600"
                            }`}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img.url} alt="" className="w-full h-20 object-cover" />
                            <div className="bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-400 flex justify-between">
                                <span>{img.bboxes.length} dets</span>
                                <span>
                                    {img.image_verdict === "approved" && "✓"}
                                    {img.image_verdict === "rejected" && "✗"}
                                </span>
                            </div>
                        </button>
                    ))}
                </div>

                <div className="col-span-7" ref={cardRef}>
                    {current ? (
                        <Card className="bg-zinc-900 border-zinc-800">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-base font-mono text-zinc-300 truncate">{current.image_path}</CardTitle>
                                <div className="text-xs text-zinc-500">
                                    {current.width}×{current.height} · {current.bboxes.length} bboxes · {selectedIdx + 1}/{filtered.length}
                                </div>
                            </CardHeader>
                            <CardContent>
                                <BboxOverlay
                                    src={current.url}
                                    width={current.width}
                                    height={current.height}
                                    bboxes={annotated}
                                    activeIdx={activeBbox}
                                    onBboxClick={(idx) => setActiveBbox(idx)}
                                />
                                <div className="mt-4 flex gap-2">
                                    <Button onClick={() => setImageVerdict("approved")} className="bg-emerald-700 hover:bg-emerald-600">
                                        ✓ Approve image (Y)
                                    </Button>
                                    <Button onClick={() => setImageVerdict("rejected")} variant="destructive">
                                        ✗ Reject image (N)
                                    </Button>
                                    <Button onClick={() => setImageVerdict("unsure")} variant="outline" className="border-zinc-700">
                                        ? Unsure (U)
                                    </Button>
                                    <div className="flex-1" />
                                    <Button onClick={() => { setSelectedIdx((i) => Math.max(i - 1, 0)); setActiveBbox(null); }} variant="outline" className="border-zinc-700">←</Button>
                                    <Button onClick={() => { setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1)); setActiveBbox(null); }} variant="outline" className="border-zinc-700">→</Button>
                                </div>
                                <div className="mt-2 text-xs text-zinc-500">
                                    Shortcuts: <kbd>Y</kbd> approve · <kbd>N</kbd> reject · <kbd>U</kbd> unsure · <kbd>←</kbd> <kbd>→</kbd> navigate · click a bbox to select
                                </div>
                            </CardContent>
                        </Card>
                    ) : (
                        <Card className="bg-zinc-900 border-zinc-800">
                            <CardContent className="pt-6 text-zinc-400">No images in this bucket</CardContent>
                        </Card>
                    )}
                </div>

                <div className="col-span-3 max-h-[calc(100vh-180px)] overflow-y-auto">
                    <Card className="bg-zinc-900 border-zinc-800">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm">Per-query bboxes</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {queryStats.map((qs) => (
                                <div key={qs.query} className="space-y-1">
                                    <div className="flex items-center justify-between text-xs">
                                        <div className="flex items-center gap-2">
                                            <span className="h-3 w-3 rounded" style={{ backgroundColor: colorForQuery(qs.query) }} />
                                            <span className="font-medium">{qs.query}</span>
                                        </div>
                                        <span className="text-zinc-500">
                                            {qs.count}
                                            {qs.approved > 0 && <span className="text-emerald-500"> ✓{qs.approved}</span>}
                                            {qs.rejected > 0 && <span className="text-red-500"> ✗{qs.rejected}</span>}
                                        </span>
                                    </div>
                                </div>
                            ))}
                            {activeBbox !== null && current && (() => {
                                const bbox = current.bboxes[activeBbox];
                                return (
                                    <div className="border-t border-zinc-800 pt-3 mt-3">
                                        <div className="text-xs font-bold mb-2">Selected bbox #{activeBbox + 1}</div>
                                        <div className="text-xs text-zinc-400 mb-1">Falcon: {bbox.query}</div>
                                        {bbox.vlm_verdict && (
                                            <div className="text-xs mb-2">
                                                <span className="text-zinc-500">Qwen: </span>
                                                <span className={
                                                    bbox.vlm_verdict === "YES" ? "text-emerald-400" :
                                                    bbox.vlm_verdict === "NO" ? "text-red-400" :
                                                    "text-amber-400"
                                                }>
                                                    {bbox.vlm_verdict}
                                                </span>
                                                {bbox.vlm_reasoning && (
                                                    <div className="text-zinc-400 italic mt-1 text-[11px]">
                                                        &ldquo;{bbox.vlm_reasoning}&rdquo;
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <div className="flex gap-1 mt-2">
                                            <Button size="sm" className="bg-emerald-700 hover:bg-emerald-600 text-xs h-7" onClick={() => setBboxVerdict(activeBbox, "approved")}>✓</Button>
                                            <Button size="sm" variant="destructive" className="text-xs h-7" onClick={() => setBboxVerdict(activeBbox, "rejected")}>✗</Button>
                                            <Button size="sm" variant="outline" className="text-xs h-7 border-zinc-700" onClick={() => setBboxVerdict(activeBbox, "unsure")}>?</Button>
                                        </div>
                                    </div>
                                );
                            })()}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </main>
    );
}
