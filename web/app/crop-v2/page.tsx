"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    Upload,
    Link as LinkIcon,
    Sparkles,
    Download,
    Share2,
    Captions,
    Scissors,
    Zap,
    Image as ImageIcon,
    Crosshair,
    ChevronRight,
    Film,
    Keyboard,
    X,
    Loader2,
    Check,
    Clock,
    User,
    Flame,
    ListMusic,
    Wand2,
    Monitor,
    Smartphone,
    ArrowLeft,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

import type {
    Speaker,
    CropSegment,
    FramePreview,
    AnalysisPlan,
    ViralClip,
    Thumbnail,
    AppliedEffect,
    Orientation,
    EffectKind,
} from "./types";
import {
    VideoCanvas,
    type VideoCanvasHandle,
} from "./components/video-canvas";
import { EffectsPanel } from "./components/effects-panel";
import { CaptionsPanel } from "./components/captions-panel";
import {
    DEFAULT_EFFECTS,
    countActiveEffects,
    type CanvasEffects,
} from "./lib/effects";
import {
    CAPTION_PRESETS,
    DEFAULT_CAPTION_STYLE,
    type CaptionStyle,
    type TranscriptSegment,
} from "./lib/captions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/* ---------- helpers ---------- */

const fmtTs = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const clipBaseName = (clip: ViralClip) =>
    `clip-${clip.rank}-${(clip.title || "viral").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "viral"}`;

// Rebuild a clip's ffmpeg command for the given orientation so we can swap
// 9:16 ↔ 16:9 without re-running /api/viral-clips.
//
// Vertical (9:16): fill the full height (1920) and crop width (1080) from
// the center. This gives a proper reel — no black bars — at the cost of
// cropping the sides of the source frame. For a 640x360 source this ends
// up as a ~3x zoom into the center third.
//
// Horizontal (16:9): scale the source to fill 1920x1080, preserving aspect
// ratio. 16:9 sources fit exactly; taller sources get letterboxed.
function buildClipFfmpegCommand(
    videoPath: string,
    t_start: number,
    t_end: number,
    outputFile: string,
    orientation: Orientation,
): string {
    const outW = orientation === "vertical" ? 1080 : 1920;
    const outH = orientation === "vertical" ? 1920 : 1080;
    const vf =
        orientation === "vertical"
            ? `scale=-2:${outH},crop=${outW}:${outH}:(iw-${outW})/2:0`
            : `scale=${outW}:-2,crop=${outW}:${outH}:0:(ih-${outH})/2`;
    const dur = t_end - t_start;
    return `/opt/homebrew/bin/ffmpeg -hide_banner -y -ss ${t_start.toFixed(2)} -t ${dur.toFixed(2)} -i "${videoPath}" -vf "${vf}" -c:a aac -b:a 128k "${outputFile}"`;
}

async function streamSse(
    url: string,
    body: unknown,
    handlers: {
        onStatus?: (msg: string) => void;
        onEvent?: (event: string, data: Record<string, unknown>) => void;
    },
): Promise<void> {
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!resp.body) throw new Error("No response body");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
            const em = block.match(/^event: (\S+)/);
            const dm = block.match(/^data: (.+)$/m);
            if (!em || !dm) continue;
            const ev = em[1];
            let d: Record<string, unknown> = {};
            try {
                d = JSON.parse(dm[1]);
            } catch {
                continue;
            }
            if (ev === "status" && typeof d.message === "string") {
                handlers.onStatus?.(d.message);
            }
            handlers.onEvent?.(ev, d);
        }
    }
}

/* ---------- main page ---------- */

export default function CropStudioPage() {
    // import / analyze state
    const [url, setUrl] = useState("");
    const [analyzing, setAnalyzing] = useState(false);
    const [analyzeStatus, setAnalyzeStatus] = useState("");
    const [uploadingName, setUploadingName] = useState<string | null>(null);
    const [plan, setPlan] = useState<AnalysisPlan | null>(null);
    const [speakers, setSpeakers] = useState<Speaker[]>([]);
    const [segments, setSegments] = useState<CropSegment[]>([]);
    const [frames, setFrames] = useState<FramePreview[]>([]);
    const [videoPath, setVideoPath] = useState("");

    // viral clips state
    const [orientation, setOrientation] = useState<Orientation>("vertical");
    const [generatingClips, setGeneratingClips] = useState(false);
    const [clips, setClips] = useState<ViralClip[]>([]);
    const [selectedRank, setSelectedRank] = useState<number | null>(null);

    // per-clip render state
    const [clipVideos, setClipVideos] = useState<Record<number, string>>({});
    const [clipCurrentFile, setClipCurrentFile] = useState<Record<number, string>>({});
    const [clipEffects, setClipEffects] = useState<Record<number, AppliedEffect[]>>({});
    const [clipThumbnails, setClipThumbnails] = useState<Record<number, Thumbnail[]>>({});

    const [renderingRank, setRenderingRank] = useState<number | null>(null);
    const [renderStep, setRenderStep] = useState("");
    const [renderProgress, setRenderProgress] = useState(0);
    const [baking, setBaking] = useState(false);

    // UI toggles
    const [showHelp, setShowHelp] = useState(false);
    const [thumbsOpen, setThumbsOpen] = useState<number | null>(null);
    const [hookText, setHookText] = useState("");

    const videoCanvasRef = useRef<VideoCanvasHandle | null>(null);
    const [playing, setPlaying] = useState(false);

    // per-clip canvas effects (live, no ffmpeg)
    const [canvasEffects, setCanvasEffects] = useState<
        Record<number, CanvasEffects>
    >({});
    const [currentTime, setCurrentTime] = useState(0);
    const [canvasFps, setCanvasFps] = useState<number | null>(null);

    // per-clip caption style + cached transcripts
    const [captionStyles, setCaptionStyles] = useState<
        Record<number, CaptionStyle>
    >({});
    const [transcripts, setTranscripts] = useState<
        Record<number, TranscriptSegment[]>
    >({});
    const [transcribingRank, setTranscribingRank] = useState<number | null>(
        null,
    );
    const [burningCaptions, setBurningCaptions] = useState(false);
    const [sidebarTab, setSidebarTab] = useState<"effects" | "captions">(
        "effects",
    );

    // ---- dev: ?demo=<absolute path> seeds a fake clip entry so the
    // effects panel can be exercised without running the full analyze +
    // generate + render pipeline. Pure client-side, touches no API
    // routes beyond serve-clip.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const params = new URLSearchParams(window.location.search);
        const demo = params.get("demo");
        if (!demo) return;
        // Stream directly from serve-clip; don't buffer the whole file into a blob.
        // Buffering breaks for >200MB files because /api/serve-clip caps maxBuffer.
        const streamUrl = `/api/serve-clip?path=${encodeURIComponent(demo)}`;
        const demoOut = demo.replace(/\.mp4$/, "_demo_render.mp4");
        const fakeClip: ViralClip = {
            rank: 1,
            title: "Demo clip",
            quote: "Live canvas effects preview",
            t_start: 0,
            t_end: 30,
            ffmpeg_command: buildClipFfmpegCommand(demo, 0, 30, demoOut, "vertical"),
            output_file: demoOut,
        };
        setClips([fakeClip]);
        setSelectedRank(1);
        setClipVideos({ 1: streamUrl });
        setClipCurrentFile({ 1: demo });
        setClipEffects({ 1: [] });
        setVideoPath(demo);
    }, []);

    // keep focus for keyboard shortcuts
    const rootRef = useRef<HTMLDivElement | null>(null);

    const selectedClip = useMemo(
        () => clips.find((c) => c.rank === selectedRank) ?? null,
        [clips, selectedRank],
    );

    const selectedVideoUrl = selectedClip ? clipVideos[selectedClip.rank] : undefined;
    const selectedEffects = selectedClip ? clipEffects[selectedClip.rank] ?? [] : [];
    const activeCanvasEffects: CanvasEffects = selectedClip
        ? canvasEffects[selectedClip.rank] ?? DEFAULT_EFFECTS
        : DEFAULT_EFFECTS;
    const activeEffectCount = countActiveEffects(activeCanvasEffects);

    const updateCanvasEffects = useCallback(
        (next: CanvasEffects) => {
            if (!selectedClip) return;
            setCanvasEffects((p) => ({ ...p, [selectedClip.rank]: next }));
        },
        [selectedClip],
    );

    const activeCaptionStyle: CaptionStyle = selectedClip
        ? captionStyles[selectedClip.rank] ?? DEFAULT_CAPTION_STYLE
        : DEFAULT_CAPTION_STYLE;

    const activeTranscript = selectedClip
        ? transcripts[selectedClip.rank]
        : undefined;

    const updateCaptionStyle = useCallback(
        (next: CaptionStyle) => {
            if (!selectedClip) return;
            setCaptionStyles((p) => ({ ...p, [selectedClip.rank]: next }));
        },
        [selectedClip],
    );

    const handleCaptionDrag = useCallback(
        (x: number, y: number) => {
            if (!selectedClip) return;
            setCaptionStyles((p) => {
                const cur = p[selectedClip.rank] ?? DEFAULT_CAPTION_STYLE;
                return {
                    ...p,
                    [selectedClip.rank]: { ...cur, positionX: x, positionY: y },
                };
            });
        },
        [selectedClip],
    );

    const fetchTranscript = useCallback(async () => {
        if (!selectedClip) return;
        const rank = selectedClip.rank;
        const currentFile = clipCurrentFile[rank] ?? selectedClip.output_file;
        if (!currentFile) {
            toast.error("No source file to transcribe");
            return;
        }
        setTranscribingRank(rank);
        try {
            const resp = await fetch("/api/transcribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ output_file: currentFile }),
            });
            const data = await resp.json();
            if (!data.ok) throw new Error(data.error ?? "transcribe failed");
            const segs = data.segments as TranscriptSegment[];
            setTranscripts((p) => ({ ...p, [rank]: segs }));
            // Auto-enable captions on first transcribe for instant feedback.
            setCaptionStyles((p) => ({
                ...p,
                [rank]: { ...(p[rank] ?? DEFAULT_CAPTION_STYLE), enabled: true },
            }));
            toast.success(
                `Transcribed ${segs.length} segment${segs.length === 1 ? "" : "s"}${
                    data.cached ? " (cached)" : ""
                }`,
            );
        } catch (e) {
            toast.error("Transcription failed", { description: String(e) });
        } finally {
            setTranscribingRank(null);
        }
    }, [selectedClip, clipCurrentFile]);

    const burnCaptions = useCallback(async () => {
        if (!selectedClip) return;
        const rank = selectedClip.rank;
        const currentFile = clipCurrentFile[rank] ?? selectedClip.output_file;
        if (!currentFile) {
            toast.error("Render the clip first");
            return;
        }
        const style = captionStyles[rank];
        if (!style || !style.enabled) {
            toast.error("Enable captions first");
            return;
        }

        setBurningCaptions(true);
        setRenderingRank(rank);
        setRenderStep("Burning captions…");
        setRenderProgress(0.15);

        try {
            let outFile = "";
            // One-word mode uses the word-per-cue SRT chunker on the server.
            const srtMode: "word" | "smart" =
                style.mode === "word" ? "word" : "smart";
            await streamSse(
                "/api/add-subtitles",
                {
                    output_file: currentFile,
                    style: srtMode,
                    frameWidth: orientation === "vertical" ? 1080 : 1920,
                    captionStyle: style,
                },
                {
                    onEvent: (ev, d) => {
                        if (ev === "status") {
                            setRenderStep(String(d.message ?? "Burning…"));
                            setRenderProgress((p) => Math.min(0.85, p + 0.08));
                        } else if (ev === "complete") {
                            outFile = String(d.subbed_file ?? "");
                        } else if (ev === "error") {
                            toast.error(`Burn error`, { description: String(d.error) });
                        }
                    },
                },
            );
            if (!outFile) throw new Error("No burned file produced");

            setRenderStep("Fetching preview…");
            setRenderProgress(0.9);
            // Cache-bust: serve-clip sets cache-control: max-age=3600 so
            // re-burning the same path would reuse the stale blob.
            const vresp = await fetch(
                `/api/serve-clip?path=${encodeURIComponent(outFile)}&ts=${Date.now()}`,
                { cache: "no-store" },
            );
            if (!vresp.ok) throw new Error(`serve-clip ${vresp.status}`);
            const blob = await vresp.blob();
            const prevUrl = clipVideos[rank];
            if (prevUrl) URL.revokeObjectURL(prevUrl);
            const objUrl = URL.createObjectURL(blob);
            setClipVideos((p) => ({ ...p, [rank]: objUrl }));
            setClipCurrentFile((p) => ({ ...p, [rank]: outFile }));
            setClipEffects((p) => ({
                ...p,
                [rank]: [
                    ...(p[rank] ?? []),
                    { kind: "subtitles", label: "Burned captions" },
                ],
            }));
            // Once baked, turn off the live preview — the captions are in
            // the video now and doubling them would look terrible.
            setCaptionStyles((p) => ({
                ...p,
                [rank]: { ...(p[rank] ?? DEFAULT_CAPTION_STYLE), enabled: false },
            }));
            setRenderProgress(1);
            toast.success("Captions burned");
        } catch (e) {
            toast.error("Burn failed", { description: String(e) });
        } finally {
            setBurningCaptions(false);
            setRenderingRank(null);
            setRenderStep("");
            setRenderProgress(0);
        }
    }, [selectedClip, clipCurrentFile, captionStyles, orientation, clipVideos]);

    const speakerColors = useMemo(() => {
        const m: Record<string, string> = {};
        for (const s of speakers) m[s.label] = s.color;
        return m;
    }, [speakers]);

    /* ---------- analyze ---------- */

    const analyzingRef = useRef(false);
    const runAnalyze = useCallback(async () => {
        if (!url) {
            toast.error("Paste a YouTube URL or upload a video first");
            return;
        }
        if (analyzingRef.current) return;
        analyzingRef.current = true;
        setAnalyzing(true);
        setPlan(null);
        setSpeakers([]);
        setSegments([]);
        setFrames([]);
        setClips([]);
        setClipVideos({});
        setClipCurrentFile({});
        setClipEffects({});
        setClipThumbnails({});
        setCanvasEffects({});
        setCaptionStyles({});
        setTranscripts({});
        setSelectedRank(null);
        setAnalyzeStatus("Connecting...");

        try {
            await streamSse(
                "/api/smart-crop",
                { url, sample_fps: 0.5, segment_duration: 3 },
                {
                    onEvent: (ev, d) => {
                        if (ev === "status") {
                            setAnalyzeStatus(String(d.message ?? ""));
                            // Smart-crop emits a "downloaded" status right after yt-dlp finishes.
                            // Capture the path immediately so the source video is previewable
                            // even if speaker tracking later returns 0 speakers.
                            if (d.step === "downloaded") {
                                const m = String(d.message ?? "").match(/\/tmp\/[^\s"']+\.mp4/);
                                if (m) setVideoPath(m[0]);
                            }
                        } else if (ev === "plan") {
                            const p = d as unknown as AnalysisPlan;
                            setPlan(p);
                            setSpeakers(p.speakers ?? []);
                            setSegments(p.segments ?? []);
                            const speakerCount = p.speakers?.length ?? 0;
                            if (speakerCount === 0) {
                                toast.warning("No speakers tracked", {
                                    description: "YOLO couldn't cluster speakers. You can still preview + send to Studio.",
                                });
                            } else {
                                toast.success(`Found ${speakerCount} speakers`, {
                                    description: `${p.segments?.length ?? 0} crop segments · ${p.analysis_time_seconds ?? "?"}s`,
                                });
                            }
                        } else if (ev === "frame") {
                            setFrames((prev) => [...prev, d as unknown as FramePreview]);
                        } else if (ev === "complete") {
                            setVideoPath(String(d.video_path ?? ""));
                            setAnalyzeStatus("Done");
                            toast.success("Analysis complete", {
                                description: "Click 'Generate Viral Clips' to continue",
                            });
                        } else if (ev === "error") {
                            toast.error(`Analyze error: ${d.error}`);
                        }
                    },
                },
            );
        } catch (e) {
            toast.error(`Analyze failed`, { description: String(e) });
        } finally {
            setAnalyzing(false);
            analyzingRef.current = false;
        }
    }, [url]);

    /* ---------- upload ---------- */

    const onFileUpload = useCallback(async (file: File) => {
        setUploadingName(file.name);
        try {
            const form = new FormData();
            form.set("video", file);
            const r = await fetch("/api/upload-video", { method: "POST", body: form });
            const data = await r.json();
            if (data.ok) {
                setUrl(data.path);
                toast.success("Uploaded", { description: file.name });
            } else {
                toast.error("Upload failed", { description: data.error });
            }
        } catch (err) {
            toast.error("Upload error", { description: String(err) });
        } finally {
            setUploadingName(null);
        }
    }, []);

    /* ---------- generate clips ---------- */

    const generateClips = useCallback(
        async (speakerFilter?: string) => {
            if (!plan) return;
            setGeneratingClips(true);
            setClips([]);
            setSelectedRank(null);
            setClipVideos({});
            setClipCurrentFile({});
            setClipEffects({});
            setClipThumbnails({});
            setCanvasEffects({});
            setCaptionStyles({});
            setTranscripts({});
            try {
                await streamSse(
                    "/api/viral-clips",
                    {
                        videoPath: videoPath || url,
                        speakers,
                        segments,
                        duration: plan.duration ?? 0,
                        sourceWidth: plan.source_width ?? 1920,
                        sourceHeight: plan.source_height ?? 1080,
                        numClips: 5,
                        clipLength: 30,
                        speakerHighlights: !speakerFilter,
                        orientation,
                        speakerFilter,
                    },
                    {
                        onEvent: (ev, d) => {
                            if (ev === "clips") {
                                const arr = (d.clips as ViralClip[]) ?? [];
                                setClips(arr);
                                if (arr.length) setSelectedRank(arr[0].rank);
                            } else if (ev === "complete") {
                                toast.success(`Generated ${d.total_clips ?? "some"} clips`);
                            } else if (ev === "error") {
                                toast.error(`Clip error: ${d.error}`);
                            }
                        },
                    },
                );
            } catch (e) {
                toast.error("Clip generation failed", { description: String(e) });
            } finally {
                setGeneratingClips(false);
            }
        },
        [plan, videoPath, url, speakers, segments, orientation],
    );

    /* ---------- render clip ---------- */

    const renderSelectedClip = useCallback(async () => {
        if (!selectedClip) {
            toast.error("Select a clip first");
            return;
        }
        setRenderingRank(selectedClip.rank);
        setRenderStep("Encoding with ffmpeg…");
        setRenderProgress(0.15);
        try {
            const resp = await fetch("/api/render-clip", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ffmpeg_command: selectedClip.ffmpeg_command,
                    output_file: selectedClip.output_file,
                }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error ?? `${resp.status}`);
            }
            setRenderProgress(0.75);
            const blob = await resp.blob();
            const objUrl = URL.createObjectURL(blob);
            setClipVideos((p) => ({ ...p, [selectedClip.rank]: objUrl }));
            setClipCurrentFile((p) => ({ ...p, [selectedClip.rank]: selectedClip.output_file }));
            setClipEffects((p) => ({ ...p, [selectedClip.rank]: [] }));
            setRenderProgress(1);
            toast.success(`Clip #${selectedClip.rank} rendered`);
        } catch (e) {
            toast.error("Render failed", { description: String(e) });
        } finally {
            setRenderingRank(null);
            setRenderStep("");
            setRenderProgress(0);
        }
    }, [selectedClip]);

    /* ---------- apply effect (generic) ---------- */

    const applyEffect = useCallback(
        async (
            kind: EffectKind,
            label: string,
            endpoint: string,
            body: Record<string, unknown>,
            outputKey: string = "output_file",
        ) => {
            if (!selectedClip) {
                toast.error("Select a clip first");
                return;
            }
            const rank = selectedClip.rank;
            const currentFile = clipCurrentFile[rank] ?? selectedClip.output_file;
            if (!clipVideos[rank]) {
                toast.error("Render the clip first", {
                    description: "Hit the Render button to encode the base clip.",
                });
                return;
            }

            setRenderingRank(rank);
            setRenderStep(`${label}…`);
            setRenderProgress(0.15);

            try {
                let outFile = "";
                await streamSse(
                    endpoint,
                    { ...body, output_file: currentFile },
                    {
                        onEvent: (ev, d) => {
                            if (ev === "status") {
                                setRenderStep(String(d.message ?? label));
                                setRenderProgress((p) => Math.min(0.85, p + 0.08));
                            } else if (ev === "complete") {
                                outFile = String(d[outputKey] ?? "");
                            } else if (ev === "error") {
                                toast.error(`${label} error`, { description: String(d.error) });
                            }
                        },
                    },
                );
                if (!outFile) throw new Error("No output file produced");

                setRenderStep("Fetching preview…");
                setRenderProgress(0.9);
                const vresp = await fetch(
                    `/api/serve-clip?path=${encodeURIComponent(outFile)}`,
                );
                if (!vresp.ok) throw new Error(`serve-clip ${vresp.status}`);
                const blob = await vresp.blob();
                const prevUrl = clipVideos[rank];
                if (prevUrl) URL.revokeObjectURL(prevUrl);
                const objUrl = URL.createObjectURL(blob);

                setClipVideos((p) => ({ ...p, [rank]: objUrl }));
                setClipCurrentFile((p) => ({ ...p, [rank]: outFile }));
                setClipEffects((p) => ({
                    ...p,
                    [rank]: [...(p[rank] ?? []), { kind, label }],
                }));
                setRenderProgress(1);
                toast.success(`${label} applied`);
            } catch (e) {
                toast.error(`${label} failed`, { description: String(e) });
            } finally {
                setRenderingRank(null);
                setRenderStep("");
                setRenderProgress(0);
            }
        },
        [selectedClip, clipCurrentFile, clipVideos],
    );

    const applySubtitles = useCallback(async () => {
        if (!selectedClip) return;
        const rank = selectedClip.rank;

        // Switch sidebar to Captions tab so the user sees the controls.
        setSidebarTab("captions");

        // Enable Classic preset live preview.
        setCaptionStyles((p) => ({
            ...p,
            [rank]: { ...CAPTION_PRESETS.classic, enabled: true },
        }));

        // Fetch transcript if we don't have it cached yet.
        if (!transcripts[rank]) {
            setTranscribingRank(rank);
            const file =
                clipCurrentFile[rank] ?? selectedClip.output_file;
            const toastId = toast.loading("Transcribing for captions…");
            try {
                const resp = await fetch("/api/transcribe", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ output_file: file }),
                });
                const data = await resp.json();
                if (data.ok) {
                    setTranscripts((p) => ({ ...p, [rank]: data.segments }));
                    toast.success(
                        `Captions ready — drag to position, then Burn`,
                        { id: toastId },
                    );
                } else {
                    toast.error(`Transcription failed: ${data.error}`, {
                        id: toastId,
                    });
                }
            } catch (e) {
                toast.error(`Transcription error: ${String(e)}`, {
                    id: toastId,
                });
            } finally {
                setTranscribingRank(null);
            }
        } else {
            toast.success("Captions enabled — drag to position, then Burn");
        }
    }, [selectedClip, transcripts, clipCurrentFile]);

    const applyFillers = useCallback(
        () => applyEffect("fillers", "Filler removal", "/api/remove-fillers", {}),
        [applyEffect],
    );

    const applyHook = useCallback(
        () =>
            applyEffect("hook", "Hook overlay", "/api/add-hook", {
                orientation,
                duration: 4,
                ...(hookText.trim() ? { hookText: hookText.trim() } : {}),
            }),
        [applyEffect, orientation, hookText],
    );

    const applyActiveCrop = useCallback(() => {
        if (!selectedClip) return;
        return applyEffect(
            "active-crop",
            "Active-speaker crop",
            "/api/active-crop",
            {
                videoPath: videoPath || url,
                t_start: selectedClip.t_start,
                t_end: selectedClip.t_end,
                orientation,
                outputFile: selectedClip.output_file.replace(".mp4", "_active.mp4"),
            },
        );
    }, [applyEffect, selectedClip, videoPath, url, orientation]);

    /* ---------- thumbnails ---------- */

    const pickThumbnails = useCallback(async () => {
        if (!selectedClip) return;
        const rank = selectedClip.rank;
        const currentFile = clipCurrentFile[rank] ?? selectedClip.output_file;
        if (!clipVideos[rank]) {
            toast.error("Render the clip first");
            return;
        }
        setRenderingRank(rank);
        setRenderStep("Scoring thumbnails…");
        setRenderProgress(0.3);
        try {
            const resp = await fetch("/api/pick-thumbnails", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ output_file: currentFile, count: 5 }),
            });
            const data = await resp.json();
            if (data.ok && data.thumbnails) {
                setClipThumbnails((p) => ({ ...p, [rank]: data.thumbnails }));
                setThumbsOpen(rank);
                toast.success(`Scored ${data.thumbnails.length} thumbnails`);
            } else {
                throw new Error(data.error ?? "unknown");
            }
        } catch (e) {
            toast.error("Thumbnail error", { description: String(e) });
        } finally {
            setRenderingRank(null);
            setRenderStep("");
            setRenderProgress(0);
        }
    }, [selectedClip, clipCurrentFile, clipVideos]);

    /* ---------- download ---------- */

    const downloadSelected = useCallback(async () => {
        if (!selectedClip) return;
        const rank = selectedClip.rank;
        const blobUrl = clipVideos[rank];
        if (!blobUrl) {
            toast.error("Nothing rendered yet");
            return;
        }

        const effectSlugs = (clipEffects[rank] ?? [])
            .map((e) => e.kind)
            .join("-");
        const orientSlug = orientation === "vertical" ? "9x16" : "16x9";
        const baseName = clipBaseName(selectedClip);

        const activeEffects = canvasEffects[rank] ?? DEFAULT_EFFECTS;
        const hasCanvasEffects = countActiveEffects(activeEffects) > 0;

        const triggerDownload = (href: string, filename: string) => {
            const a = document.createElement("a");
            a.href = href;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
        };

        // Fallback: no canvas effects → download current blob as-is.
        if (!hasCanvasEffects) {
            const name = `${baseName}-${orientSlug}${effectSlugs ? `-${effectSlugs}` : ""}.mp4`;
            triggerDownload(blobUrl, name);
            toast.success("Saved", { description: name });
            return;
        }

        // Bake canvas effects server-side, then download the baked mp4.
        const currentFile =
            clipCurrentFile[rank] ?? selectedClip.output_file;
        if (!currentFile) {
            toast.error("No source file to bake");
            return;
        }

        setBaking(true);
        const bakeToast = toast.loading("Baking effects…", {
            description: "Burning canvas effects into mp4",
        });
        try {
            let bakedFile = "";
            let bakeError: string | null = null;
            await streamSse(
                "/api/bake-effects",
                { output_file: currentFile, effects: activeEffects },
                {
                    onEvent: (ev, d) => {
                        if (ev === "status" && typeof d.message === "string") {
                            toast.loading(String(d.message), { id: bakeToast });
                        } else if (ev === "complete") {
                            bakedFile = String(d.output_file ?? "");
                        } else if (ev === "error") {
                            bakeError = String(d.error ?? "unknown");
                        }
                    },
                },
            );
            if (bakeError) throw new Error(bakeError);
            if (!bakedFile) throw new Error("No baked file produced");

            toast.loading("Fetching baked clip…", { id: bakeToast });
            const vresp = await fetch(
                `/api/serve-clip?path=${encodeURIComponent(bakedFile)}`,
            );
            if (!vresp.ok) throw new Error(`serve-clip ${vresp.status}`);
            const blob = await vresp.blob();
            const bakedUrl = URL.createObjectURL(blob);

            const name = `${baseName}-${orientSlug}${effectSlugs ? `-${effectSlugs}` : ""}-baked.mp4`;
            triggerDownload(bakedUrl, name);
            // Let the browser start the download before we revoke.
            setTimeout(() => URL.revokeObjectURL(bakedUrl), 10_000);

            toast.success(`Exported ${name}`, { id: bakeToast });
        } catch (e) {
            toast.error(`Bake failed: ${String(e)}`, { id: bakeToast });
        } finally {
            setBaking(false);
        }
    }, [
        selectedClip,
        clipVideos,
        clipEffects,
        clipCurrentFile,
        canvasEffects,
        orientation,
    ]);

    /* ---------- keyboard shortcuts ---------- */

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement | null)?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            if (e.key === "?" || (e.shiftKey && e.key === "/")) {
                e.preventDefault();
                setShowHelp((v) => !v);
            } else if (e.key === " ") {
                const v = videoCanvasRef.current?.video;
                if (v) {
                    e.preventDefault();
                    if (v.paused) v.play();
                    else v.pause();
                }
            } else if (e.key === "ArrowRight") {
                if (clips.length) {
                    e.preventDefault();
                    setSelectedRank((r) => {
                        const i = clips.findIndex((c) => c.rank === r);
                        const n = clips[Math.min(clips.length - 1, i + 1)];
                        return n?.rank ?? r;
                    });
                }
            } else if (e.key === "ArrowLeft") {
                if (clips.length) {
                    e.preventDefault();
                    setSelectedRank((r) => {
                        const i = clips.findIndex((c) => c.rank === r);
                        const n = clips[Math.max(0, i - 1)];
                        return n?.rank ?? r;
                    });
                }
            } else if (e.key === "r" || e.key === "R") {
                if (selectedClip && !clipVideos[selectedClip.rank]) {
                    e.preventDefault();
                    renderSelectedClip();
                }
            } else if (e.key === "s" || e.key === "S") {
                e.preventDefault();
                applySubtitles();
            } else if (e.key === "h" || e.key === "H") {
                e.preventDefault();
                applyHook();
            } else if (e.key === "Escape") {
                setShowHelp(false);
                setThumbsOpen(null);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [clips, selectedClip, clipVideos, applySubtitles, applyHook, renderSelectedClip]);

    /* ---------- derived UI ---------- */

    const phase: "empty" | "imported" | "analyzed" | "clips" =
        clips.length > 0
            ? "clips"
            : speakers.length > 0
              ? "analyzed"
              : url
                ? "imported"
                : "empty";

    const projectName = url
        ? (url.split("/").pop()?.replace(/^.*[vV]=/, "") ?? "untitled").slice(0, 40)
        : "untitled";

    return (
        <div
            ref={rootRef}
            className="min-h-screen bg-[oklch(0.14_0_0)] text-zinc-100 flex flex-col"
        >
            <Toaster position="top-right" />

            {/* ---------- top bar ---------- */}
            <header className="h-14 shrink-0 flex items-center gap-3 px-5 border-b border-white/10 bg-[oklch(0.17_0_0)]/90 backdrop-blur">
                <a
                    href="/inspector"
                    className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 transition"
                >
                    <ArrowLeft className="size-3.5" />
                    Back
                </a>
                <div className="flex items-center gap-2 pl-3 ml-1 border-l border-white/10">
                    <div className="size-7 rounded-md bg-gradient-to-br from-amber-400 to-rose-500 grid place-items-center shadow-lg shadow-amber-500/20">
                        <Film className="size-4 text-black" />
                    </div>
                    <div className="flex flex-col leading-tight">
                        <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                            Crop Studio
                        </span>
                        <span className="text-xs text-zinc-200 font-mono truncate max-w-[260px]">
                            {projectName}
                        </span>
                    </div>
                </div>

                <div className="flex-1" />

                <OrientationToggle
                    value={orientation}
                    onChange={(o) => {
                        if (o === orientation) return;
                        setOrientation(o);
                        setClips((prev) =>
                            prev.map((clip) => ({
                                ...clip,
                                ffmpeg_command: buildClipFfmpegCommand(
                                    videoPath || url,
                                    clip.t_start,
                                    clip.t_end,
                                    clip.output_file,
                                    o,
                                ),
                            })),
                        );
                        setClipVideos({});
                        setClipCurrentFile({});
                        setClipEffects({});
                    }}
                />

                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowHelp(true)}
                    className="gap-1.5"
                    title="Keyboard shortcuts (?)"
                >
                    <Keyboard className="size-3.5" />
                    <span className="hidden md:inline">Shortcuts</span>
                </Button>

                <Button
                    size="sm"
                    onClick={downloadSelected}
                    disabled={!selectedClip || !selectedVideoUrl || baking}
                    className="gap-1.5 bg-gradient-to-br from-amber-400 to-rose-500 text-black hover:brightness-110 disabled:opacity-40"
                >
                    {baking ? (
                        <>
                            <Loader2 className="size-3.5 animate-spin" />
                            Baking…
                        </>
                    ) : (
                        <>
                            <Download className="size-3.5" />
                            Export
                        </>
                    )}
                </Button>
            </header>

            {/* ---------- body: 3 zones ---------- */}
            <div className="flex-1 flex min-h-0">
                {/* LEFT SIDEBAR: clip list */}
                <aside className="w-[280px] shrink-0 border-r border-white/10 bg-[oklch(0.15_0_0)] flex flex-col min-h-0">
                    <ImportPanel
                        url={url}
                        setUrl={setUrl}
                        analyzing={analyzing}
                        analyzeStatus={analyzeStatus}
                        uploadingName={uploadingName}
                        onUpload={onFileUpload}
                        onAnalyze={runAnalyze}
                    />

                    {speakers.length > 0 && (
                        <div className="px-4 py-3 border-b border-white/10">
                            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">
                                Speakers
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {speakers.map((s) => (
                                    <button
                                        key={s.id}
                                        onClick={() => generateClips(s.label)}
                                        disabled={generatingClips}
                                        title={`Generate ${s.label} reel`}
                                        className="group flex items-center gap-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 px-2 py-1 text-[11px] transition disabled:opacity-40"
                                    >
                                        <span
                                            className="size-2 rounded-full"
                                            style={{ backgroundColor: s.color }}
                                        />
                                        <span style={{ color: s.color }}>{s.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="flex-1 overflow-y-auto">
                        {phase === "clips" ? (
                            <div className="p-3 space-y-2">
                                <div className="flex items-center justify-between px-1 pb-1">
                                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                                        Viral clips · {clips.length}
                                    </div>
                                    <button
                                        onClick={() => generateClips()}
                                        disabled={generatingClips}
                                        className="text-[10px] text-zinc-400 hover:text-amber-300 transition disabled:opacity-40"
                                    >
                                        Regenerate
                                    </button>
                                </div>
                                {clips.map((clip) => (
                                    <ClipCard
                                        key={clip.rank}
                                        clip={clip}
                                        selected={clip.rank === selectedRank}
                                        rendered={!!clipVideos[clip.rank]}
                                        effects={clipEffects[clip.rank] ?? []}
                                        speakerColor={
                                            clip.speaker
                                                ? speakerColors[clip.speaker]
                                                : clip.color
                                        }
                                        onClick={() => setSelectedRank(clip.rank)}
                                    />
                                ))}
                            </div>
                        ) : phase === "analyzed" ? (
                            <div className="p-4">
                                <Button
                                    onClick={() => generateClips()}
                                    disabled={generatingClips}
                                    className="w-full gap-2 bg-gradient-to-br from-amber-400 to-rose-500 text-black hover:brightness-110 disabled:opacity-50"
                                >
                                    {generatingClips ? (
                                        <>
                                            <Loader2 className="size-4 animate-spin" />
                                            Generating…
                                        </>
                                    ) : (
                                        <>
                                            <Flame className="size-4" />
                                            Generate viral clips
                                        </>
                                    )}
                                </Button>
                                <p className="text-[11px] text-zinc-500 mt-3 leading-relaxed">
                                    We&rsquo;ll use the transcript + Gemma to pick
                                    5 quotable, {orientation === "vertical" ? "9:16" : "16:9"} clips.
                                </p>
                            </div>
                        ) : analyzing ? (
                            <div className="p-4 space-y-3">
                                {[1, 2, 3, 4, 5].map((i) => (
                                    <Skeleton
                                        key={i}
                                        className="w-full h-[72px] rounded-lg bg-white/5"
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="p-5 text-[11px] text-zinc-500 leading-relaxed">
                                Paste a YouTube URL or upload a podcast to get started. We&rsquo;ll detect speakers with YOLO and build a viral-clip plan.
                            </div>
                        )}
                    </div>

                    {plan && frames.length > 0 && (
                        <FramesStrip frames={frames} speakerColors={speakerColors} />
                    )}
                </aside>

                {/* CENTER: hero player + effect rail */}
                <main className="flex-1 flex flex-col min-w-0 min-h-0">
                    <div className="flex-1 flex min-h-0">
                        <div className="flex-1 min-w-0 flex">
                            <HeroPlayer
                                videoCanvasRef={videoCanvasRef}
                                clip={selectedClip}
                                videoUrl={selectedVideoUrl}
                                sourcePath={videoPath}
                                speakerCount={speakers.length}
                                orientation={orientation}
                                phase={phase}
                                analyzing={analyzing}
                                generatingClips={generatingClips}
                                renderingRank={renderingRank}
                                renderStep={renderStep}
                                renderProgress={renderProgress}
                                playing={playing}
                                setPlaying={setPlaying}
                                effects={selectedEffects}
                                canvasEffects={activeCanvasEffects}
                                captionStyle={activeCaptionStyle}
                                transcript={activeTranscript}
                                activeCanvasCount={activeEffectCount}
                                onTime={setCurrentTime}
                                onFps={setCanvasFps}
                                onRender={renderSelectedClip}
                                hasRendered={
                                    !!(selectedClip && clipVideos[selectedClip.rank])
                                }
                                thumbnails={
                                    selectedClip ? clipThumbnails[selectedClip.rank] : undefined
                                }
                                onSeekTo={(t) => {
                                    const v = videoCanvasRef.current?.video;
                                    if (v) {
                                        v.currentTime = t;
                                        v.pause();
                                    }
                                }}
                                onCaptionDrag={handleCaptionDrag}
                            />
                        </div>
                        <aside className="w-[320px] shrink-0 border-l border-white/10 bg-[oklch(0.15_0_0)] overflow-y-auto p-4">
                            <Tabs value={sidebarTab} onValueChange={(v) => setSidebarTab(v as "effects" | "captions")} className="gap-3">
                                <TabsList className="w-full bg-white/[0.04] border border-white/10">
                                    <TabsTrigger value="effects">
                                        <Wand2 className="size-3" />
                                        Effects
                                    </TabsTrigger>
                                    <TabsTrigger value="captions">
                                        <Captions className="size-3" />
                                        Captions
                                        {activeCaptionStyle.enabled && (
                                            <span className="ml-1 size-1.5 rounded-full bg-cyan-400" />
                                        )}
                                    </TabsTrigger>
                                </TabsList>
                                <TabsContent value="effects">
                                    <EffectsPanel
                                        effects={activeCanvasEffects}
                                        onChange={updateCanvasEffects}
                                        currentTime={currentTime}
                                        fps={canvasFps ?? undefined}
                                        disabled={
                                            !selectedClip || !selectedVideoUrl
                                        }
                                    />
                                </TabsContent>
                                <TabsContent value="captions">
                                    <CaptionsPanel
                                        style={activeCaptionStyle}
                                        onChange={updateCaptionStyle}
                                        transcriptAvailable={!!activeTranscript}
                                        segmentCount={activeTranscript?.length ?? 0}
                                        transcribing={
                                            transcribingRank === selectedClip?.rank
                                        }
                                        onFetchTranscript={fetchTranscript}
                                        onBake={burnCaptions}
                                        baking={burningCaptions}
                                        disabled={
                                            !selectedClip || !selectedVideoUrl
                                        }
                                    />
                                </TabsContent>
                            </Tabs>
                        </aside>
                    </div>

                    <FeatureRail
                        disabled={!selectedClip || !selectedVideoUrl}
                        busy={renderingRank !== null}
                        effects={selectedEffects}
                        hookText={hookText}
                        setHookText={setHookText}
                        onSubtitles={applySubtitles}
                        onFillers={applyFillers}
                        onHook={applyHook}
                        onActiveCrop={applyActiveCrop}
                        onThumbnails={pickThumbnails}
                        onDownload={downloadSelected}
                        hasThumbs={
                            !!(
                                selectedClip && clipThumbnails[selectedClip.rank]?.length
                            )
                        }
                        onOpenThumbs={() => selectedClip && setThumbsOpen(selectedClip.rank)}
                    />
                </main>
            </div>

            {/* ---------- modals ---------- */}
            {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
            {thumbsOpen !== null && clipThumbnails[thumbsOpen]?.length && (
                <ThumbsDialog
                    thumbs={clipThumbnails[thumbsOpen]}
                    onClose={() => setThumbsOpen(null)}
                />
            )}
        </div>
    );
}

/* ---------- sub-components ---------- */

function OrientationToggle({
    value,
    onChange,
}: {
    value: Orientation;
    onChange: (o: Orientation) => void;
}) {
    return (
        <div className="flex rounded-lg border border-white/10 bg-white/5 p-0.5">
            <button
                onClick={() => onChange("vertical")}
                className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition",
                    value === "vertical"
                        ? "bg-white text-black"
                        : "text-zinc-400 hover:text-zinc-100",
                )}
            >
                <Smartphone className="size-3" />
                9:16
            </button>
            <button
                onClick={() => onChange("horizontal")}
                className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition",
                    value === "horizontal"
                        ? "bg-white text-black"
                        : "text-zinc-400 hover:text-zinc-100",
                )}
            >
                <Monitor className="size-3" />
                16:9
            </button>
        </div>
    );
}

function ImportPanel({
    url,
    setUrl,
    analyzing,
    analyzeStatus,
    uploadingName,
    onUpload,
    onAnalyze,
}: {
    url: string;
    setUrl: (v: string) => void;
    analyzing: boolean;
    analyzeStatus: string;
    uploadingName: string | null;
    onUpload: (file: File) => void;
    onAnalyze: () => void;
}) {
    return (
        <div className="p-4 border-b border-white/10 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                Source
            </div>
            <div className="relative">
                <LinkIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-zinc-500" />
                <input
                    type="text"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && onAnalyze()}
                    placeholder="YouTube URL or /tmp/video.mp4"
                    className="w-full rounded-lg bg-black/40 border border-white/10 pl-8 pr-2 py-2 text-xs font-mono placeholder:text-zinc-600 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                />
            </div>
            <div className="flex gap-2">
                <label className="flex-1 cursor-pointer">
                    <input
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onUpload(f);
                        }}
                        disabled={analyzing || !!uploadingName}
                    />
                    <div className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 bg-white/5 hover:bg-white/10 px-3 py-2 text-[11px] text-zinc-300 transition">
                        {uploadingName ? (
                            <>
                                <Loader2 className="size-3.5 animate-spin" />
                                <span className="truncate max-w-[140px]">{uploadingName}</span>
                            </>
                        ) : (
                            <>
                                <Upload className="size-3.5" />
                                Upload
                            </>
                        )}
                    </div>
                </label>
                <Button
                    size="sm"
                    onClick={onAnalyze}
                    disabled={analyzing || !url}
                    className="gap-1.5 bg-amber-500 hover:bg-amber-400 text-black flex-1 disabled:opacity-40"
                >
                    {analyzing ? (
                        <>
                            <Loader2 className="size-3.5 animate-spin" />
                            <span className="truncate">{analyzeStatus || "Analyzing…"}</span>
                        </>
                    ) : (
                        <>
                            <Sparkles className="size-3.5" />
                            Analyze
                        </>
                    )}
                </Button>
            </div>
        </div>
    );
}

function ClipCard({
    clip,
    selected,
    rendered,
    effects,
    speakerColor,
    onClick,
}: {
    clip: ViralClip;
    selected: boolean;
    rendered: boolean;
    effects: AppliedEffect[];
    speakerColor?: string;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "group/clip text-left w-full rounded-xl p-3 border transition-all",
                selected
                    ? "bg-white/10 border-amber-400/60 shadow-[0_0_0_1px_rgba(251,191,36,0.25),0_8px_20px_-8px_rgba(251,191,36,0.3)]"
                    : "bg-white/[0.03] border-white/10 hover:bg-white/[0.06] hover:border-white/20",
            )}
        >
            <div className="flex items-start gap-2">
                <div
                    className={cn(
                        "size-6 rounded-lg grid place-items-center text-[11px] font-bold shrink-0",
                        selected ? "bg-amber-400 text-black" : "bg-white/10 text-zinc-300",
                    )}
                >
                    {clip.rank}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-semibold text-zinc-100 truncate">
                        {clip.title || `Clip ${clip.rank}`}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-zinc-500 font-mono">
                        <Clock className="size-2.5" />
                        {fmtTs(clip.t_start)} – {fmtTs(clip.t_end)}
                        {speakerColor && (
                            <>
                                <span className="text-zinc-700">·</span>
                                <User className="size-2.5" style={{ color: speakerColor }} />
                                <span style={{ color: speakerColor }}>{clip.speaker}</span>
                            </>
                        )}
                    </div>
                </div>
                {rendered && (
                    <div className="size-4 rounded-full bg-emerald-500/20 grid place-items-center">
                        <Check className="size-2.5 text-emerald-400" />
                    </div>
                )}
            </div>
            {clip.quote && (
                <div className="mt-2 text-[11px] text-zinc-400 italic leading-snug line-clamp-2">
                    &ldquo;{clip.quote}&rdquo;
                </div>
            )}
            {effects.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                    {effects.map((e, i) => (
                        <Badge
                            key={i}
                            variant="outline"
                            className="text-[9px] h-4 bg-white/5 border-white/15 text-zinc-300"
                        >
                            {e.label}
                        </Badge>
                    ))}
                </div>
            )}
        </button>
    );
}

function HeroPlayer({
    videoCanvasRef,
    clip,
    videoUrl,
    sourcePath,
    speakerCount,
    orientation,
    phase,
    analyzing,
    generatingClips,
    renderingRank,
    renderStep,
    renderProgress,
    playing,
    setPlaying,
    effects,
    canvasEffects,
    captionStyle,
    transcript,
    activeCanvasCount,
    onTime,
    onFps,
    onRender,
    hasRendered,
    thumbnails,
    onSeekTo,
    onCaptionDrag,
}: {
    videoCanvasRef: React.RefObject<VideoCanvasHandle | null>;
    clip: ViralClip | null;
    videoUrl?: string;
    sourcePath?: string;
    speakerCount?: number;
    orientation: Orientation;
    phase: "empty" | "imported" | "analyzed" | "clips";
    analyzing: boolean;
    generatingClips: boolean;
    renderingRank: number | null;
    renderStep: string;
    renderProgress: number;
    playing: boolean;
    setPlaying: (v: boolean) => void;
    effects: AppliedEffect[];
    canvasEffects: CanvasEffects;
    captionStyle?: CaptionStyle;
    transcript?: TranscriptSegment[];
    activeCanvasCount: number;
    onTime: (t: number) => void;
    onFps: (fps: number) => void;
    onRender: () => void;
    hasRendered: boolean;
    thumbnails?: Thumbnail[];
    onSeekTo?: (t: number) => void;
    onCaptionDrag?: (x: number, y: number) => void;
}) {
    const busy = renderingRank !== null;
    return (
        <div className="flex-1 flex flex-col items-center justify-center min-h-0 bg-[radial-gradient(ellipse_at_center,oklch(0.2_0_0)_0%,oklch(0.13_0_0)_70%)] p-6 gap-5">
            {/* Pipeline breadcrumb */}
            {clip && (
                <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <span className="text-zinc-500">Raw clip</span>
                    {effects.map((e, i) => (
                        <span key={i} className="flex items-center gap-1.5">
                            <ChevronRight className="size-3 text-zinc-700" />
                            <span className="text-zinc-200">+ {e.label}</span>
                        </span>
                    ))}
                    {!effects.length && (
                        <>
                            <ChevronRight className="size-3 text-zinc-700" />
                            <span className="text-zinc-600">
                                Add effects below
                            </span>
                        </>
                    )}
                </div>
            )}

            <div
                className={cn(
                    "relative rounded-2xl overflow-hidden shadow-2xl bg-black ring-1 ring-white/10",
                    orientation === "vertical"
                        ? "h-[min(68vh,640px)] aspect-[9/16]"
                        : "aspect-[16/9] max-w-[min(72vw,960px)] w-full",
                )}
            >
                {videoUrl && clip ? (
                    <>
                        <VideoCanvas
                            ref={videoCanvasRef}
                            key={videoUrl}
                            src={videoUrl}
                            effects={canvasEffects}
                            captionStyle={captionStyle}
                            transcript={transcript}
                            autoPlay
                            onPlay={() => setPlaying(true)}
                            onPause={() => setPlaying(false)}
                            onTimeUpdate={onTime}
                            onFrameRate={onFps}
                            onCaptionDrag={onCaptionDrag}
                            className="absolute inset-0 w-full h-full"
                        />
                        {activeCanvasCount > 0 && (
                            <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 rounded-full bg-black/60 backdrop-blur border border-amber-400/60 px-2.5 py-1 text-[10px] font-medium text-amber-200">
                                <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />
                                Live Preview · {activeCanvasCount} effect
                                {activeCanvasCount === 1 ? "" : "s"}
                            </div>
                        )}
                    </>
                ) : clip ? (
                    <div className="absolute inset-0 grid place-items-center">
                        <div className="text-center max-w-xs">
                            <div className="size-14 mx-auto rounded-full bg-amber-500/10 ring-1 ring-amber-500/30 grid place-items-center mb-3">
                                <Wand2 className="size-6 text-amber-400" />
                            </div>
                            <div className="text-sm font-medium text-zinc-200">
                                {clip.title || `Clip ${clip.rank}`}
                            </div>
                            <div className="text-xs text-zinc-500 mt-1">
                                Press R to render this clip
                            </div>
                        </div>
                    </div>
                ) : phase === "clips" ? (
                    <div className="absolute inset-0 grid place-items-center text-zinc-500 text-sm">
                        Pick a clip from the left to preview
                    </div>
                ) : analyzing ? (
                    <div className="absolute inset-0 grid place-items-center">
                        <div className="flex flex-col items-center gap-3">
                            <Loader2 className="size-6 text-amber-400 animate-spin" />
                            <div className="text-xs text-zinc-400">Analyzing video…</div>
                        </div>
                    </div>
                ) : generatingClips ? (
                    <div className="absolute inset-0 grid place-items-center">
                        <div className="flex flex-col items-center gap-3">
                            <Flame className="size-6 text-rose-400 animate-pulse" />
                            <div className="text-xs text-zinc-400">Finding viral moments…</div>
                        </div>
                    </div>
                ) : sourcePath ? (
                    <>
                        <video
                            src={`/api/serve-clip?path=${encodeURIComponent(sourcePath)}`}
                            className="absolute inset-0 h-full w-full object-contain bg-black"
                            controls
                            playsInline
                        />
                        <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium text-zinc-200 ring-1 ring-white/20">
                            <span className="size-1.5 rounded-full bg-emerald-400" />
                            Source · {sourcePath.split("/").pop()}
                        </div>
                        {!analyzing && !generatingClips && (speakerCount ?? 0) === 0 && (phase as string) !== "clips" && (
                            <div className="absolute bottom-3 inset-x-3 z-10 flex items-center justify-between gap-2 rounded-lg bg-amber-950/80 px-3 py-2 ring-1 ring-amber-500/40 backdrop-blur">
                                <div className="text-[11px] text-amber-100">
                                    <div className="font-medium">No speakers tracked</div>
                                    <div className="text-amber-300/80 text-[10px]">YOLO couldn&apos;t cluster this video. Open it in Studio to edit manually.</div>
                                </div>
                                <a
                                    href="/studio"
                                    className="shrink-0 rounded-md bg-amber-400 px-3 py-1.5 text-[11px] font-semibold text-amber-950 hover:bg-amber-300"
                                >
                                    Open in Studio →
                                </a>
                            </div>
                        )}
                    </>
                ) : (
                    <EmptyHero />
                )}

                {/* render progress overlay */}
                {busy && (
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm grid place-items-center">
                        <div className="w-[70%] max-w-sm text-center">
                            <Loader2 className="size-6 text-amber-400 animate-spin mx-auto mb-3" />
                            <div className="text-sm text-zinc-100 font-medium mb-2 truncate">
                                {renderStep}
                            </div>
                            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-amber-400 to-rose-500 transition-all duration-500"
                                    style={{ width: `${Math.max(5, renderProgress * 100)}%` }}
                                />
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Thumbnail strip — appears below the video once picked */}
            {hasRendered && thumbnails && thumbnails.length > 0 && (
                <div className="w-full max-w-xl mx-auto">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">
                        Cover thumbnails · click to seek
                    </div>
                    <div className="grid grid-cols-5 gap-2">
                        {thumbnails.map((thumb, i) => (
                            <button
                                key={i}
                                onClick={() => onSeekTo?.(thumb.timestamp)}
                                className="group relative aspect-[9/16] rounded-md overflow-hidden border border-white/10 hover:border-amber-400/60 hover:scale-105 transition-all"
                                title={`t=${thumb.timestamp.toFixed(1)}s · score ${thumb.score}`}
                            >
                                <img
                                    src={`data:image/png;base64,${thumb.imageB64}`}
                                    alt={`t=${thumb.timestamp}s`}
                                    className="w-full h-full object-cover"
                                />
                                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1 text-[9px] font-mono text-white flex justify-between items-end">
                                    <span>{thumb.timestamp.toFixed(1)}s</span>
                                    <span className="text-amber-300">{thumb.score.toFixed(2)}</span>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {clip && !hasRendered && !busy && (
                <Button
                    size="lg"
                    onClick={onRender}
                    className="gap-2 h-11 px-6 bg-gradient-to-br from-amber-400 to-rose-500 text-black hover:brightness-110"
                >
                    <Sparkles className="size-4" />
                    Render clip
                    <kbd className="ml-1 text-[10px] font-mono bg-black/20 rounded px-1 py-0.5">R</kbd>
                </Button>
            )}
        </div>
    );
}

function EmptyHero() {
    return (
        <div className="absolute inset-0 grid place-items-center p-8">
            <div className="text-center max-w-sm">
                <div className="size-16 mx-auto rounded-2xl bg-gradient-to-br from-amber-400/20 to-rose-500/20 ring-1 ring-amber-400/30 grid place-items-center mb-4">
                    <Sparkles className="size-7 text-amber-300" />
                </div>
                <h2 className="text-base font-semibold text-zinc-100">
                    Turn podcasts into viral clips
                </h2>
                <p className="text-[12px] text-zinc-400 mt-2 leading-relaxed">
                    Paste a YouTube URL on the left, and we&rsquo;ll detect speakers, find 5 quotable moments, and let you apply subtitles, filler removal, hooks, and more.
                </p>
            </div>
        </div>
    );
}

function FeatureRail({
    disabled,
    busy,
    effects,
    hookText,
    setHookText,
    onSubtitles,
    onFillers,
    onHook,
    onActiveCrop,
    onThumbnails,
    onDownload,
    hasThumbs,
    onOpenThumbs,
}: {
    disabled: boolean;
    busy: boolean;
    effects: AppliedEffect[];
    hookText: string;
    setHookText: (v: string) => void;
    onSubtitles: () => void;
    onFillers: () => void;
    onHook: () => void;
    onActiveCrop: () => void;
    onThumbnails: () => void;
    onDownload: () => void;
    hasThumbs: boolean;
    onOpenThumbs: () => void;
}) {
    const has = (k: EffectKind) => effects.some((e) => e.kind === k);
    return (
        <div className="border-t border-white/10 bg-[oklch(0.16_0_0)]">
            <div className="px-5 pt-4 pb-3 flex items-center justify-between">
                <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                        Post-render features
                    </div>
                    <div className="text-[11px] text-zinc-600 mt-0.5">
                        Stack as many as you like — they apply in order.
                    </div>
                </div>
                <div className="flex gap-2">
                    {hasThumbs && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={onOpenThumbs}
                            className="gap-1.5 text-zinc-300"
                        >
                            <ImageIcon className="size-3.5" />
                            View thumbnails
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onDownload}
                        disabled={disabled}
                        className="gap-1.5 text-zinc-300"
                    >
                        <Download className="size-3.5" />
                        Download
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled
                        className="gap-1.5 text-zinc-500"
                        title="Coming soon"
                    >
                        <Share2 className="size-3.5" />
                        Share
                    </Button>
                </div>
            </div>
            <div className="px-5 pb-5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
                <FeatureCard
                    icon={<Captions className="size-4" />}
                    title="Smart subtitles"
                    desc="Width + phrase aware"
                    shortcut="S"
                    applied={has("subtitles")}
                    onClick={onSubtitles}
                    disabled={disabled || busy}
                    accent="from-sky-400 to-blue-600"
                />
                <FeatureCard
                    icon={<Scissors className="size-4" />}
                    title="Remove fillers"
                    desc="Cuts ums, ahs, likes"
                    applied={has("fillers")}
                    onClick={onFillers}
                    disabled={disabled || busy}
                    accent="from-violet-400 to-purple-600"
                />
                <FeatureCard
                    icon={<Zap className="size-4" />}
                    title="Hook text overlay"
                    desc="LLM-generated hook"
                    shortcut="H"
                    applied={has("hook")}
                    onClick={onHook}
                    disabled={disabled || busy}
                    accent="from-orange-400 to-rose-600"
                    extra={
                        <input
                            type="text"
                            value={hookText}
                            onChange={(e) => setHookText(e.target.value)}
                            placeholder="Custom text (optional)"
                            className="mt-2 w-full rounded-md bg-black/30 border border-white/10 px-2 py-1 text-[10px] placeholder:text-zinc-600 focus:border-amber-400/50 focus:outline-none"
                            onClick={(e) => e.stopPropagation()}
                        />
                    }
                />
                <FeatureCard
                    icon={<Crosshair className="size-4" />}
                    title="Active-speaker crop"
                    desc="Crop follows talker"
                    applied={has("active-crop")}
                    onClick={onActiveCrop}
                    disabled={disabled || busy}
                    accent="from-pink-400 to-fuchsia-600"
                />
                <FeatureCard
                    icon={<ImageIcon className="size-4" />}
                    title="Pick thumbnails"
                    desc="5 scored options"
                    applied={hasThumbs}
                    onClick={onThumbnails}
                    disabled={disabled || busy}
                    accent="from-teal-400 to-emerald-600"
                />
            </div>
        </div>
    );
}

function FeatureCard({
    icon,
    title,
    desc,
    shortcut,
    applied,
    onClick,
    disabled,
    accent,
    extra,
}: {
    icon: React.ReactNode;
    title: string;
    desc: string;
    shortcut?: string;
    applied: boolean;
    onClick: () => void;
    disabled: boolean;
    accent: string;
    extra?: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "group/fc text-left rounded-xl p-3 border transition-all relative overflow-hidden",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                applied
                    ? "bg-white/[0.07] border-white/20"
                    : "bg-white/[0.03] border-white/10 hover:bg-white/[0.06] hover:border-white/20",
            )}
        >
            <div
                className={cn(
                    "absolute -top-12 -right-12 size-28 rounded-full opacity-0 blur-2xl bg-gradient-to-br transition-opacity",
                    accent,
                    !disabled && "group-hover/fc:opacity-20",
                )}
            />
            <div className="relative flex items-start gap-2.5">
                <div
                    className={cn(
                        "size-8 rounded-lg grid place-items-center bg-gradient-to-br text-white shrink-0",
                        accent,
                    )}
                >
                    {icon}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-semibold text-zinc-100 truncate">
                            {title}
                        </span>
                        {shortcut && (
                            <kbd className="text-[9px] font-mono bg-white/10 rounded px-1 py-0.5 text-zinc-400">
                                {shortcut}
                            </kbd>
                        )}
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">{desc}</div>
                </div>
                {applied && (
                    <div className="size-4 rounded-full bg-emerald-500/20 grid place-items-center shrink-0">
                        <Check className="size-2.5 text-emerald-400" />
                    </div>
                )}
            </div>
            {extra && <div className="relative">{extra}</div>}
        </button>
    );
}

function FramesStrip({
    frames,
    speakerColors,
}: {
    frames: FramePreview[];
    speakerColors: Record<string, string>;
}) {
    return (
        <div className="border-t border-white/10 p-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2 flex items-center gap-1.5">
                <ListMusic className="size-3" />
                Timeline · {frames.length} frames
            </div>
            <div className="flex gap-1 overflow-x-auto pb-1">
                {frames.slice(0, 60).map((f) => {
                    const color = f.segment
                        ? (speakerColors[f.segment.focus] ?? "#666")
                        : "#444";
                    return (
                        <div key={f.index} className="shrink-0 relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={`data:image/png;base64,${f.imageB64}`}
                                alt=""
                                className="h-10 w-auto rounded border"
                                style={{ borderColor: color + "60" }}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
    const items: [string, string][] = [
        ["?", "Toggle this help"],
        ["Space", "Play / pause"],
        ["← / →", "Previous / next clip"],
        ["R", "Render selected clip"],
        ["S", "Apply smart subtitles"],
        ["H", "Apply hook overlay"],
        ["Esc", "Close dialog"],
    ];
    return (
        <div
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm grid place-items-center p-4"
            onClick={onClose}
        >
            <div
                className="w-full max-w-md rounded-2xl bg-[oklch(0.18_0_0)] border border-white/10 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                    <div className="flex items-center gap-2">
                        <Keyboard className="size-4 text-amber-400" />
                        <span className="text-sm font-semibold">Keyboard shortcuts</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="size-6 rounded-md hover:bg-white/10 grid place-items-center text-zinc-400"
                    >
                        <X className="size-4" />
                    </button>
                </div>
                <div className="p-5 grid grid-cols-1 gap-2">
                    {items.map(([key, desc]) => (
                        <div
                            key={key}
                            className="flex items-center justify-between py-1.5 text-sm"
                        >
                            <span className="text-zinc-300">{desc}</span>
                            <kbd className="font-mono text-xs bg-white/10 border border-white/10 rounded-md px-2 py-0.5 text-zinc-200">
                                {key}
                            </kbd>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function ThumbsDialog({
    thumbs,
    onClose,
}: {
    thumbs: Thumbnail[];
    onClose: () => void;
}) {
    const [picked, setPicked] = useState<number | null>(null);
    return (
        <div
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm grid place-items-center p-6"
            onClick={onClose}
        >
            <div
                className="w-full max-w-4xl rounded-2xl bg-[oklch(0.18_0_0)] border border-white/10 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                    <div className="flex items-center gap-2">
                        <ImageIcon className="size-4 text-teal-400" />
                        <span className="text-sm font-semibold">
                            Pick a thumbnail
                        </span>
                        <span className="text-xs text-zinc-500">
                            scored by Gemma
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        className="size-6 rounded-md hover:bg-white/10 grid place-items-center text-zinc-400"
                    >
                        <X className="size-4" />
                    </button>
                </div>
                <div className="p-5 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                    {thumbs.map((t, i) => (
                        <button
                            key={i}
                            onClick={() => setPicked(i)}
                            className={cn(
                                "group/t relative rounded-xl overflow-hidden border transition",
                                picked === i
                                    ? "border-amber-400 shadow-[0_0_0_2px_rgba(251,191,36,0.35)]"
                                    : "border-white/10 hover:border-white/30",
                            )}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={`data:image/png;base64,${t.imageB64}`}
                                alt={`t=${t.timestamp}s`}
                                className="w-full h-auto bg-black"
                            />
                            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent px-2 py-1.5 flex items-center justify-between">
                                <span className="text-[10px] font-mono text-zinc-300">
                                    {t.timestamp.toFixed(1)}s
                                </span>
                                <Badge
                                    variant="outline"
                                    className="text-[9px] h-4 bg-black/40 border-white/20"
                                >
                                    {t.score}
                                </Badge>
                            </div>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
