"use client";

import { useState, useRef, useEffect } from "react";

type LabeledSite = {
    index: number;
    url: string;
    hash: string;
    title: string;
    screenshotB64: string;
    omniCount: number;
    omniElements: any[];
    domBounds?: any[];
    gemmaAdded?: number;
    gemmaTotal?: number;
    gemmaElements?: any[];
    elapsed?: number;
    error?: string;
};

type PipelineStats = {
    ok: number;
    fail: number;
    totalOmni: number;
    totalGemma: number;
    avgOmni: string;
    avgGemma: string;
    gemmaAdded: number;
};

export default function PipelinePage() {
    const [count, setCount] = useState(20);
    const [cycles, setCycles] = useState(1);
    const [crawlDepth, setCrawlDepth] = useState(1);
    const [currentCycle, setCurrentCycle] = useState(0);
    const [skipGemma, setSkipGemma] = useState(false);
    const [cycleStats, setCycleStats] = useState<{ cycle: number; omni: number; gemma: number; delta: number }[]>([]);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState({ step: "", index: 0, total: 0, url: "", pct: 0 });
    const [sites, setSites] = useState<LabeledSite[]>([]);
    const [stats, setStats] = useState<PipelineStats | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [selectedSite, setSelectedSite] = useState<LabeledSite | null>(null);
    const [hoveredEl, setHoveredEl] = useState<number | null>(null);
    const [showOmni, setShowOmni] = useState(true);
    const [showGemma, setShowGemma] = useState(true);
    const detailCanvasRef = useRef<HTMLCanvasElement>(null);
    const detailImgRef = useRef<HTMLImageElement | null>(null);
    const esRef = useRef<EventSource | null>(null);

    const COLORS = [
        "#FF3366", "#33FF66", "#3366FF", "#FF9933", "#FF33CC",
        "#33FFCC", "#CC33FF", "#FFCC33", "#33CCFF", "#FF6633",
        "#66FF33", "#9933FF", "#FF3399", "#33FF99", "#3399FF",
    ];

    // Draw bboxes on the detail canvas when a site is selected
    useEffect(() => {
        if (!selectedSite?.screenshotB64 || !detailCanvasRef.current) return;
        const canvas = detailCanvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const img = new Image();
        img.onload = () => {
            detailImgRef.current = img;
            canvas.width = img.width;
            canvas.height = img.height;
            drawBboxes(ctx, img, selectedSite.omniElements, selectedSite.gemmaElements ?? [], hoveredEl, showOmni, showGemma);
        };
        img.src = `data:image/png;base64,${selectedSite.screenshotB64}`;
    }, [selectedSite]);

    // Redraw on hover/toggle change
    useEffect(() => {
        if (!detailCanvasRef.current || !detailImgRef.current || !selectedSite) return;
        const ctx = detailCanvasRef.current.getContext("2d");
        if (!ctx) return;
        drawBboxes(ctx, detailImgRef.current, selectedSite.omniElements, selectedSite.gemmaElements ?? [], hoveredEl, showOmni, showGemma);
    }, [hoveredEl, selectedSite, showOmni, showGemma]);

    function drawBboxes(
        ctx: CanvasRenderingContext2D, img: HTMLImageElement,
        omniElements: any[], gemmaElements: any[],
        hovered: number | null, drawOmni: boolean, drawGemma: boolean,
    ) {
        ctx.drawImage(img, 0, 0);
        const W = img.width;
        const H = img.height;

        // OmniParser detections (colored)
        if (drawOmni) {
            for (let i = 0; i < omniElements.length; i++) {
                const el = omniElements[i];
                const bbox = el.bbox_px ?? el.bbox_norm;
                if (!bbox) continue;
                let x1 = bbox.x1, y1 = bbox.y1, x2 = bbox.x2, y2 = bbox.y2;
                if (x2 <= 1.5) { x1 *= W; y1 *= H; x2 *= W; y2 *= H; }
                const w = x2 - x1, h = y2 - y1;
                if (w < 2 || h < 2) continue;

                const color = COLORS[i % COLORS.length];
                const isHovered = hovered === i;
                ctx.fillStyle = color + (isHovered ? "4d" : "1a");
                ctx.fillRect(x1, y1, w, h);
                ctx.strokeStyle = color;
                ctx.lineWidth = isHovered ? 4 : 2;
                ctx.strokeRect(x1, y1, w, h);

                const tag = el.tag ?? "?";
                const conf = el.confidence ? `${(el.confidence * 100).toFixed(0)}%` : "";
                const label = `<${tag}> ${conf}`;
                ctx.font = "bold 11px monospace";
                const tw = ctx.measureText(label).width;
                const ly = Math.max(0, y1 - 16);
                ctx.fillStyle = color;
                ctx.fillRect(x1, ly, tw + 6, 15);
                ctx.fillStyle = "#fff";
                ctx.fillText(label, x1 + 3, ly + 11);
            }
        }

        // Gemma additions (orange, dashed border)
        if (drawGemma && gemmaElements.length > 0) {
            for (let i = 0; i < gemmaElements.length; i++) {
                const el = gemmaElements[i];
                let x1 = el.x1 ?? 0, y1 = el.y1 ?? 0, x2 = el.x2 ?? 0, y2 = el.y2 ?? 0;
                // Gemma returns normalized 0-1 coords
                if (x2 <= 1.5) { x1 *= W; y1 *= H; x2 *= W; y2 *= H; }
                const w = x2 - x1, h = y2 - y1;
                if (w < 2 || h < 2) continue;

                const gIdx = omniElements.length + i;
                const isHovered = hovered === gIdx;

                // Orange fill
                ctx.fillStyle = isHovered ? "rgba(255, 165, 0, 0.25)" : "rgba(255, 165, 0, 0.1)";
                ctx.fillRect(x1, y1, w, h);

                // Dashed orange border
                ctx.setLineDash([6, 3]);
                ctx.strokeStyle = "#ff8c00";
                ctx.lineWidth = isHovered ? 4 : 2;
                ctx.strokeRect(x1, y1, w, h);
                ctx.setLineDash([]);

                // Label
                const label = el.label ?? `gemma-${i + 1}`;
                ctx.font = "bold 11px monospace";
                const tw = ctx.measureText(label).width;
                const ly = Math.max(0, y1 - 16);
                ctx.fillStyle = "#ff8c00";
                ctx.fillRect(x1, ly, tw + 6, 15);
                ctx.fillStyle = "#000";
                ctx.fillText(label, x1 + 3, ly + 11);
            }
        }
    }

    const runCycle = (cycleNum: number) => {
        setCurrentCycle(cycleNum);
        setLogs((p) => [...p, `\n═══ CYCLE ${cycleNum + 1} / ${cycles} ═══`]);

        const es = new EventSource(`/api/pipeline-run?count=${count}&skipGemma=${skipGemma}&crawlDepth=${crawlDepth}`);
        esRef.current = es;

        es.addEventListener("start", (e) => {
            const d = JSON.parse((e as MessageEvent).data);
            setLogs((p) => [...p, `Cycle ${cycleNum + 1}: started (${d.count} sites)`]);
        });

        es.addEventListener("progress", (e) => {
            const d = JSON.parse((e as MessageEvent).data);
            setProgress(d);
        });

        es.addEventListener("screenshot", (e) => {
            const d = JSON.parse((e as MessageEvent).data);
            setLogs((p) => [...p, `[${d.index + 1}] Screenshot: ${d.url} (${d.domCount} DOM elements)`]);
        });

        es.addEventListener("labeled", (e) => {
            const d = JSON.parse((e as MessageEvent).data);
            setSites((p) => [...p, d]);
            setLogs((p) => [...p, `[${d.index + 1}] OmniParser: ${d.omniCount} elements (${d.elapsed}s)`]);
        });

        es.addEventListener("gemma", (e) => {
            const d = JSON.parse((e as MessageEvent).data);
            setSites((p) =>
                p.map((s) => s.index === d.index ? { ...s, gemmaAdded: d.added, gemmaTotal: d.total, gemmaElements: d.gemmaElements ?? [] } : s)
            );
            setLogs((p) => [...p, `[${d.index + 1}] Gemma: +${d.added} elements (${d.total} total)`]);
        });

        es.addEventListener("error", (e) => {
            try {
                const d = JSON.parse((e as MessageEvent).data);
                setLogs((p) => [...p, `[${d.index + 1}] FAIL: ${d.url} — ${d.error}`]);
            } catch {}
        });

        es.addEventListener("complete", (e) => {
            const d = JSON.parse((e as MessageEvent).data);
            setStats(d);
            const delta = d.ok > 0 ? d.gemmaAdded / d.ok : 0;
            setCycleStats((p) => [...p, {
                cycle: cycleNum + 1,
                omni: d.totalOmni,
                gemma: d.totalGemma,
                delta: parseFloat(delta.toFixed(1)),
            }]);
            setLogs((p) => [...p,
                `Cycle ${cycleNum + 1} DONE: ${d.ok} ok | OmniParser: ${d.totalOmni} | +Gemma: +${d.gemmaAdded} (${delta.toFixed(1)}/img)`,
            ]);
            es.close();

            // Train + swap model + start next cycle
            const nextCycle = cycleNum + 1;
            if (nextCycle < cycles) {
                setLogs((p) => [...p, `\n⚡ TRAINING model v${cycleNum + 1} on ${sites.length} images...`]);
                setProgress({ step: "training", index: cycleNum, total: cycles, url: "Mac Mini", pct: Math.round(((cycleNum + 1) / cycles) * 100) });

                // Collect all labeled data accumulated so far
                const trainingData = sites.map((s) => {
                    // Build YOLO label lines from detections + gemma
                    const labelLines: string[] = [];
                    for (const el of s.omniElements) {
                        const bbox = el.bbox_norm ?? el.bbox_px;
                        if (!bbox) continue;
                        let x1 = bbox.x1, y1 = bbox.y1, x2 = bbox.x2, y2 = bbox.y2;
                        if (x2 > 1.5) { x1 /= 1280; y1 /= 800; x2 /= 1280; y2 /= 800; }
                        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
                        const w = x2 - x1, h = y2 - y1;
                        if (w > 0.005 && h > 0.005) labelLines.push(`0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`);
                    }
                    for (const el of (s.gemmaElements ?? [])) {
                        const x1 = el.x1 ?? 0, y1 = el.y1 ?? 0, x2 = el.x2 ?? 0, y2 = el.y2 ?? 0;
                        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
                        const w = x2 - x1, h = y2 - y1;
                        if (w > 0.005 && h > 0.005) labelLines.push(`0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`);
                    }
                    return { hash: s.hash, screenshotB64: s.screenshotB64, labels: labelLines.join("\n") };
                }).filter((d) => d.labels.length > 0);

                fetch("/api/pipeline-train", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ images: trainingData, epochs: 15, cycle: cycleNum }),
                })
                    .then((r) => r.json())
                    .then((trainResult) => {
                        if (trainResult.ok) {
                            setLogs((p) => [...p,
                                `✓ Model v${cycleNum + 1} trained on ${trainResult.trainImages} images (${trainResult.epochs} epochs)`,
                                trainResult.serverSwapped ? `✓ Falcon swapped to v${cycleNum + 1}: ${trainResult.modelPath}` : `⚠ Model saved but Falcon not swapped`,
                                `Starting cycle ${nextCycle + 1} with improved model...`,
                            ]);
                        } else {
                            setLogs((p) => [...p, `⚠ Training failed: ${trainResult.error} — continuing with current model`]);
                        }
                        // Start next cycle regardless (use whatever model is on the server)
                        setTimeout(() => runCycle(nextCycle), 2000);
                    })
                    .catch((e) => {
                        setLogs((p) => [...p, `⚠ Training error: ${String(e)} — continuing with current model`]);
                        setTimeout(() => runCycle(nextCycle), 2000);
                    });
            } else {
                // Final cycle — train one last time
                setLogs((p) => [...p, `\n⚡ Final training on all ${sites.length} accumulated images...`]);
                const finalData = sites.map((s) => {
                    const labelLines: string[] = [];
                    for (const el of s.omniElements) {
                        const bbox = el.bbox_norm ?? el.bbox_px;
                        if (!bbox) continue;
                        let x1 = bbox.x1, y1 = bbox.y1, x2 = bbox.x2, y2 = bbox.y2;
                        if (x2 > 1.5) { x1 /= 1280; y1 /= 800; x2 /= 1280; y2 /= 800; }
                        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
                        const w = x2 - x1, h = y2 - y1;
                        if (w > 0.005 && h > 0.005) labelLines.push(`0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`);
                    }
                    for (const el of (s.gemmaElements ?? [])) {
                        const x1 = el.x1 ?? 0, y1 = el.y1 ?? 0, x2 = el.x2 ?? 0, y2 = el.y2 ?? 0;
                        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
                        const w = x2 - x1, h = y2 - y1;
                        if (w > 0.005 && h > 0.005) labelLines.push(`0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`);
                    }
                    return { hash: s.hash, screenshotB64: s.screenshotB64, labels: labelLines.join("\n") };
                }).filter((d) => d.labels.length > 0);

                fetch("/api/pipeline-train", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ images: finalData, epochs: 30, cycle: cycleNum }),
                })
                    .then((r) => r.json())
                    .then((trainResult) => {
                        if (trainResult.ok) {
                            setLogs((p) => [...p,
                                `✓ Final model trained: ${trainResult.modelPath}`,
                                trainResult.serverSwapped ? `✓ Falcon running your trained model!` : `Model saved — swap manually`,
                                `\n✓ ALL ${cycles} CYCLES COMPLETE — model trained on ${sites.length} images`,
                            ]);
                        } else {
                            setLogs((p) => [...p, `⚠ Final training failed: ${trainResult.error}`, `\n✓ ALL ${cycles} CYCLES COMPLETE`]);
                        }
                        setRunning(false);
                    })
                    .catch((e) => {
                        setLogs((p) => [...p, `⚠ Training error: ${String(e)}`, `\n✓ ALL ${cycles} CYCLES COMPLETE`]);
                        setRunning(false);
                    });
            }
        });

        es.onerror = () => {
            setRunning(false);
            es.close();
        };
    };

    const start = () => {
        setRunning(true);
        setSites([]);
        setStats(null);
        setLogs([]);
        setSelectedSite(null);
        setCycleStats([]);
        runCycle(0);
    };

    const stop = () => {
        esRef.current?.close();
        setRunning(false);
    };

    const stepLabel = (step: string) => {
        switch (step) {
            case "screenshot": return "Screenshotting";
            case "omniparser": return "OmniParser";
            case "gemma": return "Gemma Check";
            case "training": return "Training YOLO";
            default: return step;
        }
    };

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100">
            {/* Header */}
            <div className="border-b border-zinc-800 bg-zinc-900 px-6 py-4">
                <div className="flex items-center gap-4 max-w-7xl mx-auto">
                    <a href="/inspector" className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition whitespace-nowrap">
                        Inspector
                    </a>
                    <a href="/pipeline" className="text-lg font-bold text-fuchsia-300 hover:text-fuchsia-200">
                        Auto-Research Pipeline
                    </a>
                    <div className="flex items-center gap-2 text-xs">
                        <label className="text-zinc-400">Sites:</label>
                        <input
                            type="number"
                            value={count}
                            onChange={(e) => setCount(Math.max(1, Math.min(200, parseInt(e.target.value) || 20)))}
                            className="w-16 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm font-mono"
                            disabled={running}
                        />
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                        <label className="text-zinc-400">Cycles:</label>
                        <input
                            type="number"
                            value={cycles}
                            onChange={(e) => setCycles(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                            className="w-16 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm font-mono"
                            disabled={running}
                        />
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                        <label className="text-zinc-400">Depth:</label>
                        <input
                            type="number"
                            value={crawlDepth}
                            onChange={(e) => setCrawlDepth(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                            className="w-16 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm font-mono"
                            disabled={running}
                            title="Pages per site (1 = homepage only, 5 = explore internal pages)"
                        />
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={skipGemma}
                            onChange={(e) => setSkipGemma(e.target.checked)}
                            className="accent-fuchsia-500"
                            disabled={running}
                        />
                        Skip Gemma
                    </label>
                    {!running ? (
                        <button
                            onClick={start}
                            className="px-5 py-2 rounded-lg text-sm font-bold bg-fuchsia-600 hover:bg-fuchsia-500 transition"
                        >
                            Start Pipeline
                        </button>
                    ) : (
                        <button
                            onClick={stop}
                            className="px-5 py-2 rounded-lg text-sm font-bold bg-red-600 hover:bg-red-500 transition"
                        >
                            Stop
                        </button>
                    )}
                </div>
            </div>

            {/* Progress bar */}
            {running && (
                <div className="bg-zinc-900 border-b border-zinc-800 px-6 py-3">
                    <div className="max-w-7xl mx-auto">
                        <div className="flex items-center gap-3 text-xs mb-2">
                            <span className="text-fuchsia-300 font-bold">{stepLabel(progress.step)}</span>
                            <span className="text-zinc-500">{progress.index + 1} / {progress.total}</span>
                            <span className="text-zinc-600 truncate flex-1">{progress.url}</span>
                            <span className="text-zinc-400 font-mono">{progress.pct}%</span>
                        </div>
                        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-fuchsia-500 transition-all duration-300 rounded-full"
                                style={{ width: `${progress.pct}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Cycle progress */}
            {cycleStats.length > 0 && (
                <div className="bg-zinc-900 border-b border-zinc-800 px-6 py-3">
                    <div className="max-w-7xl mx-auto">
                        <div className="text-xs font-bold text-zinc-400 uppercase mb-2">
                            Training Cycles ({cycleStats.length} / {cycles})
                        </div>
                        <div className="flex gap-3 overflow-x-auto">
                            {cycleStats.map((cs) => (
                                <div key={cs.cycle} className="flex-shrink-0 border border-zinc-700 rounded-lg px-3 py-2 bg-zinc-950 text-xs min-w-[140px]">
                                    <div className="text-fuchsia-300 font-bold">Cycle {cs.cycle}</div>
                                    <div className="text-zinc-400 mt-1">OmniParser: <span className="text-zinc-200">{cs.omni}</span></div>
                                    <div className="text-zinc-400">+Gemma: <span className="text-amber-300">+{cs.gemma - cs.omni}</span></div>
                                    <div className="text-zinc-400">Delta: <span className={cs.delta <= 2 ? "text-emerald-300 font-bold" : "text-amber-300"}>{cs.delta}/img</span></div>
                                </div>
                            ))}
                        </div>
                        {cycleStats.length >= 2 && (
                            <div className="text-[10px] text-zinc-500 mt-2">
                                Delta trend: {cycleStats.map((cs) => `${cs.delta}`).join(" → ")}
                                {cycleStats[cycleStats.length - 1].delta < cycleStats[0].delta && " ↓ improving"}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Stats summary (when complete) */}
            {stats && (
                <div className="bg-emerald-950/30 border-b border-emerald-800/50 px-6 py-4">
                    <div className="max-w-7xl mx-auto flex gap-8 text-sm">
                        <div><span className="text-zinc-400">Sites:</span> <span className="text-emerald-300 font-bold">{stats.ok}</span> ok, <span className="text-red-300">{stats.fail}</span> fail</div>
                        <div><span className="text-zinc-400">OmniParser:</span> <span className="text-fuchsia-300 font-bold">{stats.totalOmni}</span> elements ({stats.avgOmni}/img)</div>
                        {stats.gemmaAdded > 0 && (
                            <div><span className="text-zinc-400">+Gemma:</span> <span className="text-amber-300 font-bold">+{stats.gemmaAdded}</span> ({stats.avgGemma}/img)</div>
                        )}
                    </div>
                </div>
            )}

            <div className="max-w-7xl mx-auto p-6 flex gap-6">
                {/* Left: Screenshot grid */}
                <div className="flex-1">
                    {sites.length === 0 && !running && (
                        <div className="text-center text-zinc-600 py-20">
                            <div className="text-3xl mb-3">🔬</div>
                            <div>Set a count and click Start Pipeline</div>
                            <div className="text-xs text-zinc-700 mt-1">
                                Screenshots → OmniParser labels → Gemma augmentation → comparison stats
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                        {sites.map((site, siteIdx) => (
                            <button
                                key={`${site.hash}_${siteIdx}`}
                                onClick={() => setSelectedSite(site)}
                                className={`text-left rounded-lg overflow-hidden border transition-all hover:scale-[1.02] ${
                                    selectedSite?.hash === site.hash
                                        ? "border-fuchsia-500 shadow-lg shadow-fuchsia-500/20"
                                        : "border-zinc-800 hover:border-zinc-600"
                                }`}
                            >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={`data:image/png;base64,${site.screenshotB64}`}
                                    alt={site.title}
                                    className="w-full h-auto"
                                />
                                <div className="bg-zinc-900 px-2 py-1.5">
                                    <div className="text-[10px] text-zinc-300 truncate">{site.title || site.url}</div>
                                    <div className="flex gap-2 text-[10px] mt-0.5">
                                        <span className="text-fuchsia-300">{site.omniCount} det</span>
                                        {site.gemmaAdded !== undefined && (
                                            <span className="text-amber-300">+{site.gemmaAdded} gemma</span>
                                        )}
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Right: Detail panel + logs */}
                <div className="w-96 flex-shrink-0 space-y-4">
                    {/* Selected site — labeled screenshot + element list */}
                    {selectedSite && (
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
                            {/* Header */}
                            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
                                <div>
                                    <div className="text-xs font-bold text-fuchsia-300 truncate max-w-[250px]">
                                        {selectedSite.title || selectedSite.url}
                                    </div>
                                    <div className="text-[10px] text-zinc-500 font-mono truncate max-w-[250px]">{selectedSite.url}</div>
                                </div>
                                <button
                                    onClick={() => setSelectedSite(null)}
                                    className="text-zinc-500 hover:text-zinc-300 text-lg"
                                >×</button>
                            </div>

                            {/* Labeled screenshot canvas */}
                            <div className="p-2 bg-zinc-950">
                                <canvas
                                    ref={detailCanvasRef}
                                    className="w-full rounded border border-zinc-800"
                                />
                            </div>

                            {/* Stats bar + toggles */}
                            <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-4 text-xs">
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={showOmni}
                                        onChange={(e) => setShowOmni(e.target.checked)}
                                        className="accent-fuchsia-500"
                                    />
                                    <span className="text-fuchsia-300 font-bold">OmniParser ({selectedSite.omniCount})</span>
                                </label>
                                {(selectedSite.gemmaElements?.length ?? 0) > 0 && (
                                    <label className="flex items-center gap-1.5 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={showGemma}
                                            onChange={(e) => setShowGemma(e.target.checked)}
                                            className="accent-amber-500"
                                        />
                                        <span className="text-amber-300 font-bold">Gemma (+{selectedSite.gemmaAdded})</span>
                                    </label>
                                )}
                                {selectedSite.elapsed !== undefined && (
                                    <span className="text-zinc-500 ml-auto">{selectedSite.elapsed}s</span>
                                )}
                            </div>

                            {/* Element list — hover highlights bbox on canvas */}
                            {(selectedSite.omniElements.length > 0 || (selectedSite.gemmaElements?.length ?? 0) > 0) && (
                                <div className="px-4 py-3">
                                    {/* OmniParser elements */}
                                    {showOmni && selectedSite.omniElements.length > 0 && (
                                        <>
                                            <div className="text-[10px] text-fuchsia-400 uppercase font-bold mb-2">
                                                OmniParser ({selectedSite.omniElements.length})
                                            </div>
                                            <div className="space-y-1 max-h-40 overflow-y-auto mb-3">
                                                {selectedSite.omniElements.map((el, i) => (
                                                    <div
                                                        key={`omni-${i}`}
                                                        onMouseEnter={() => setHoveredEl(i)}
                                                        onMouseLeave={() => setHoveredEl(null)}
                                                        className={`flex items-center gap-2 text-[11px] px-2 py-1 rounded cursor-pointer transition ${
                                                            hoveredEl === i
                                                                ? "bg-zinc-800 border border-zinc-600"
                                                                : "border border-transparent hover:bg-zinc-800/50"
                                                        }`}
                                                    >
                                                        <div
                                                            className="w-2 h-2 rounded-sm flex-shrink-0"
                                                            style={{ backgroundColor: COLORS[i % COLORS.length] }}
                                                        />
                                                        <span className="text-zinc-300 font-mono">&lt;{el.tag}&gt;</span>
                                                        <span className="text-zinc-500 font-mono truncate flex-1">{el.selector?.slice(0, 30)}</span>
                                                        <span className="text-emerald-400 font-bold">{el.confidence ? `${(el.confidence * 100).toFixed(0)}%` : ""}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </>
                                    )}

                                    {/* Gemma elements */}
                                    {showGemma && (selectedSite.gemmaElements?.length ?? 0) > 0 && (
                                        <>
                                            <div className="text-[10px] text-amber-400 uppercase font-bold mb-2 pt-2 border-t border-zinc-800">
                                                Gemma Additions ({selectedSite.gemmaElements!.length})
                                            </div>
                                            <div className="space-y-1 max-h-40 overflow-y-auto">
                                                {selectedSite.gemmaElements!.map((el, i) => {
                                                    const gIdx = selectedSite.omniElements.length + i;
                                                    return (
                                                        <div
                                                            key={`gemma-${i}`}
                                                            onMouseEnter={() => setHoveredEl(gIdx)}
                                                            onMouseLeave={() => setHoveredEl(null)}
                                                            className={`flex items-center gap-2 text-[11px] px-2 py-1 rounded cursor-pointer transition ${
                                                                hoveredEl === gIdx
                                                                    ? "bg-amber-950/40 border border-amber-700"
                                                                    : "border border-transparent hover:bg-zinc-800/50"
                                                            }`}
                                                        >
                                                            <div className="w-2 h-2 rounded-sm flex-shrink-0 bg-orange-500" />
                                                            <span className="text-amber-200 truncate flex-1">{el.label ?? `element-${i + 1}`}</span>
                                                            <span className="text-zinc-500 font-mono text-[9px]">
                                                                ({(el.x1 ?? 0).toFixed(2)},{(el.y1 ?? 0).toFixed(2)})
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* Open in Inspector */}
                            <div className="px-4 pb-3">
                                <button
                                    onClick={() => {
                                        // Store the labeled data so inspector can load it directly
                                        // Build saved labels from Gemma elements
                                        const gemmaLabels = (selectedSite.gemmaElements ?? []).map((el: any, i: number) => ({
                                            name: el.label ?? `gemma-${i + 1}`,
                                            match: {
                                                tag: "div",
                                                selector: el.label ?? `gemma-${i + 1}`,
                                                id: null,
                                                classes: [],
                                                text: el.label ?? null,
                                                x1: (el.x1 ?? 0) * 1280,
                                                y1: (el.y1 ?? 0) * 800,
                                                x2: (el.x2 ?? 0) * 1280,
                                                y2: (el.y2 ?? 0) * 800,
                                            },
                                            color: `hsl(${30 + i * 20}, 90%, 50%)`,
                                            drawBox: {
                                                x1: (el.x1 ?? 0) * 1280,
                                                y1: (el.y1 ?? 0) * 800,
                                                x2: (el.x2 ?? 0) * 1280,
                                                y2: (el.y2 ?? 0) * 800,
                                            },
                                        }));

                                        sessionStorage.setItem("inspector-preload", JSON.stringify({
                                            url: selectedSite.url,
                                            title: selectedSite.title,
                                            screenshot_base64: selectedSite.screenshotB64,
                                            detection: {
                                                ok: true,
                                                count: selectedSite.omniCount,
                                                mapped: selectedSite.omniElements,
                                                unmatched: 0,
                                                elapsed_seconds: selectedSite.elapsed ?? 0,
                                            },
                                            all_dom_bounds: selectedSite.domBounds ?? [],
                                            savedLabels: gemmaLabels,
                                        }));
                                        window.location.href = "/inspector?preload=true";
                                    }}
                                    className="w-full px-2 py-1.5 rounded text-xs font-bold bg-fuchsia-700/30 hover:bg-fuchsia-700/50 border border-fuchsia-800 text-fuchsia-200 transition"
                                >
                                    Open in Inspector
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Live logs */}
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                        <div className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">
                            Logs ({logs.length})
                        </div>
                        <div className="space-y-0.5 max-h-64 overflow-y-auto font-mono text-[10px] text-zinc-500">
                            {logs.slice(-50).map((log, i) => (
                                <div key={i} className={log.includes("FAIL") ? "text-red-400" : log.includes("DONE") ? "text-emerald-300 font-bold" : ""}>
                                    {log}
                                </div>
                            ))}
                            {running && <div className="text-fuchsia-400 animate-pulse">running…</div>}
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
