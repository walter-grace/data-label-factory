"use client";

// /canvas/live — upload a video or use a webcam, run Falcon Perception on each
// frame (throttled to one in flight), and draw persistent track bboxes on a
// pure HTML5 canvas overlay.
//
// Architecture:
//   <video>  (hidden, decodes file or webcam stream)
//      ↓ requestVideoFrameCallback / rAF
//   capture canvas (hidden, draws current video frame, .toBlob → JPEG)
//      ↓ POST /api/falcon-frame
//   IoU tracker (web/lib/iou-tracker.ts) assigns persistent IDs
//      ↓
//   visible canvas: draws video frame + tracked bboxes per frame
//
// Throttling rule: at most ONE Falcon request in flight at a time. When it
// returns, sample whatever frame is currently on the video element and send
// that. This decouples Falcon latency from playback rate.

import { useEffect, useRef, useState, useCallback } from "react";
import { IoUTracker, type Track } from "@/lib/iou-tracker";

type SourceMode = "idle" | "file" | "webcam";

type Price = {
    median?: number;
    min?: number;
    max?: number;
    currency?: string;
    usd_median?: number;
    usd_min?: number;
    usd_max?: number;
} | null;

type FalconResponse = {
    ok: boolean;
    count?: number;
    bboxes?: Array<{
        x1: number; y1: number; x2: number; y2: number;
        score: number;
        label: string;
        ref_url?: string;
        margin?: number;
        confident?: boolean;
        price?: Price;
    }>;
    image_size?: { w: number; h: number };
    elapsed_ms?: number;
    upstream?: string;
    error?: string;
    hint?: string;
};

export default function LiveTrackerPage() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const captureCanvasRef = useRef<HTMLCanvasElement>(null);
    const trackerRef = useRef<IoUTracker>(new IoUTracker({ iouThreshold: 0.3, maxFramesUnseen: 5 }));
    const inFlightRef = useRef<boolean>(false);
    const stopRef = useRef<boolean>(false);
    const streamRef = useRef<MediaStream | null>(null);
    const objectUrlRef = useRef<string | null>(null);

    // Live query ref — read from inside the sendNextFrame loop instead of
    // closure-captured `query` to avoid stale-closure bugs when the user
    // types a new query mid-stream.
    const queryRef = useRef<string>("fiber optic drone");

    const [mode, setMode] = useState<SourceMode>("idle");
    const [query, setQuery] = useState<string>("fiber optic drone");
    const [activeTracks, setActiveTracks] = useState<Track[]>([]);
    const [stats, setStats] = useState({
        framesProcessed: 0,
        framesSkipped: 0,
        currentLatencyMs: 0,
        avgLatencyMs: 0,
        totalTracksEver: 0,
        upstream: "?",
        lastError: "" as string,
    });

    // Top valuable cards in the indexed set, fetched once on page mount.
    type TopCard = {
        code: string;
        name?: string;        // English display name
        name_jp?: string;     // Japanese name from yuyu-tei
        jpy_median: number;
        usd_median?: number;
    };
    const [topCards, setTopCards] = useState<TopCard[]>([]);
    useEffect(() => {
        fetch("/api/top-prices")
            .then((r) => r.json())
            .then((d) => { if (d?.top) setTopCards(d.top); })
            .catch(() => { /* upstream may not have prices configured */ });
    }, []);

    // ---------- deck (localStorage-backed) ----------
    type DeckEntry = {
        label: string;
        ref_url?: string;
        usd?: number;
        jpy?: number;
        added_at: number;
        qty: number;
    };
    const DECK_KEY = "dlf-deck-v1";
    const [deck, setDeck] = useState<Record<string, DeckEntry>>({});

    // Load deck from localStorage on mount
    useEffect(() => {
        try {
            const raw = localStorage.getItem(DECK_KEY);
            if (raw) setDeck(JSON.parse(raw));
        } catch { /* ignore */ }
    }, []);

    // Persist whenever it changes
    useEffect(() => {
        try {
            localStorage.setItem(DECK_KEY, JSON.stringify(deck));
        } catch { /* ignore */ }
    }, [deck]);

    // Visual feedback: which track was JUST added (brief flash + text swap)
    const [recentlyAddedId, setRecentlyAddedId] = useState<number | null>(null);
    const recentlyAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const addToDeck = useCallback((t: Track) => {
        if (!t.label) return;
        const label = t.label;
        // Strip the trailing rarity suffix from the label for deduping
        const key = label.replace(/\s*\(.*?\)\s*$/, "").trim();
        setDeck((prev) => {
            const existing = prev[key];
            return {
                ...prev,
                [key]: {
                    label,
                    ref_url: t.ref_url,
                    usd: t.price?.usd_median,
                    jpy: t.price?.median,
                    added_at: existing?.added_at ?? Date.now(),
                    qty: (existing?.qty ?? 0) + 1,
                },
            };
        });
        // Trigger the visual feedback
        setRecentlyAddedId(t.id);
        if (recentlyAddedTimerRef.current) clearTimeout(recentlyAddedTimerRef.current);
        recentlyAddedTimerRef.current = setTimeout(() => setRecentlyAddedId(null), 1400);
    }, []);

    // Pulse the deck panel when a card was just added (brief border highlight)
    const [deckPulse, setDeckPulse] = useState(false);
    const deckPulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (recentlyAddedId === null) return;
        setDeckPulse(true);
        if (deckPulseTimerRef.current) clearTimeout(deckPulseTimerRef.current);
        deckPulseTimerRef.current = setTimeout(() => setDeckPulse(false), 1400);
    }, [recentlyAddedId]);

    const removeFromDeck = useCallback((key: string) => {
        setDeck((prev) => {
            const next = { ...prev };
            const e = next[key];
            if (!e) return prev;
            if (e.qty > 1) next[key] = { ...e, qty: e.qty - 1 };
            else delete next[key];
            return next;
        });
    }, []);

    const clearDeck = useCallback(() => setDeck({}), []);

    const deckEntries = Object.entries(deck).sort((a, b) => b[1].added_at - a[1].added_at);
    const deckTotalUsd = deckEntries.reduce(
        (sum, [, e]) => sum + (typeof e.usd === "number" ? e.usd * e.qty : 0),
        0,
    );
    const deckTotalQty = deckEntries.reduce((sum, [, e]) => sum + e.qty, 0);

    // ---------- agent gateway (SSE event bus) ----------
    type AgentListing = {
        listing_id: string;
        label: string;
        rarity?: string;
        ref_url?: string;
        set_code?: string;
        price_usd?: number;
        price_jpy?: number;
        first_seen_ts: number;
        last_seen_ts: number;
        frames_seen: number;
    };
    type AgentOrder = {
        order_id: string;
        listing_id: string;
        agent_id: string;
        label?: string | null;
        price_usd?: number | null;
        max_price_usd?: number | null;
        status: "filled" | "rejected_too_expensive" | "rejected_no_listing" | string;
        reason?: string;
        receipt?: string | null;
        created_at: number;
    };

    const [agentListings, setAgentListings] = useState<Record<string, AgentListing>>({});
    const [agentOrders, setAgentOrders] = useState<AgentOrder[]>([]);
    const [agentConnected, setAgentConnected] = useState<boolean>(false);
    const [agentError, setAgentError] = useState<string>("");
    const buyingRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        const es = new EventSource("/api/agent-stream");

        es.addEventListener("ready", () => {
            setAgentConnected(true);
            setAgentError("");
        });

        es.addEventListener("listing.appeared", (e) => {
            try {
                const l = JSON.parse((e as MessageEvent).data) as AgentListing;
                setAgentListings((prev) => ({ ...prev, [l.listing_id]: l }));
            } catch { /* ignore malformed frame */ }
        });

        es.addEventListener("listing.price", (e) => {
            try {
                const l = JSON.parse((e as MessageEvent).data) as AgentListing;
                setAgentListings((prev) =>
                    prev[l.listing_id] ? { ...prev, [l.listing_id]: { ...prev[l.listing_id], ...l } } : prev,
                );
            } catch { /* ignore */ }
        });

        es.addEventListener("listing.expired", (e) => {
            try {
                const l = JSON.parse((e as MessageEvent).data) as { listing_id: string };
                setAgentListings((prev) => {
                    if (!prev[l.listing_id]) return prev;
                    const next = { ...prev };
                    delete next[l.listing_id];
                    return next;
                });
            } catch { /* ignore */ }
        });

        const recordOrder = (e: Event) => {
            try {
                const o = JSON.parse((e as MessageEvent).data) as AgentOrder;
                setAgentOrders((prev) => [o, ...prev].slice(0, 25));
            } catch { /* ignore */ }
        };
        es.addEventListener("order.filled", recordOrder);
        es.addEventListener("order.rejected", recordOrder);

        es.onerror = () => {
            setAgentConnected(false);
            setAgentError("disconnected — retrying…");
        };

        return () => es.close();
    }, []);

    const buyAsAgent = useCallback(async (listing_id: string, max_price_usd?: number) => {
        if (buyingRef.current.has(listing_id)) return;
        buyingRef.current.add(listing_id);
        try {
            await fetch("/api/agent-buy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    listing_id,
                    agent_id: "demo-browser",
                    max_price_usd,
                }),
            });
            // The order will arrive via the SSE stream as order.filled / order.rejected.
        } catch { /* surface via stream error */ }
        finally {
            setTimeout(() => buyingRef.current.delete(listing_id), 600);
        }
    }, []);

    const agentListingsList = Object.values(agentListings).sort((a, b) => b.last_seen_ts - a.last_seen_ts);

    // ---------- core capture loop ----------
    // Called whenever the previous Falcon request resolves OR after we start.
    // Captures the current video frame and POSTs it. Skips if a request is
    // already in flight (the previous response handler will catch up).
    const sendNextFrame = useCallback(async () => {
        if (stopRef.current) return;
        if (inFlightRef.current) return;
        const video = videoRef.current;
        const captureCanvas = captureCanvasRef.current;
        if (!video || !captureCanvas) return;
        if (video.readyState < 2 || video.videoWidth === 0) {
            // Video not ready yet — try again next animation frame
            requestAnimationFrame(sendNextFrame);
            return;
        }

        inFlightRef.current = true;
        const t0 = performance.now();

        // Match capture canvas to actual video resolution
        if (captureCanvas.width !== video.videoWidth) {
            captureCanvas.width = video.videoWidth;
            captureCanvas.height = video.videoHeight;
        }
        const cctx = captureCanvas.getContext("2d");
        if (!cctx) {
            inFlightRef.current = false;
            return;
        }
        cctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

        // Convert to JPEG blob (smaller payload than PNG, much faster on the wire)
        const blob: Blob | null = await new Promise((res) =>
            captureCanvas.toBlob(res, "image/jpeg", 0.85),
        );
        if (!blob) {
            inFlightRef.current = false;
            return;
        }

        const form = new FormData();
        form.set("image", blob, "frame.jpg");
        form.set("query", queryRef.current);

        let resp: FalconResponse;
        try {
            const r = await fetch("/api/falcon-frame", { method: "POST", body: form });
            resp = (await r.json()) as FalconResponse;
        } catch (e) {
            inFlightRef.current = false;
            setStats((s) => ({ ...s, lastError: String(e) }));
            // Retry next animation frame so a transient blip doesn't kill the loop
            if (!stopRef.current) requestAnimationFrame(sendNextFrame);
            return;
        }
        const elapsed = performance.now() - t0;
        inFlightRef.current = false;

        if (!resp.ok) {
            setStats((s) => ({ ...s, lastError: resp.error ?? "unknown error" }));
            if (!stopRef.current) requestAnimationFrame(sendNextFrame);
            return;
        }

        // Convert Falcon's normalized bboxes to pixel coords for the tracker
        const W = video.videoWidth;
        const H = video.videoHeight;
        const detections = (resp.bboxes ?? []).map((b) => {
            // Falcon returns x1/y1/x2/y2 in normalized [0,1] space when going through mac_tensor
            const isNormalized = b.x2 <= 1.5 && b.y2 <= 1.5;
            return {
                x1: isNormalized ? b.x1 * W : b.x1,
                y1: isNormalized ? b.y1 * H : b.y1,
                x2: isNormalized ? b.x2 * W : b.x2,
                y2: isNormalized ? b.y2 * H : b.y2,
                score: b.score,
                label: b.label,
                ref_url: b.ref_url,
                price: b.price ?? null,
            };
        });

        const updated = trackerRef.current.update(detections);

        setActiveTracks(updated);
        setStats((s) => {
            const n = s.framesProcessed + 1;
            const avg = (s.avgLatencyMs * s.framesProcessed + elapsed) / n;
            return {
                ...s,
                framesProcessed: n,
                currentLatencyMs: Math.round(elapsed),
                avgLatencyMs: Math.round(avg),
                totalTracksEver: trackerRef.current.totalTracksEverSeen,
                upstream: resp.upstream ?? s.upstream,
                lastError: "",
            };
        });

        // Immediately schedule the next frame
        if (!stopRef.current) requestAnimationFrame(sendNextFrame);
    }, [query]);

    // ---------- visible canvas redraw loop ----------
    // Runs at the browser's animation rate. Always shows the current video
    // frame plus whatever tracks the IoU tracker has currently active.
    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (video && canvas && video.videoWidth > 0) {
                // Match canvas size to video aspect, capped at the container width
                const containerW = canvas.parentElement?.clientWidth ?? 900;
                const aspect = video.videoHeight / video.videoWidth;
                const W = Math.min(containerW, 1280);
                const H = Math.round(W * aspect);
                if (canvas.width !== W || canvas.height !== H) {
                    canvas.width = W;
                    canvas.height = H;
                }
                const ctx = canvas.getContext("2d");
                if (ctx) {
                    ctx.fillStyle = "#0a0a0a";
                    ctx.fillRect(0, 0, W, H);
                    ctx.drawImage(video, 0, 0, W, H);

                    // Scale tracker pixel coords (in video resolution) to canvas
                    const sx = W / video.videoWidth;
                    const sy = H / video.videoHeight;
                    ctx.font = "bold 13px ui-sans-serif, system-ui, sans-serif";
                    for (const t of activeTracks) {
                        const x = t.x1 * sx;
                        const y = t.y1 * sy;
                        const w = (t.x2 - t.x1) * sx;
                        const h = (t.y2 - t.y1) * sy;
                        ctx.strokeStyle = t.color;
                        ctx.lineWidth = 3;
                        ctx.fillStyle = `${t.color}26`;
                        ctx.fillRect(x, y, w, h);
                        ctx.strokeRect(x, y, w, h);
                        // Label tag
                        const label = `#${t.id} ${t.label ?? ""}`.trim();
                        const tw = ctx.measureText(label).width + 12;
                        ctx.fillStyle = t.color;
                        ctx.fillRect(x, Math.max(0, y - 20), tw, 18);
                        ctx.fillStyle = "#000000";
                        ctx.fillText(label, x + 6, Math.max(13, y - 6));
                    }
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [activeTracks]);

    // ---------- source handlers ----------
    const stopAllSources = useCallback(() => {
        stopRef.current = true;
        const video = videoRef.current;
        if (video) {
            video.pause();
            video.srcObject = null;
            video.src = "";
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
        }
        if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        }
        trackerRef.current.reset();
        setActiveTracks([]);
        setMode("idle");
    }, []);

    const startFile = useCallback((file: File) => {
        const video = videoRef.current;
        if (!video) return;
        // Tear down any prior source
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);

        const url = URL.createObjectURL(file);
        objectUrlRef.current = url;
        video.srcObject = null;
        video.src = url;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        trackerRef.current.reset();
        setActiveTracks([]);
        stopRef.current = false;
        video.play().catch(() => {});
        setMode("file");
        // Kick off the capture loop
        setTimeout(() => sendNextFrame(), 200);
    }, [sendNextFrame]);

    const startWebcam = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false,
            });
            streamRef.current = stream;
            const video = videoRef.current;
            if (!video) return;
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            video.src = "";
            video.srcObject = stream;
            video.muted = true;
            video.playsInline = true;
            trackerRef.current.reset();
            setActiveTracks([]);
            stopRef.current = false;
            await video.play();
            setMode("webcam");
            setTimeout(() => sendNextFrame(), 200);
        } catch (e) {
            setStats((s) => ({ ...s, lastError: `webcam: ${String(e)}` }));
        }
    }, [sendNextFrame]);

    // Cleanup on unmount
    useEffect(() => () => stopAllSources(), [stopAllSources]);

    const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        if (f) startFile(f);
    };

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-50 font-sans">
            {/* Header */}
            <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur px-6 py-4 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">
                        drone-falcon <span className="text-zinc-500">/</span> live tracker
                    </h1>
                    <p className="text-sm text-zinc-300 mt-0.5">
                        Upload a video or use your webcam — Falcon Perception draws boxes on every frame, IoU tracker keeps IDs persistent.
                    </p>
                </div>
                <div className="flex items-center gap-2 text-sm">
                    <a href="/canvas" className="text-zinc-300 hover:text-zinc-50 underline-offset-4 hover:underline">
                        ← canvas review
                    </a>
                </div>
            </header>

            {/* Main grid */}
            <div className="grid grid-cols-12 gap-4 p-4">
                {/* Left: source controls + canvas */}
                <div className="col-span-9 min-w-0 space-y-4">
                    {/* Source picker */}
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                        <div className="flex items-center gap-3 flex-wrap">
                            <label className="px-4 py-2 rounded-md bg-zinc-50 text-zinc-950 text-sm font-semibold cursor-pointer hover:bg-zinc-200 transition-colors">
                                📁 Upload Video
                                <input
                                    type="file"
                                    accept="video/*"
                                    className="hidden"
                                    onChange={onFileChange}
                                />
                            </label>
                            <button
                                onClick={startWebcam}
                                className="px-4 py-2 rounded-md bg-zinc-800 text-zinc-100 text-sm font-semibold border border-zinc-700 hover:bg-zinc-700 transition-colors"
                            >
                                📷 Use Webcam
                            </button>
                            <button
                                onClick={stopAllSources}
                                disabled={mode === "idle"}
                                className="px-4 py-2 rounded-md bg-zinc-800 text-zinc-100 text-sm font-semibold border border-zinc-700 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                ⏹ Stop
                            </button>
                            <div className="ml-auto flex items-center gap-2">
                                <label className="text-sm text-zinc-400 font-semibold uppercase tracking-wider">
                                    Query
                                </label>
                                <input
                                    type="text"
                                    value={query}
                                    onChange={(e) => {
                                        setQuery(e.target.value);
                                        queryRef.current = e.target.value;
                                    }}
                                    className="px-3 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                    placeholder="e.g. fiber optic drone"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Canvas */}
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                        <canvas
                            ref={canvasRef}
                            className="w-full rounded border border-zinc-800 bg-black"
                        />
                        {mode === "idle" && (
                            <div className="text-center py-12 text-zinc-500 text-sm">
                                Pick a video or click <span className="text-zinc-300">Use Webcam</span> to start tracking.
                            </div>
                        )}
                    </div>

                    {/* Status bar */}
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm font-mono flex items-center gap-6 flex-wrap">
                        <span className={mode === "idle" ? "text-zinc-500" : "text-emerald-400"}>
                            ● {mode === "idle" ? "idle" : mode}
                        </span>
                        <span className="text-zinc-300">frames: <span className="text-zinc-50">{stats.framesProcessed}</span></span>
                        <span className="text-zinc-300">latency: <span className="text-zinc-50">{stats.currentLatencyMs}ms</span> <span className="text-zinc-500">(avg {stats.avgLatencyMs}ms)</span></span>
                        <span className="text-zinc-300">tracks active: <span className="text-zinc-50">{activeTracks.length}</span> <span className="text-zinc-500">(total seen {stats.totalTracksEver})</span></span>
                        <span className="text-zinc-300">backend: <span className="text-zinc-50">{stats.upstream}</span></span>
                        {stats.lastError && (
                            <span className="text-red-400 ml-auto truncate max-w-md" title={stats.lastError}>
                                ! {stats.lastError}
                            </span>
                        )}
                    </div>
                </div>

                {/* Right: tracks sidebar */}
                <div className="col-span-3 min-w-0 max-h-[calc(100vh-180px)] overflow-y-auto space-y-4">
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                        <div className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-3">
                            Active tracks
                        </div>
                        {activeTracks.length === 0 ? (
                            <div className="text-sm text-zinc-500">none yet</div>
                        ) : (
                            <div className="space-y-3">
                                {activeTracks.map((t) => (
                                    <div
                                        key={t.id}
                                        className="rounded-md border border-zinc-800 bg-zinc-950 p-2"
                                    >
                                        <div className="flex items-start gap-3">
                                            {/* Reference card image (if backend provided one) */}
                                            {t.ref_url ? (
                                                /* eslint-disable-next-line @next/next/no-img-element */
                                                <img
                                                    src={t.ref_url}
                                                    alt={t.label}
                                                    className="w-16 h-auto rounded border-2 flex-shrink-0"
                                                    style={{ borderColor: t.color }}
                                                />
                                            ) : (
                                                <div
                                                    className="w-16 h-22 rounded border-2 flex-shrink-0 flex items-center justify-center text-xs text-zinc-600"
                                                    style={{ borderColor: t.color }}
                                                >
                                                    no ref
                                                </div>
                                            )}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                    <span
                                                        className="h-2 w-2 rounded-sm flex-shrink-0"
                                                        style={{ backgroundColor: t.color }}
                                                    />
                                                    <span className="text-xs text-zinc-500 font-mono">#{t.id}</span>
                                                </div>
                                                <div className="text-sm text-zinc-100 leading-tight mt-1 break-words">
                                                    {t.label}
                                                </div>
                                                {t.price && typeof t.price.median === "number" && (
                                                    <div className="mt-1">
                                                        {/* USD as the headline price; original currency in subtle */}
                                                        {typeof t.price.usd_median === "number" && (
                                                            <div className="text-lg text-emerald-300 font-bold leading-none">
                                                                ${t.price.usd_median.toFixed(2)}
                                                            </div>
                                                        )}
                                                        <div className="text-xs text-zinc-400 font-mono leading-tight mt-0.5">
                                                            ¥{t.price.median.toLocaleString()}
                                                            {t.price.min !== t.price.max && (
                                                                <span className="ml-1 text-zinc-500">
                                                                    (¥{t.price.min?.toLocaleString()}–{t.price.max?.toLocaleString()})
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                                <div className="text-xs text-zinc-500 mt-1.5 font-mono">
                                                    {typeof t.score === "number" ? `score ${t.score.toFixed(2)} · ` : ""}
                                                    seen {t.hits}/{t.age}f
                                                </div>
                                                {(() => {
                                                    const justAdded = recentlyAddedId === t.id;
                                                    return (
                                                        <button
                                                            onClick={() => addToDeck(t)}
                                                            className={`mt-2 px-2 py-1 rounded text-xs font-semibold w-full transition-all duration-200 ease-out ${
                                                                justAdded
                                                                    ? "bg-emerald-500 border border-emerald-400 text-zinc-950 scale-[1.04] shadow-[0_0_18px_rgba(16,185,129,0.7)]"
                                                                    : "bg-emerald-600/20 hover:bg-emerald-600/40 border border-emerald-700/60 text-emerald-300"
                                                            }`}
                                                        >
                                                            {justAdded ? "✓ Added!" : "+ Add to Deck"}
                                                        </button>
                                                    );
                                                })()}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {/* Top Valuable Cards in this set (loaded once at mount) */}
                    {topCards.length > 0 && (
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                            <div className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-3">
                                Top Valuable Cards
                            </div>
                            <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                                {topCards.slice(0, 50).map((card, i) => (
                                    <div
                                        key={card.code}
                                        className="border border-zinc-800 rounded-md bg-zinc-950 p-2"
                                    >
                                        <div className="flex items-baseline justify-between gap-2">
                                            <div className="flex items-baseline gap-1.5 min-w-0">
                                                <span className="text-zinc-500 font-mono text-xs flex-shrink-0">#{i + 1}</span>
                                                <span className="text-zinc-500 font-mono text-[10px] flex-shrink-0">{card.code}</span>
                                            </div>
                                            <div className="text-right whitespace-nowrap flex-shrink-0">
                                                {typeof card.usd_median === "number" && (
                                                    <span className="text-emerald-300 font-bold text-sm">
                                                        ${card.usd_median.toFixed(2)}
                                                    </span>
                                                )}
                                                <span className="text-zinc-500 ml-1.5 font-mono text-[10px]">
                                                    ¥{card.jpy_median.toLocaleString()}
                                                </span>
                                            </div>
                                        </div>
                                        {(card.name || card.name_jp) && (
                                            <div
                                                className="text-xs text-zinc-100 leading-tight mt-1 break-words"
                                                title={card.name_jp || ""}
                                            >
                                                {card.name || card.name_jp}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <div className="text-[10px] text-zinc-500 mt-3 pt-2 border-t border-zinc-800">
                                from yuyu-tei.jp · {topCards.length} cards · live FX
                            </div>
                        </div>
                    )}

                    {/* My Deck (localStorage-backed) */}
                    <div
                        className={`rounded-lg border bg-zinc-900 p-4 transition-all duration-300 ease-out ${
                            deckPulse
                                ? "border-emerald-400 shadow-[0_0_24px_rgba(16,185,129,0.5)] scale-[1.01]"
                                : "border-zinc-800"
                        }`}
                    >
                        <div className="flex items-center justify-between mb-3">
                            <div className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                                My Deck
                            </div>
                            {deckEntries.length > 0 && (
                                <button
                                    onClick={clearDeck}
                                    className="text-[10px] text-zinc-500 hover:text-red-400 underline-offset-2 hover:underline"
                                >
                                    clear
                                </button>
                            )}
                        </div>
                        {deckEntries.length === 0 ? (
                            <div className="text-xs text-zinc-500">
                                Empty. Click <span className="text-zinc-300">+ Add to Deck</span> on any active track to build a deck.
                            </div>
                        ) : (
                            <>
                                <div className="text-xs text-zinc-300 mb-3">
                                    <span className="text-zinc-100 font-bold">{deckTotalQty}</span> cards ·{" "}
                                    <span className="text-emerald-300 font-bold">${deckTotalUsd.toFixed(2)}</span> total
                                </div>
                                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                                    {deckEntries.map(([key, e]) => (
                                        <div key={key} className="flex items-start gap-2 text-xs border border-zinc-800 rounded p-1.5 bg-zinc-950">
                                            {e.ref_url ? (
                                                /* eslint-disable-next-line @next/next/no-img-element */
                                                <img src={e.ref_url} alt={e.label} className="w-10 h-auto rounded-sm flex-shrink-0" />
                                            ) : (
                                                <div className="w-10 h-14 rounded-sm bg-zinc-800 flex-shrink-0" />
                                            )}
                                            <div className="flex-1 min-w-0">
                                                <div className="text-zinc-100 leading-tight break-words">{e.label}</div>
                                                <div className="flex items-baseline justify-between mt-1">
                                                    {typeof e.usd === "number" && (
                                                        <span className="text-emerald-300 font-bold">
                                                            ${(e.usd * e.qty).toFixed(2)}
                                                            {e.qty > 1 && <span className="text-zinc-500 font-normal"> (×{e.qty})</span>}
                                                        </span>
                                                    )}
                                                    <button
                                                        onClick={() => removeFromDeck(key)}
                                                        className="text-zinc-500 hover:text-red-400 text-xs"
                                                        title="Remove one"
                                                    >
                                                        −
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>

                    {/* Agent Gateway — live SSE feed of buyable listings + recent orders */}
                    <div className="rounded-lg border border-fuchsia-900/50 bg-zinc-900 p-4">
                        <div className="flex items-center justify-between mb-3">
                            <div className="text-xs font-bold uppercase tracking-wider text-fuchsia-300">
                                Agent Gateway
                            </div>
                            <div className="flex items-center gap-1.5">
                                <span
                                    className={`inline-block w-2 h-2 rounded-full ${
                                        agentConnected ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"
                                    }`}
                                />
                                <span className="text-[10px] text-zinc-500 font-mono">
                                    {agentConnected ? "SSE live" : agentError || "connecting…"}
                                </span>
                            </div>
                        </div>

                        <div className="text-[10px] text-zinc-500 mb-2">
                            Live Listings ({agentListingsList.length})
                        </div>
                        {agentListingsList.length === 0 ? (
                            <div className="text-xs text-zinc-500 italic">
                                Hold a card up to the camera — confident detections appear here for agents to buy.
                            </div>
                        ) : (
                            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                                {agentListingsList.map((l) => (
                                    <div
                                        key={l.listing_id}
                                        className="border border-zinc-800 rounded p-2 bg-zinc-950 text-xs"
                                    >
                                        <div className="flex items-baseline justify-between gap-2">
                                            <div className="text-zinc-100 leading-tight break-words flex-1 min-w-0">
                                                {l.label}
                                                {l.rarity && <span className="text-zinc-500"> ({l.rarity})</span>}
                                            </div>
                                            {typeof l.price_usd === "number" && (
                                                <span className="text-emerald-300 font-bold whitespace-nowrap">
                                                    ${l.price_usd.toFixed(2)}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center justify-between mt-1.5 gap-2">
                                            <span className="font-mono text-[10px] text-zinc-600">
                                                {l.listing_id} · {l.frames_seen}f
                                            </span>
                                            <button
                                                onClick={() => buyAsAgent(l.listing_id, l.price_usd)}
                                                className="px-2 py-0.5 rounded text-[10px] font-bold bg-fuchsia-700/30 hover:bg-fuchsia-700/60 border border-fuchsia-700 text-fuchsia-200 transition"
                                            >
                                                Buy as Agent
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="text-[10px] text-zinc-500 mt-3 mb-2 border-t border-zinc-800 pt-2">
                            Recent Orders ({agentOrders.length})
                        </div>
                        {agentOrders.length === 0 ? (
                            <div className="text-xs text-zinc-600 italic">No orders yet.</div>
                        ) : (
                            <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                                {agentOrders.map((o) => {
                                    const filled = o.status === "filled";
                                    return (
                                        <div
                                            key={o.order_id}
                                            className={`text-[11px] font-mono leading-tight border rounded px-1.5 py-1 ${
                                                filled
                                                    ? "border-emerald-800/60 bg-emerald-950/30 text-emerald-200"
                                                    : "border-red-900/50 bg-red-950/20 text-red-300"
                                            }`}
                                        >
                                            <div className="flex items-baseline justify-between gap-1">
                                                <span className="truncate flex-1">
                                                    {filled ? "✓" : "✗"} {o.label ?? o.listing_id}
                                                </span>
                                                {typeof o.price_usd === "number" && (
                                                    <span className="font-bold">${o.price_usd.toFixed(2)}</span>
                                                )}
                                            </div>
                                            <div className="text-[9px] text-zinc-500 truncate">
                                                {o.agent_id} · {o.status}
                                                {o.receipt && ` · ${o.receipt}`}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        <div className="text-[9px] text-zinc-600 mt-3 pt-2 border-t border-zinc-800 leading-relaxed">
                            <code className="text-zinc-500">GET /api/agent/stream</code> (SSE) ·{" "}
                            <code className="text-zinc-500">POST /api/agent/buy</code> · MCP-ready
                        </div>
                    </div>

                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-400 space-y-2">
                        <div className="font-bold uppercase tracking-wider text-zinc-400">How it works</div>
                        <div>
                            Each captured frame is sent to a Falcon Perception backend. At most one
                            request is in flight at a time, so the effective sample rate adapts to whatever
                            Falcon can handle.
                        </div>
                        <div>
                            An IoU tracker (threshold 0.3, retire after 5 unseen frames) assigns persistent
                            track IDs across frames. Each track gets a stable color.
                        </div>
                        <div>
                            Configure the upstream via <code className="bg-zinc-800 px-1 py-0.5 rounded">FALCON_URL</code> in <code className="bg-zinc-800 px-1 py-0.5 rounded">web/.env.local</code>.
                            Default is <code>http://localhost:8500/api/falcon</code>.
                        </div>
                    </div>
                </div>
            </div>

            {/* Hidden video element + capture canvas */}
            <video ref={videoRef} className="hidden" playsInline muted />
            <canvas ref={captureCanvasRef} className="hidden" />
        </main>
    );
}
