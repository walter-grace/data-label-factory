"use client";

// /deploy — Upload a trained YOLO model (best.pt) or connect a GPU endpoint,
// then run real-time detection on webcam or uploaded video with live bounding
// boxes, FPS stats, and detection metrics.
//
// Architecture:
//   <video>  (hidden, decodes webcam or uploaded file)
//      | requestAnimationFrame
//   capture canvas (hidden, .toBlob -> JPEG)
//      | POST /api/dlf?path=/api/label  (or custom RunPod endpoint)
//   IoU tracker assigns persistent IDs
//      |
//   visible canvas: draws video frame + tracked bboxes

import Link from "next/link";
import { useEffect, useRef, useState, useCallback } from "react";
import { IoUTracker, type Track, type Detection } from "@/lib/iou-tracker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceMode = "idle" | "webcam" | "file";

type InferenceBackend = "dlf" | "runpod";

type BboxResponse = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  label: string;
};

type Stats = {
  fps: number;
  framesProcessed: number;
  detectionsThisFrame: number;
  avgDetections: number;
  latencyMs: number;
  avgLatencyMs: number;
  totalTracksEver: number;
  lastError: string;
};

const INITIAL_STATS: Stats = {
  fps: 0,
  framesProcessed: 0,
  detectionsThisFrame: 0,
  avgDetections: 0,
  latencyMs: 0,
  avgLatencyMs: 0,
  totalTracksEver: 0,
  lastError: "",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DeployPage() {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<IoUTracker>(
    new IoUTracker({ iouThreshold: 0.3, maxFramesUnseen: 5 })
  );
  const inFlightRef = useRef(false);
  const stopRef = useRef(true);
  const streamRef = useRef<MediaStream | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const fpsTimestamps = useRef<number[]>([]);

  // State
  const [mode, setMode] = useState<SourceMode>("idle");
  const [activeTracks, setActiveTracks] = useState<Track[]>([]);
  const [stats, setStats] = useState<Stats>(INITIAL_STATS);

  // Model / backend config
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [modelName, setModelName] = useState<string>("");
  const [query, setQuery] = useState<string>("object");
  const queryRef = useRef("object");
  const [backend, setBackend] = useState<InferenceBackend>("dlf");
  const [runpodUrl, setRunpodUrl] = useState("");
  const [runpodToken, setRunpodToken] = useState("");
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.25);

  // ---------- inference ----------

  const runInference = useCallback(
    async (blob: Blob): Promise<{ bboxes: BboxResponse[]; elapsed: number }> => {
      const t0 = performance.now();

      if (backend === "runpod" && runpodUrl) {
        // Send base64 to custom RunPod endpoint
        const buf = await blob.arrayBuffer();
        const b64 = Buffer.from(buf).toString("base64");
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (runpodToken) headers["Authorization"] = `Bearer ${runpodToken}`;

        const r = await fetch(runpodUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            input: { image_base64: b64, query: queryRef.current, confidence: confidenceThreshold },
          }),
        });
        if (!r.ok) throw new Error(`RunPod ${r.status}`);
        const data = await r.json();
        const out = data.output ?? data;
        return {
          bboxes: (out.bboxes ?? out.predictions ?? []).map((b: any) => ({
            x1: b.x1 ?? b.x ?? 0,
            y1: b.y1 ?? b.y ?? 0,
            x2: b.x2 ?? (b.x ?? 0) + (b.width ?? 0),
            y2: b.y2 ?? (b.y ?? 0) + (b.height ?? 0),
            score: b.score ?? b.confidence ?? 1,
            label: b.label ?? b.class ?? queryRef.current,
          })),
          elapsed: performance.now() - t0,
        };
      }

      // Default: DLF API proxy
      const form = new FormData();
      form.set("image", blob, "frame.jpg");
      form.set("query", queryRef.current);
      if (modelFile) form.set("model", modelFile);

      const r = await fetch("/api/falcon-frame", { method: "POST", body: form });
      if (!r.ok) throw new Error(`DLF API ${r.status}`);
      const data = await r.json();
      if (!data.ok) throw new Error(data.error ?? "inference failed");

      const bboxes: BboxResponse[] = (data.bboxes ?? []).map((b: any) => ({
        x1: b.x1 ?? 0,
        y1: b.y1 ?? 0,
        x2: b.x2 ?? 0,
        y2: b.y2 ?? 0,
        score: b.score ?? 1,
        label: b.label ?? queryRef.current,
      }));

      return { bboxes, elapsed: performance.now() - t0 };
    },
    [backend, runpodUrl, runpodToken, modelFile, confidenceThreshold]
  );

  // ---------- capture loop ----------

  const sendNextFrame = useCallback(async () => {
    if (stopRef.current) return;
    if (inFlightRef.current) return;

    const video = videoRef.current;
    const captureCanvas = captureCanvasRef.current;
    if (!video || !captureCanvas) return;
    if (video.readyState < 2 || video.videoWidth === 0) {
      requestAnimationFrame(sendNextFrame);
      return;
    }

    inFlightRef.current = true;

    // Match capture canvas to video resolution
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

    const blob: Blob | null = await new Promise((res) =>
      captureCanvas.toBlob(res, "image/jpeg", 0.85)
    );
    if (!blob) {
      inFlightRef.current = false;
      return;
    }

    try {
      const { bboxes, elapsed } = await runInference(blob);

      // Convert normalized bboxes to pixel coords
      const W = video.videoWidth;
      const H = video.videoHeight;
      const detections: Detection[] = bboxes
        .filter((b) => b.score >= confidenceThreshold)
        .map((b) => {
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

      // FPS calculation
      const now = performance.now();
      fpsTimestamps.current.push(now);
      // Keep only last 2 seconds of timestamps
      fpsTimestamps.current = fpsTimestamps.current.filter((t) => now - t < 2000);
      const fps =
        fpsTimestamps.current.length > 1
          ? fpsTimestamps.current.length / ((now - fpsTimestamps.current[0]) / 1000)
          : 0;

      setStats((s) => {
        const n = s.framesProcessed + 1;
        const avgLat = (s.avgLatencyMs * s.framesProcessed + elapsed) / n;
        const avgDet =
          (s.avgDetections * s.framesProcessed + detections.length) / n;
        return {
          fps: Math.round(fps * 10) / 10,
          framesProcessed: n,
          detectionsThisFrame: detections.length,
          avgDetections: Math.round(avgDet * 10) / 10,
          latencyMs: Math.round(elapsed),
          avgLatencyMs: Math.round(avgLat),
          totalTracksEver: trackerRef.current.totalTracksEverSeen,
          lastError: "",
        };
      });
    } catch (e) {
      setStats((s) => ({ ...s, lastError: String(e) }));
    }

    inFlightRef.current = false;
    if (!stopRef.current) requestAnimationFrame(sendNextFrame);
  }, [runInference, confidenceThreshold]);

  // ---------- canvas redraw loop ----------

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.videoWidth > 0) {
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
          ctx.fillStyle = "#09090b";
          ctx.fillRect(0, 0, W, H);
          ctx.drawImage(video, 0, 0, W, H);

          const sx = W / video.videoWidth;
          const sy = H / video.videoHeight;
          ctx.font = "bold 13px ui-sans-serif, system-ui, sans-serif";

          for (const t of activeTracks) {
            const x = t.x1 * sx;
            const y = t.y1 * sy;
            const w = (t.x2 - t.x1) * sx;
            const h = (t.y2 - t.y1) * sy;

            // Semi-transparent fill
            ctx.fillStyle = `${t.color}20`;
            ctx.fillRect(x, y, w, h);

            // Border
            ctx.strokeStyle = t.color;
            ctx.lineWidth = 2.5;
            ctx.strokeRect(x, y, w, h);

            // Corner accents
            const cornerLen = Math.min(12, w / 4, h / 4);
            ctx.lineWidth = 3.5;
            ctx.beginPath();
            // top-left
            ctx.moveTo(x, y + cornerLen);
            ctx.lineTo(x, y);
            ctx.lineTo(x + cornerLen, y);
            // top-right
            ctx.moveTo(x + w - cornerLen, y);
            ctx.lineTo(x + w, y);
            ctx.lineTo(x + w, y + cornerLen);
            // bottom-right
            ctx.moveTo(x + w, y + h - cornerLen);
            ctx.lineTo(x + w, y + h);
            ctx.lineTo(x + w - cornerLen, y + h);
            // bottom-left
            ctx.moveTo(x + cornerLen, y + h);
            ctx.lineTo(x, y + h);
            ctx.lineTo(x, y + h - cornerLen);
            ctx.stroke();

            // Label tag
            const score = t.score != null ? ` ${Math.round(t.score * 100)}%` : "";
            const label = `#${t.id} ${t.label ?? ""}${score}`.trim();
            const metrics = ctx.measureText(label);
            const tagW = metrics.width + 14;
            const tagH = 20;
            const tagY = Math.max(0, y - tagH - 2);

            ctx.fillStyle = t.color;
            // Rounded tag background
            const r = 4;
            ctx.beginPath();
            ctx.moveTo(x + r, tagY);
            ctx.lineTo(x + tagW - r, tagY);
            ctx.quadraticCurveTo(x + tagW, tagY, x + tagW, tagY + r);
            ctx.lineTo(x + tagW, tagY + tagH - r);
            ctx.quadraticCurveTo(x + tagW, tagY + tagH, x + tagW - r, tagY + tagH);
            ctx.lineTo(x + r, tagY + tagH);
            ctx.quadraticCurveTo(x, tagY + tagH, x, tagY + tagH - r);
            ctx.lineTo(x, tagY + r);
            ctx.quadraticCurveTo(x, tagY, x + r, tagY);
            ctx.fill();

            ctx.fillStyle = "#000000";
            ctx.fillText(label, x + 7, tagY + 14);
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
    setStats(INITIAL_STATS);
    fpsTimestamps.current = [];
    setMode("idle");
  }, []);

  const startWebcam = useCallback(async () => {
    stopAllSources();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      trackerRef.current.reset();
      stopRef.current = false;
      await video.play();
      setMode("webcam");
      setTimeout(() => sendNextFrame(), 200);
    } catch (e) {
      setStats((s) => ({ ...s, lastError: `Webcam error: ${String(e)}` }));
    }
  }, [stopAllSources, sendNextFrame]);

  const startFile = useCallback(
    (file: File) => {
      stopAllSources();
      const video = videoRef.current;
      if (!video) return;
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      video.srcObject = null;
      video.src = url;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      trackerRef.current.reset();
      stopRef.current = false;
      video.play().catch(() => {});
      setMode("file");
      setTimeout(() => sendNextFrame(), 200);
    },
    [stopAllSources, sendNextFrame]
  );

  // Cleanup on unmount
  useEffect(() => () => stopAllSources(), [stopAllSources]);

  const onVideoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) startFile(f);
  };

  const onModelFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setModelFile(f);
      setModelName(f.name);
    }
  };

  const isRunning = mode !== "idle";

  // ---------- render ----------

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav — matches landing page */}
      <nav className="fixed top-0 z-50 w-full border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black">
              DLF
            </div>
            <span className="text-sm font-semibold tracking-tight">
              Data Label Factory
            </span>
          </Link>
          <div className="hidden items-center gap-8 text-sm text-zinc-400 sm:flex">
            <Link href="/build" className="transition hover:text-white">
              Build
            </Link>
            <Link href="/train" className="transition hover:text-white">
              Train
            </Link>
            <Link href="/label" className="transition hover:text-white">
              Label
            </Link>
            <Link
              href="/deploy"
              className="text-white font-medium"
            >
              Deploy
            </Link>
            <Link href="/pipeline" className="transition hover:text-white">
              Research
            </Link>
            <a
              href="https://github.com/walter-grace/data-label-factory"
              target="_blank"
              className="transition hover:text-white"
            >
              GitHub
            </a>
          </div>
          <Link
            href="/build"
            className="rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hidden elements */}
      <video ref={videoRef} className="hidden" />
      <canvas ref={captureCanvasRef} className="hidden" />

      {/* Content */}
      <div className="mx-auto max-w-7xl px-6 pt-20 pb-16">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Deploy{" "}
            <span className="bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
              &amp; Test
            </span>
          </h1>
          <p className="mt-2 text-zinc-400 max-w-xl">
            Upload your trained YOLO model, connect a webcam or video, and see
            real-time detections with persistent tracking.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          {/* Left column: video + controls */}
          <div className="space-y-5">
            {/* Model + Backend config */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <div className="grid gap-5 sm:grid-cols-2">
                {/* Model upload */}
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    Model Weights
                  </label>
                  <label className="group flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/60 px-4 py-3 transition hover:border-blue-500/50 hover:bg-zinc-800/60">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600/10 text-blue-400">
                      <svg
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                        />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {modelName || "Upload best.pt"}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {modelFile
                          ? `${(modelFile.size / 1024 / 1024).toFixed(1)} MB`
                          : "YOLO .pt model file"}
                      </p>
                    </div>
                    <input
                      type="file"
                      accept=".pt,.pth,.onnx"
                      className="hidden"
                      onChange={onModelFileChange}
                    />
                  </label>
                </div>

                {/* Detection query */}
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    Detection Query
                  </label>
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      queryRef.current = e.target.value;
                    }}
                    placeholder="e.g. stop sign, drone, person"
                    className="h-[58px] w-full rounded-xl border border-zinc-700/50 bg-zinc-900/60 px-4 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition"
                  />
                </div>
              </div>

              {/* GPU backend config */}
              <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-600/10 text-emerald-400">
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"
                      />
                    </svg>
                  </div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Connect GPU
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => setBackend("dlf")}
                      className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                        backend === "dlf"
                          ? "bg-blue-600 text-white"
                          : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      DLF Default
                    </button>
                    <button
                      onClick={() => setBackend("runpod")}
                      className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                        backend === "runpod"
                          ? "bg-blue-600 text-white"
                          : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      RunPod
                    </button>
                  </div>
                </div>

                {backend === "runpod" && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input
                      type="url"
                      value={runpodUrl}
                      onChange={(e) => setRunpodUrl(e.target.value)}
                      placeholder="https://api.runpod.ai/v2/.../runsync"
                      className="w-full rounded-lg border border-zinc-700/50 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition"
                    />
                    <input
                      type="password"
                      value={runpodToken}
                      onChange={(e) => setRunpodToken(e.target.value)}
                      placeholder="RunPod API token (optional)"
                      className="w-full rounded-lg border border-zinc-700/50 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition"
                    />
                  </div>
                )}

                {backend === "dlf" && (
                  <p className="text-xs text-zinc-600">
                    Using the default Falcon Perception backend configured in
                    your DLF server.
                  </p>
                )}
              </div>
            </div>

            {/* Source controls */}
            <div className="flex items-center gap-3">
              <button
                onClick={startWebcam}
                disabled={isRunning && mode === "webcam"}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                  />
                </svg>
                {mode === "webcam" ? "Webcam Active" : "Start Webcam"}
              </button>

              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 active:scale-[0.98]">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                  />
                </svg>
                Upload Video
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={onVideoFileChange}
                />
              </label>

              {isRunning && (
                <button
                  onClick={stopAllSources}
                  className="inline-flex items-center gap-2 rounded-xl border border-red-800/50 bg-red-950/30 px-5 py-2.5 text-sm font-medium text-red-400 transition hover:bg-red-950/60 active:scale-[0.98]"
                >
                  <svg
                    className="h-4 w-4"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                  Stop
                </button>
              )}

              {/* Confidence threshold */}
              <div className="ml-auto flex items-center gap-2">
                <label className="text-xs text-zinc-500 font-medium">
                  Min Confidence
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={confidenceThreshold}
                  onChange={(e) =>
                    setConfidenceThreshold(parseFloat(e.target.value))
                  }
                  className="w-24 accent-blue-600"
                />
                <span className="text-xs font-mono text-zinc-400 w-8">
                  {Math.round(confidenceThreshold * 100)}%
                </span>
              </div>
            </div>

            {/* Video canvas */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-3">
              {mode === "idle" ? (
                <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950">
                  <div className="text-center">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-900 border border-zinc-800">
                      <svg
                        className="h-8 w-8 text-zinc-600"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                        />
                      </svg>
                    </div>
                    <p className="text-sm text-zinc-500">
                      Start webcam or upload a video to begin detection
                    </p>
                    <p className="mt-1 text-xs text-zinc-600">
                      Frames are sent for inference, bounding boxes drawn in
                      real time
                    </p>
                  </div>
                </div>
              ) : (
                <canvas
                  ref={canvasRef}
                  className="w-full rounded-xl bg-black"
                />
              )}
            </div>

            {/* Active tracks list */}
            {activeTracks.length > 0 && (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Active Detections
                </h3>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {activeTracks.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2"
                    >
                      <div
                        className="h-3 w-3 rounded-full shrink-0"
                        style={{ backgroundColor: t.color }}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          #{t.id} {t.label}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {t.score != null
                            ? `${Math.round(t.score * 100)}% conf`
                            : ""}{" "}
                          &middot; {t.hits} hits
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right column: stats panel */}
          <div className="space-y-5">
            {/* Status indicator */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <div className="flex items-center gap-3 mb-4">
                <div
                  className={`h-2.5 w-2.5 rounded-full ${
                    isRunning
                      ? "bg-emerald-400 animate-pulse"
                      : "bg-zinc-600"
                  }`}
                />
                <span className="text-sm font-semibold">
                  {isRunning
                    ? mode === "webcam"
                      ? "Webcam Live"
                      : "Video Playing"
                    : "Idle"}
                </span>
                {backend === "runpod" && runpodUrl && (
                  <span className="ml-auto rounded-full bg-emerald-600/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
                    GPU
                  </span>
                )}
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  label="FPS"
                  value={stats.fps.toFixed(1)}
                  highlight={stats.fps > 0}
                />
                <StatCard
                  label="Latency"
                  value={`${stats.latencyMs}ms`}
                  sub={`avg ${stats.avgLatencyMs}ms`}
                  highlight={stats.latencyMs > 0}
                />
                <StatCard
                  label="Detections"
                  value={String(stats.detectionsThisFrame)}
                  sub={`avg ${stats.avgDetections}`}
                  highlight={stats.detectionsThisFrame > 0}
                />
                <StatCard
                  label="Frames"
                  value={String(stats.framesProcessed)}
                  highlight={stats.framesProcessed > 0}
                />
                <StatCard
                  label="Total Tracks"
                  value={String(stats.totalTracksEver)}
                  highlight={stats.totalTracksEver > 0}
                />
                <StatCard
                  label="Active Now"
                  value={String(activeTracks.length)}
                  highlight={activeTracks.length > 0}
                />
              </div>
            </div>

            {/* Model info */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Model
              </h3>
              {modelFile ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600/10 text-blue-400">
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z"
                        />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {modelName}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {(modelFile.size / 1024 / 1024).toFixed(1)} MB
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setModelFile(null);
                      setModelName("");
                    }}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition"
                  >
                    Remove model
                  </button>
                </div>
              ) : (
                <div className="text-center py-4">
                  <p className="text-xs text-zinc-500">
                    No model uploaded
                  </p>
                  <p className="text-xs text-zinc-600 mt-1">
                    Using default backend inference
                  </p>
                </div>
              )}
            </div>

            {/* Backend info */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Backend
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Endpoint</span>
                  <span className="text-zinc-300 font-mono text-xs">
                    {backend === "runpod" && runpodUrl
                      ? new URL(runpodUrl).hostname
                      : "Falcon (local)"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Type</span>
                  <span className="text-zinc-300">
                    {backend === "runpod" ? "RunPod GPU" : "DLF Default"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Query</span>
                  <span className="text-zinc-300 truncate ml-4 max-w-[160px]">
                    {query}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Threshold</span>
                  <span className="text-zinc-300">
                    {Math.round(confidenceThreshold * 100)}%
                  </span>
                </div>
              </div>
            </div>

            {/* Error display */}
            {stats.lastError && (
              <div className="rounded-2xl border border-red-900/50 bg-red-950/20 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-1">
                  Error
                </p>
                <p className="text-xs text-red-300/80 break-all">
                  {stats.lastError}
                </p>
              </div>
            )}

            {/* Help text */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                How It Works
              </h3>
              <ol className="space-y-2 text-xs text-zinc-500 list-decimal list-inside">
                <li>Upload a trained YOLO model (.pt file)</li>
                <li>Start your webcam or upload a video file</li>
                <li>
                  Each frame is sent to the inference backend
                </li>
                <li>
                  Bounding boxes are drawn with persistent IoU tracking
                </li>
                <li>
                  Connect a RunPod GPU endpoint for faster inference
                </li>
              </ol>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 py-8">
        <div className="mx-auto max-w-5xl px-6 flex flex-col items-center justify-between gap-4 text-sm text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[8px] font-black text-white">
              DLF
            </div>
            <span>Data Label Factory</span>
          </div>
          <div className="flex gap-6">
            <Link
              href="/build"
              className="transition hover:text-zinc-300"
            >
              Build
            </Link>
            <Link
              href="/train"
              className="transition hover:text-zinc-300"
            >
              Train
            </Link>
            <Link
              href="/pipeline"
              className="transition hover:text-zinc-300"
            >
              Research
            </Link>
            <Link
              href="/label"
              className="transition hover:text-zinc-300"
            >
              Label
            </Link>
            <Link
              href="/deploy"
              className="transition hover:text-zinc-300"
            >
              Deploy
            </Link>
            <a
              href="https://github.com/walter-grace/data-label-factory"
              target="_blank"
              className="transition hover:text-zinc-300"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Stat card sub-component
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-0.5">
        {label}
      </p>
      <p
        className={`text-lg font-bold tabular-nums ${
          highlight ? "text-zinc-100" : "text-zinc-600"
        }`}
      >
        {value}
      </p>
      {sub && <p className="text-[10px] text-zinc-600">{sub}</p>}
    </div>
  );
}
