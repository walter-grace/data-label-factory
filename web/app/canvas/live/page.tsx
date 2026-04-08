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

type FalconResponse = {
    ok: boolean;
    count?: number;
    bboxes?: Array<{ x1: number; y1: number; x2: number; y2: number; score: number; label: string }>;
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
        form.set("query", query);

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
                                    onChange={(e) => setQuery(e.target.value)}
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
                            <div className="space-y-2">
                                {activeTracks.map((t) => (
                                    <div key={t.id} className="flex items-center justify-between text-sm">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span
                                                className="h-3 w-3 rounded-sm border border-zinc-600 flex-shrink-0"
                                                style={{ backgroundColor: t.color }}
                                            />
                                            <span className="text-zinc-100 truncate">#{t.id} {t.label}</span>
                                        </div>
                                        <span className="text-zinc-400 text-xs whitespace-nowrap ml-2">
                                            {t.hits}/{t.age}f
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
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
