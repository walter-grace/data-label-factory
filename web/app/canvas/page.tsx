"use client";

import { useEffect, useState, useMemo } from "react";
import { BboxCanvas } from "@/components/BboxCanvas";
import { colorForQuery } from "@/components/BboxOverlay";
import type { ImageReview } from "@/lib/types";

type LoadedImage = ImageReview & { url: string };

export default function CanvasPage() {
    const [images, setImages] = useState<LoadedImage[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [bucketFilter, setBucketFilter] = useState<string>("all");
    const [selectedIdx, setSelectedIdx] = useState<number>(0);
    const [activeBbox, setActiveBbox] = useState<number | null>(null);

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

    const bucketCounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const i of images) m.set(i.bucket, (m.get(i.bucket) ?? 0) + 1);
        return m;
    }, [images]);

    const queryStats = useMemo(() => {
        if (!current) return [] as { query: string; count: number; yes: number; no: number }[];
        const m = new Map<string, { query: string; count: number; yes: number; no: number }>();
        for (const b of current.bboxes) {
            const e = m.get(b.query) ?? { query: b.query, count: 0, yes: 0, no: 0 };
            e.count++;
            if (b.vlm_verdict === "YES") e.yes++;
            if (b.vlm_verdict === "NO") e.no++;
            m.set(b.query, e);
        }
        return Array.from(m.values()).sort((a, b) => b.count - a.count);
    }, [current]);

    // Keyboard navigation
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement) return;
            if (e.key === "ArrowRight" || e.key === "j") {
                setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
                setActiveBbox(null);
            } else if (e.key === "ArrowLeft" || e.key === "k") {
                setSelectedIdx((i) => Math.max(i - 1, 0));
                setActiveBbox(null);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [filtered.length]);

    if (loading) {
        return (
            <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
                <div className="text-2xl">Loading…</div>
            </main>
        );
    }

    if (error) {
        return (
            <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
                <h1 className="text-3xl font-bold mb-4">drone-falcon · canvas review</h1>
                <div className="rounded-lg border border-red-800 bg-red-950 p-6 text-red-200">
                    Error: {error}
                </div>
            </main>
        );
    }

    const buckets = ["all", ...Array.from(bucketCounts.keys()).sort()];
    const total = images.length;
    const totalApproved = images.filter((i) => i.image_verdict === "approved").length;
    const totalRejected = images.filter((i) => i.image_verdict === "rejected").length;

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-50 font-sans">
            {/* Header */}
            <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur px-6 py-4 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
                        drone-falcon <span className="text-zinc-500">/</span> canvas review
                    </h1>
                    <p className="text-sm text-zinc-300 mt-0.5">
                        HTML5 Canvas viewer — <span className="text-zinc-100">drag</span> to pan,{" "}
                        <span className="text-zinc-100">scroll</span> to zoom,{" "}
                        <span className="text-zinc-100">double-click</span> to reset
                    </p>
                </div>
                <div className="flex items-center gap-2 text-sm">
                    <a href="/" className="text-zinc-300 hover:text-zinc-50 underline-offset-4 hover:underline mr-2">
                        ← grid view
                    </a>
                    <span className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-zinc-100 font-medium">
                        {total.toLocaleString()} labeled
                    </span>
                    <span className="rounded-md border border-emerald-600/60 bg-emerald-500/10 px-2.5 py-1 text-emerald-300 font-medium">
                        {totalApproved} approved
                    </span>
                    <span className="rounded-md border border-red-600/60 bg-red-500/10 px-2.5 py-1 text-red-300 font-medium">
                        {totalRejected} rejected
                    </span>
                </div>
            </header>

            {/* Bucket tabs */}
            <div className="border-b border-zinc-800 bg-zinc-950 px-6 py-3">
                <div className="flex flex-wrap items-center gap-2">
                    {buckets.map((b) => {
                        const active = bucketFilter === b;
                        const count = b === "all" ? total : (bucketCounts.get(b) ?? 0);
                        const label = b === "all" ? "All" : b;
                        return (
                            <button
                                key={b}
                                onClick={() => { setBucketFilter(b); setSelectedIdx(0); setActiveBbox(null); }}
                                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors border ${
                                    active
                                        ? "bg-zinc-50 text-zinc-950 border-zinc-50"
                                        : "bg-zinc-900 text-zinc-200 border-zinc-700 hover:bg-zinc-800 hover:text-zinc-50"
                                }`}
                            >
                                {label}
                                <span className={`ml-1.5 text-xs ${active ? "text-zinc-500" : "text-zinc-400"}`}>
                                    {count}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Main canvas + sidebars */}
            <div className="grid grid-cols-12 gap-4 p-4">
                {/* Thumbnail strip */}
                <div className="col-span-2 min-w-0 max-h-[calc(100vh-180px)] overflow-y-auto pr-2 space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400 px-1 pb-1">
                        Images ({filtered.length})
                    </div>
                    {filtered.slice(0, 200).map((img, idx) => (
                        <button
                            key={img.image_path}
                            onClick={() => { setSelectedIdx(idx); setActiveBbox(null); }}
                            className={`block w-full overflow-hidden rounded-md border-2 transition-all ${
                                idx === selectedIdx
                                    ? "border-blue-500 ring-2 ring-blue-500/30"
                                    : "border-zinc-800 hover:border-zinc-500"
                            }`}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img.url} alt="" className="w-full h-20 object-cover" />
                            <div className="bg-zinc-900 px-2 py-1 text-xs text-zinc-200 font-medium text-left">
                                {img.bboxes.length} detections
                            </div>
                        </button>
                    ))}
                </div>

                {/* Canvas area */}
                <div className="col-span-7 min-w-0">
                    {current ? (
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 min-w-0">
                            <div className="flex items-center justify-between mb-3">
                                <div className="text-sm font-mono text-zinc-200 truncate">
                                    {current.image_path}
                                </div>
                                <div className="text-sm text-zinc-300 font-medium whitespace-nowrap ml-3">
                                    {current.width}×{current.height} · {current.bboxes.length} bboxes ·{" "}
                                    <span className="text-zinc-50">{selectedIdx + 1}</span>
                                    <span className="text-zinc-500">/{filtered.length}</span>
                                </div>
                            </div>
                            <BboxCanvas
                                src={current.url}
                                width={current.width}
                                height={current.height}
                                bboxes={current.bboxes.map((b, idx) => ({ ...b, idx }))}
                                activeIdx={activeBbox}
                                onBboxClick={setActiveBbox}
                                aspectRatio={16 / 10}
                            />
                            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-300">
                                <span className="flex items-center gap-1.5">
                                    <kbd className="bg-zinc-800 border border-zinc-700 text-zinc-100 px-1.5 py-0.5 rounded text-xs font-mono">←</kbd>
                                    <kbd className="bg-zinc-800 border border-zinc-700 text-zinc-100 px-1.5 py-0.5 rounded text-xs font-mono">→</kbd>
                                    navigate
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <kbd className="bg-zinc-800 border border-zinc-700 text-zinc-100 px-1.5 py-0.5 rounded text-xs font-mono">scroll</kbd>
                                    zoom
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <kbd className="bg-zinc-800 border border-zinc-700 text-zinc-100 px-1.5 py-0.5 rounded text-xs font-mono">shift+drag</kbd>
                                    pan
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <kbd className="bg-zinc-800 border border-zinc-700 text-zinc-100 px-1.5 py-0.5 rounded text-xs font-mono">dblclick</kbd>
                                    reset view
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <kbd className="bg-zinc-800 border border-zinc-700 text-zinc-100 px-1.5 py-0.5 rounded text-xs font-mono">click</kbd>
                                    select bbox
                                </span>
                            </div>
                        </div>
                    ) : (
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-zinc-300 text-center">
                            No images in this bucket
                        </div>
                    )}
                </div>

                {/* Sidebar: bbox details */}
                <div className="col-span-3 min-w-0 max-h-[calc(100vh-180px)] overflow-y-auto space-y-4 pr-1">
                    {/* Selected bbox */}
                    {activeBbox !== null && current && (() => {
                        const b = current.bboxes[activeBbox];
                        return (
                            <div className="rounded-lg border-2 border-blue-500 bg-zinc-900 p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="text-sm font-bold text-blue-300 uppercase tracking-wide">
                                        Bbox #{activeBbox + 1}
                                    </div>
                                    <button
                                        onClick={() => setActiveBbox(null)}
                                        className="text-zinc-400 hover:text-zinc-100 text-sm"
                                    >
                                        ✕
                                    </button>
                                </div>
                                <div className="flex items-center gap-2 mb-3">
                                    <span
                                        className="inline-block w-3 h-3 rounded-sm border border-zinc-600"
                                        style={{ backgroundColor: colorForQuery(b.query) }}
                                    />
                                    <span className="text-sm text-zinc-100 font-medium">{b.query}</span>
                                </div>
                                <div className="text-xs text-zinc-400 mb-2">Detected by Falcon</div>
                                {b.vlm_verdict && (
                                    <div className="mt-3 pt-3 border-t border-zinc-800">
                                        <div className="text-xs text-zinc-400 mb-1">Qwen verdict</div>
                                        <div className={`text-base font-bold ${
                                            b.vlm_verdict === "YES" ? "text-emerald-400" :
                                            b.vlm_verdict === "NO" ? "text-red-400" :
                                            "text-amber-400"
                                        }`}>
                                            {b.vlm_verdict}
                                        </div>
                                        {b.vlm_reasoning && (
                                            <div className="text-zinc-300 italic mt-2 text-sm leading-relaxed">
                                                &ldquo;{b.vlm_reasoning}&rdquo;
                                            </div>
                                        )}
                                    </div>
                                )}
                                <div className="text-xs text-zinc-400 font-mono mt-3 pt-3 border-t border-zinc-800">
                                    <div>x1: {Math.round(b.x1)}  y1: {Math.round(b.y1)}</div>
                                    <div>x2: {Math.round(b.x2)}  y2: {Math.round(b.y2)}</div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* Per-query summary */}
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                        <div className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-3">
                            Queries on this image
                        </div>
                        <div className="space-y-2">
                            {queryStats.map((qs) => (
                                <div key={qs.query} className="flex items-center justify-between text-sm">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span
                                            className="h-3 w-3 rounded-sm border border-zinc-600 flex-shrink-0"
                                            style={{ backgroundColor: colorForQuery(qs.query) }}
                                        />
                                        <span className="text-zinc-100 truncate">{qs.query}</span>
                                    </div>
                                    <span className="text-zinc-300 font-medium whitespace-nowrap ml-2">
                                        {qs.count}
                                        {qs.yes > 0 && <span className="text-emerald-400 ml-1.5">✓{qs.yes}</span>}
                                        {qs.no > 0 && <span className="text-red-400 ml-1">✗{qs.no}</span>}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Controls */}
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                        <div className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-3">
                            Navigate
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => { setSelectedIdx((i) => Math.max(i - 1, 0)); setActiveBbox(null); }}
                                className="flex-1 px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm font-medium border border-zinc-700 transition-colors"
                            >
                                ← Previous
                            </button>
                            <button
                                onClick={() => { setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1)); setActiveBbox(null); }}
                                className="flex-1 px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm font-medium border border-zinc-700 transition-colors"
                            >
                                Next →
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
