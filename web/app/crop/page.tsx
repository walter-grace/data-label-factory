"use client";

import { useState, useRef, useEffect } from "react";

type Speaker = {
    id: number;
    label: string;
    color: string;
    frames_seen: number;
    median_center: [number, number];
    avg_area: number;
};

type CropSegment = {
    t_start: number;
    t_end: number;
    crop_x: number;
    crop_y: number;
    focus: string;
    confidence: number;
};

type FramePreview = {
    index: number;
    timestamp: number;
    imageB64: string;
    segment: CropSegment | null;
};

export default function CropPage() {
    const [url, setUrl] = useState("");
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState("");
    const [speakers, setSpeakers] = useState<Speaker[]>([]);
    const [segments, setSegments] = useState<CropSegment[]>([]);
    const [frames, setFrames] = useState<FramePreview[]>([]);
    const [ffmpegCmd, setFfmpegCmd] = useState("");
    const [selectedFrame, setSelectedFrame] = useState<FramePreview | null>(null);
    const [plan, setPlan] = useState<any>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [viralClips, setViralClips] = useState<any[]>([]);
    const [highlights, setHighlights] = useState<any[]>([]);
    const [generatingClips, setGeneratingClips] = useState(false);
    const [videoPath, setVideoPath] = useState("");
    const [renderingClip, setRenderingClip] = useState<number | null>(null);
    const [clipVideos, setClipVideos] = useState<Record<number, string>>({});
    const [orientation, setOrientation] = useState<"vertical" | "horizontal">("vertical");
    const [subtitlingClip, setSubtitlingClip] = useState<number | null>(null);
    const [processingClip, setProcessingClip] = useState<{ rank: number; feature: string } | null>(null);
    const [clipThumbnails, setClipThumbnails] = useState<Record<number, any[]>>({});
    const [elapsed, setElapsed] = useState(0);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Generic processor: call an SSE endpoint that produces a new mp4, then swap the clip's video
    const processClip = async (
        clip: any,
        feature: string,
        endpoint: string,
        body: Record<string, unknown>,
        outputKey: string = "output_file",
    ) => {
        setProcessingClip({ rank: clip.rank, feature });
        setLogs((p) => [...p, `${feature} on clip #${clip.rank}...`]);
        try {
            const resp = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const reader = resp.body?.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            let outFile = "";
            while (reader) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const blocks = buf.split("\n\n");
                buf = blocks.pop() ?? "";
                for (const block of blocks) {
                    const em = block.match(/^event: (\S+)/);
                    const dm = block.match(/^data: (.+)$/m);
                    if (!em || !dm) continue;
                    const ev = em[1], d = JSON.parse(dm[1]);
                    if (ev === "status") setLogs((p) => [...p, d.message]);
                    if (ev === "complete") outFile = d[outputKey];
                    if (ev === "error") setLogs((p) => [...p, `ERROR: ${d.error}`]);
                }
            }
            if (outFile) {
                const videoResp = await fetch(`/api/serve-clip?path=${encodeURIComponent(outFile)}`);
                if (videoResp.ok) {
                    const blob = await videoResp.blob();
                    const videoUrl = URL.createObjectURL(blob);
                    setClipVideos((prev) => ({ ...prev, [clip.rank]: videoUrl }));
                    setLogs((p) => [...p, `${feature} done for clip #${clip.rank}`]);
                } else {
                    setLogs((p) => [...p, `Failed to fetch processed video`]);
                }
            }
        } catch (e) {
            setLogs((p) => [...p, `${feature} error: ${String(e)}`]);
        } finally {
            setProcessingClip(null);
        }
    };

    // Timer: start when loading, stop when done
    useEffect(() => {
        if (loading) {
            setElapsed(0);
            timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
        } else {
            if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        }
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [loading]);

    const analyze = async () => {
        setLoading(true);
        setStatus("Starting...");
        setSpeakers([]);
        setSegments([]);
        setFrames([]);
        setFfmpegCmd("");
        setPlan(null);
        setLogs([]);
        setSelectedFrame(null);

        try {
            const resp = await fetch("/api/smart-crop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, sample_fps: 0.5, segment_duration: 3 }),
            });

            const reader = resp.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (reader) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n\n");
                buffer = lines.pop() ?? "";

                for (const block of lines) {
                    const eventMatch = block.match(/^event: (\S+)/);
                    const dataMatch = block.match(/^data: (.+)$/m);
                    if (!eventMatch || !dataMatch) continue;

                    const event = eventMatch[1];
                    const data = JSON.parse(dataMatch[1]);

                    switch (event) {
                        case "status":
                            setStatus(data.message);
                            setLogs((p) => [...p, data.message]);
                            break;
                        case "plan":
                            setPlan(data);
                            setSpeakers(data.speakers ?? []);
                            setSegments(data.segments ?? []);
                            setLogs((p) => [...p,
                                `Found ${data.speakers?.length ?? 0} speakers`,
                                `${data.segments?.length ?? 0} crop segments`,
                                `Analysis: ${data.analysis_time_seconds}s`,
                            ]);
                            break;
                        case "frame":
                            setFrames((p) => [...p, data]);
                            break;
                        case "complete":
                            setFfmpegCmd(data.ffmpeg_command ?? "");
                            setVideoPath(data.video_path ?? "");
                            setStatus("Done!");
                            setLogs((p) => [...p, "Analysis complete"]);
                            break;
                        case "error":
                            setStatus(`Error: ${data.error}`);
                            setLogs((p) => [...p, `ERROR: ${data.error}`]);
                            break;
                    }
                }
            }
        } catch (e) {
            setStatus(`Error: ${String(e)}`);
        } finally {
            setLoading(false);
        }
    };

    const SPEAKER_COLORS: Record<string, string> = {};
    speakers.forEach((s) => { SPEAKER_COLORS[s.label] = s.color; });

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100">
            {/* Header */}
            <div className="border-b border-zinc-800 bg-zinc-900 px-6 py-4">
                <div className="flex items-center gap-4 max-w-7xl mx-auto">
                    <a href="/inspector" className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition">Inspector</a>
                    <a href="/pipeline" className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition">Pipeline</a>
                    <h1 className="text-lg font-bold text-amber-300">Smart Crop</h1>
                    <input
                        type="text"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && analyze()}
                        placeholder="YouTube URL or file path on Mac mini..."
                        className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-4 py-2 text-sm font-mono focus:border-amber-500 focus:outline-none"
                    />
                    <label className="px-4 py-2 rounded-lg text-sm font-bold bg-zinc-700 hover:bg-zinc-600 transition cursor-pointer whitespace-nowrap">
                        Upload
                        <input
                            type="file"
                            accept="video/*"
                            className="hidden"
                            onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                setStatus(`Uploading ${file.name}...`);
                                setLoading(true);
                                try {
                                    const form = new FormData();
                                    form.set("video", file);
                                    const r = await fetch("/api/upload-video", { method: "POST", body: form });
                                    const data = await r.json();
                                    if (data.ok) {
                                        setUrl(data.path);
                                        setStatus("Uploaded! Click Analyze.");
                                        setLoading(false);
                                    } else {
                                        setStatus(`Upload failed: ${data.error}`);
                                        setLoading(false);
                                    }
                                } catch (err) {
                                    setStatus(`Upload error: ${String(err)}`);
                                    setLoading(false);
                                }
                            }}
                            disabled={loading}
                        />
                    </label>
                    <button
                        onClick={analyze}
                        disabled={loading || !url}
                        className="px-5 py-2 rounded-lg text-sm font-bold bg-amber-600 hover:bg-amber-500 disabled:opacity-40 transition"
                    >
                        {loading ? status : "Analyze"}
                    </button>
                    {(loading || elapsed > 0) && (
                        <div className={`text-sm font-mono px-3 py-2 rounded-lg border ${loading ? "border-amber-700 bg-amber-950/30 text-amber-300 animate-pulse" : "border-zinc-700 bg-zinc-900 text-zinc-400"}`}>
                            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
                        </div>
                    )}
                </div>
            </div>

            <div className="max-w-7xl mx-auto p-6">
                {/* Speakers */}
                {speakers.length > 0 && (
                    <div className="mb-6 flex gap-4">
                        {speakers.map((s) => (
                            <div key={s.id} className="border border-zinc-800 rounded-lg bg-zinc-900 px-4 py-3 flex items-center gap-3">
                                <div className="w-4 h-4 rounded-full" style={{ backgroundColor: s.color }} />
                                <div>
                                    <div className="text-sm font-bold" style={{ color: s.color }}>{s.label}</div>
                                    <div className="text-[10px] text-zinc-500">
                                        {s.frames_seen} frames · {(s.avg_area * 100).toFixed(1)}% area
                                    </div>
                                </div>
                            </div>
                        ))}
                        {plan && (
                            <div className="border border-zinc-800 rounded-lg bg-zinc-900 px-4 py-3 ml-auto">
                                <div className="text-[10px] text-zinc-500">Duration</div>
                                <div className="text-sm font-bold text-zinc-200">{plan.duration}s</div>
                            </div>
                        )}
                    </div>
                )}

                {/* Action buttons */}
                {speakers.length > 0 && !loading && (
                    <div className="mb-6 flex flex-wrap gap-3 items-center">
                        {/* Orientation toggle */}
                        <div className="flex rounded-lg overflow-hidden border border-zinc-700">
                            <button
                                onClick={() => { setOrientation("vertical"); setClipVideos({}); setViralClips([]); }}
                                className={`px-3 py-2 text-xs font-bold transition ${orientation === "vertical" ? "bg-amber-600 text-white" : "bg-zinc-900 text-zinc-400 hover:text-white"}`}
                            >
                                9:16
                            </button>
                            <button
                                onClick={() => { setOrientation("horizontal"); setClipVideos({}); setViralClips([]); }}
                                className={`px-3 py-2 text-xs font-bold transition ${orientation === "horizontal" ? "bg-amber-600 text-white" : "bg-zinc-900 text-zinc-400 hover:text-white"}`}
                            >
                                16:9
                            </button>
                        </div>
                        <button
                            onClick={async () => {
                                setGeneratingClips(true);
                                setViralClips([]);
                                setHighlights([]);
                                setClipVideos({});
                                setLogs((p) => [...p, `\nGenerating ${orientation} viral clips...`]);
                                try {
                                    const resp = await fetch("/api/viral-clips", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                            videoPath: videoPath || url,
                                            speakers,
                                            segments,
                                            duration: plan?.duration ?? 0,
                                            sourceWidth: plan?.source_width ?? 1920,
                                            sourceHeight: plan?.source_height ?? 1080,
                                            numClips: 5,
                                            clipLength: 30,
                                            speakerHighlights: true,
                                            orientation,
                                        }),
                                    });
                                    const reader = resp.body?.getReader();
                                    const decoder = new TextDecoder();
                                    let buf = "";
                                    while (reader) {
                                        const { done, value } = await reader.read();
                                        if (done) break;
                                        buf += decoder.decode(value, { stream: true });
                                        const blocks = buf.split("\n\n");
                                        buf = blocks.pop() ?? "";
                                        for (const block of blocks) {
                                            const em = block.match(/^event: (\S+)/);
                                            const dm = block.match(/^data: (.+)$/m);
                                            if (!em || !dm) continue;
                                            const ev = em[1], d = JSON.parse(dm[1]);
                                            if (ev === "status") setLogs((p) => [...p, d.message]);
                                            if (ev === "clips") setViralClips(d.clips ?? []);
                                            if (ev === "highlights") setHighlights(d.highlights ?? []);
                                            if (ev === "transcript") setLogs((p) => [...p, `Transcript: ${d.segments} segments`]);
                                            if (ev === "complete") setLogs((p) => [...p, `Generated ${d.total_clips} clips`]);
                                            if (ev === "error") setLogs((p) => [...p, `ERROR: ${d.error}`]);
                                        }
                                    }
                                } catch (e) {
                                    setLogs((p) => [...p, `Error: ${String(e)}`]);
                                } finally {
                                    setGeneratingClips(false);
                                }
                            }}
                            disabled={generatingClips}
                            className="px-5 py-2 rounded-lg text-sm font-bold bg-rose-600 hover:bg-rose-500 disabled:opacity-40 transition"
                        >
                            {generatingClips ? `Generating... ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}` : "🔥 Generate Viral Clips"}
                        </button>
                        {speakers.map((s) => (
                            <button
                                key={s.id}
                                onClick={async () => {
                                    setGeneratingClips(true);
                                    setViralClips([]);
                                    setHighlights([]);
                                    setClipVideos({});
                                    setLogs((p) => [...p, `\nGenerating ${s.label} ${orientation} reel...`]);
                                    try {
                                        const resp = await fetch("/api/viral-clips", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({
                                                videoPath: videoPath || url,
                                                speakers,
                                                segments,
                                                duration: plan?.duration ?? 0,
                                                sourceWidth: plan?.source_width ?? 1920,
                                                sourceHeight: plan?.source_height ?? 1080,
                                                numClips: 5,
                                                clipLength: 30,
                                                speakerHighlights: false,
                                                orientation,
                                                speakerFilter: s.label,
                                            }),
                                        });
                                        const reader = resp.body?.getReader();
                                        const decoder = new TextDecoder();
                                        let buf = "";
                                        while (reader) {
                                            const { done, value } = await reader.read();
                                            if (done) break;
                                            buf += decoder.decode(value, { stream: true });
                                            const blocks = buf.split("\n\n");
                                            buf = blocks.pop() ?? "";
                                            for (const block of blocks) {
                                                const em = block.match(/^event: (\S+)/);
                                                const dm = block.match(/^data: (.+)$/m);
                                                if (!em || !dm) continue;
                                                const ev = em[1], d = JSON.parse(dm[1]);
                                                if (ev === "status") setLogs((p) => [...p, d.message]);
                                                if (ev === "clips") setViralClips(d.clips ?? []);
                                                if (ev === "complete") setLogs((p) => [...p, `Generated ${d.total_clips} ${s.label} clips`]);
                                                if (ev === "error") setLogs((p) => [...p, `ERROR: ${d.error}`]);
                                            }
                                        }
                                    } catch (e) {
                                        setLogs((p) => [...p, `Error: ${String(e)}`]);
                                    } finally {
                                        setGeneratingClips(false);
                                    }
                                }}
                                disabled={generatingClips}
                                className="px-4 py-2 rounded-lg text-sm font-bold border transition hover:opacity-80 disabled:opacity-40"
                                style={{ borderColor: s.color, color: s.color }}
                                title={`Generate ${s.label} highlight reel`}
                            >
                                {s.label} Reel
                            </button>
                        ))}
                    </div>
                )}

                {/* Viral clips results */}
                {viralClips.length > 0 && (
                    <div className="mb-6 border border-rose-800/50 rounded-lg bg-zinc-900 p-4">
                        <div className="text-xs font-bold uppercase text-rose-300 mb-3">
                            🔥 Viral Clips ({viralClips.length})
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {viralClips.map((clip, i) => (
                                <div key={i} className="border border-zinc-800 rounded-lg bg-zinc-950 p-3">
                                    <div className="flex items-baseline justify-between mb-1">
                                        <span className="text-rose-300 font-bold text-sm">#{clip.rank} {clip.title}</span>
                                        <span className="text-zinc-500 text-[10px] font-mono">
                                            {Math.floor(clip.t_start / 60)}:{String(Math.floor(clip.t_start % 60)).padStart(2, "0")} →{" "}
                                            {Math.floor(clip.t_end / 60)}:{String(Math.floor(clip.t_end % 60)).padStart(2, "0")}
                                        </span>
                                    </div>
                                    {clip.quote && (
                                        <div className="text-xs text-zinc-300 italic mb-2">&ldquo;{clip.quote}&rdquo;</div>
                                    )}
                                    {clip.why && (
                                        <div className="text-[10px] text-zinc-500 mb-2">{clip.why}</div>
                                    )}
                                    {clipVideos[clip.rank] ? (
                                        <div>
                                            <video
                                                src={clipVideos[clip.rank]}
                                                controls
                                                autoPlay
                                                className="w-full rounded mt-2 max-h-[400px] bg-black"
                                            />
                                            {/* Feature buttons */}
                                            <div className="mt-2 grid grid-cols-2 gap-1.5">
                                                <button
                                                    onClick={() => processClip(clip, "Smart CC", "/api/add-subtitles", {
                                                        output_file: clip.output_file,
                                                        style: "smart",
                                                    }, "subbed_file")}
                                                    disabled={processingClip !== null}
                                                    className="px-2 py-1.5 rounded text-[10px] font-bold bg-blue-700/30 hover:bg-blue-700/50 border border-blue-800 text-blue-200 transition disabled:opacity-40"
                                                >
                                                    {processingClip?.rank === clip.rank && processingClip?.feature === "Smart CC" ? "..." : "CC Smart Subs"}
                                                </button>
                                                <button
                                                    onClick={() => processClip(clip, "Remove Fillers", "/api/remove-fillers", {
                                                        output_file: clip.output_file,
                                                    })}
                                                    disabled={processingClip !== null}
                                                    className="px-2 py-1.5 rounded text-[10px] font-bold bg-purple-700/30 hover:bg-purple-700/50 border border-purple-800 text-purple-200 transition disabled:opacity-40"
                                                >
                                                    {processingClip?.rank === clip.rank && processingClip?.feature === "Remove Fillers" ? "..." : "✂ Remove Ums"}
                                                </button>
                                                <button
                                                    onClick={() => processClip(clip, "Hook Text", "/api/add-hook", {
                                                        output_file: clip.output_file,
                                                        orientation,
                                                        duration: 4,
                                                    })}
                                                    disabled={processingClip !== null}
                                                    className="px-2 py-1.5 rounded text-[10px] font-bold bg-orange-700/30 hover:bg-orange-700/50 border border-orange-800 text-orange-200 transition disabled:opacity-40"
                                                >
                                                    {processingClip?.rank === clip.rank && processingClip?.feature === "Hook Text" ? "..." : "⚡ Add Hook"}
                                                </button>
                                                <button
                                                    onClick={async () => {
                                                        setProcessingClip({ rank: clip.rank, feature: "Thumbnails" });
                                                        setLogs((p) => [...p, `Picking thumbnails for clip #${clip.rank}...`]);
                                                        try {
                                                            const resp = await fetch("/api/pick-thumbnails", {
                                                                method: "POST",
                                                                headers: { "Content-Type": "application/json" },
                                                                body: JSON.stringify({ output_file: clip.output_file, count: 5 }),
                                                            });
                                                            const data = await resp.json();
                                                            if (data.ok && data.thumbnails) {
                                                                setClipThumbnails((prev) => ({ ...prev, [clip.rank]: data.thumbnails }));
                                                                setLogs((p) => [...p, `Got ${data.thumbnails.length} thumbnails`]);
                                                            } else {
                                                                setLogs((p) => [...p, `Thumbnail error: ${data.error}`]);
                                                            }
                                                        } catch (e) {
                                                            setLogs((p) => [...p, `Thumbnail error: ${String(e)}`]);
                                                        } finally {
                                                            setProcessingClip(null);
                                                        }
                                                    }}
                                                    disabled={processingClip !== null}
                                                    className="px-2 py-1.5 rounded text-[10px] font-bold bg-teal-700/30 hover:bg-teal-700/50 border border-teal-800 text-teal-200 transition disabled:opacity-40"
                                                >
                                                    {processingClip?.rank === clip.rank && processingClip?.feature === "Thumbnails" ? "..." : "🖼 Thumbnails"}
                                                </button>
                                                <button
                                                    onClick={() => processClip(clip, "Active Crop", "/api/active-crop", {
                                                        videoPath: videoPath || url,
                                                        t_start: clip.t_start,
                                                        t_end: clip.t_end,
                                                        orientation,
                                                        outputFile: clip.output_file.replace(".mp4", "_active.mp4"),
                                                    })}
                                                    disabled={processingClip !== null}
                                                    className="col-span-2 px-2 py-1.5 rounded text-[10px] font-bold bg-pink-700/30 hover:bg-pink-700/50 border border-pink-800 text-pink-200 transition disabled:opacity-40"
                                                >
                                                    {processingClip?.rank === clip.rank && processingClip?.feature === "Active Crop" ? "..." : "🎯 Active-Speaker Crop"}
                                                </button>
                                            </div>
                                            {/* Thumbnail gallery */}
                                            {clipThumbnails[clip.rank] && clipThumbnails[clip.rank].length > 0 && (
                                                <div className="mt-2 grid grid-cols-5 gap-1">
                                                    {clipThumbnails[clip.rank].map((thumb, ti) => (
                                                        <div key={ti} className="relative">
                                                            <img
                                                                src={`data:image/png;base64,${thumb.imageB64}`}
                                                                alt={`t=${thumb.timestamp}s`}
                                                                className="w-full rounded border border-zinc-700"
                                                            />
                                                            <div className="absolute top-0 right-0 bg-black/70 text-[8px] text-white px-1 rounded-bl">
                                                                {thumb.score}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <button
                                            onClick={async () => {
                                                setRenderingClip(clip.rank);
                                                setLogs((p) => [...p, `Rendering clip #${clip.rank}...`]);
                                                try {
                                                    const resp = await fetch("/api/render-clip", {
                                                        method: "POST",
                                                        headers: { "Content-Type": "application/json" },
                                                        body: JSON.stringify({
                                                            ffmpeg_command: clip.ffmpeg_command,
                                                            output_file: clip.output_file,
                                                        }),
                                                    });
                                                    if (!resp.ok) {
                                                        const err = await resp.json();
                                                        setLogs((p) => [...p, `Render failed: ${err.error}`]);
                                                        return;
                                                    }
                                                    const blob = await resp.blob();
                                                    const url = URL.createObjectURL(blob);
                                                    setClipVideos((prev) => ({ ...prev, [clip.rank]: url }));
                                                    setLogs((p) => [...p, `Clip #${clip.rank} rendered!`]);
                                                } catch (e) {
                                                    setLogs((p) => [...p, `Render error: ${String(e)}`]);
                                                } finally {
                                                    setRenderingClip(null);
                                                }
                                            }}
                                            disabled={renderingClip !== null}
                                            className="mt-2 w-full px-2 py-1.5 rounded text-xs font-bold bg-emerald-700/30 hover:bg-emerald-700/50 border border-emerald-800 text-emerald-200 transition disabled:opacity-40"
                                        >
                                            {renderingClip === clip.rank ? "Rendering..." : "▶ Render & Play"}
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Speaker highlight reels */}
                {highlights.length > 0 && (
                    <div className="mb-6 border border-zinc-800 rounded-lg bg-zinc-900 p-4">
                        <div className="text-xs font-bold uppercase text-zinc-400 mb-3">
                            Speaker Highlight Reels
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            {highlights.map((h, i) => (
                                <div key={i} className="border rounded-lg p-3" style={{ borderColor: h.color + "60" }}>
                                    <div className="font-bold text-sm" style={{ color: h.color }}>{h.speaker}</div>
                                    <div className="text-xs text-zinc-400 mt-1">
                                        {h.total_segments} segments · {Math.floor(h.total_time / 60)}:{String(h.total_time % 60).padStart(2, "0")} total
                                    </div>
                                    <div className="text-[10px] text-zinc-500 mt-1">
                                        {h.clips?.length ?? 0} clips ready
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className="flex gap-6">
                    {/* Left: Frame timeline */}
                    <div className="flex-1">
                        {frames.length === 0 && !loading && (
                            <div className="text-center text-zinc-600 py-20">
                                <div className="text-3xl mb-3">🎬</div>
                                <div>Paste a YouTube URL and click Analyze</div>
                                <div className="text-xs text-zinc-700 mt-1">
                                    YOLO detects speakers, tracks them, and generates a smart 9:16 crop plan
                                </div>
                            </div>
                        )}

                        {/* Frame grid */}
                        <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
                            {frames.map((f) => {
                                const seg = f.segment;
                                const focusColor = seg?.focus ? (SPEAKER_COLORS[seg.focus] ?? "#666") : "#666";
                                return (
                                    <button
                                        key={f.index}
                                        onClick={() => setSelectedFrame(f)}
                                        className={`text-left rounded-lg overflow-hidden border transition-all hover:scale-[1.02] ${
                                            selectedFrame?.index === f.index
                                                ? "border-amber-500 shadow-lg shadow-amber-500/20"
                                                : "border-zinc-800 hover:border-zinc-600"
                                        }`}
                                    >
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                            src={`data:image/png;base64,${f.imageB64}`}
                                            alt={`Frame at ${f.timestamp}s`}
                                            className="w-full h-auto"
                                        />
                                        <div className="bg-zinc-900 px-2 py-1.5 flex items-center gap-2">
                                            <span className="text-[10px] text-zinc-400 font-mono">{f.timestamp.toFixed(1)}s</span>
                                            {seg && (
                                                <>
                                                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: focusColor }} />
                                                    <span className="text-[10px] truncate" style={{ color: focusColor }}>
                                                        {seg.focus}
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Crop timeline visualization */}
                        {segments.length > 0 && plan && (
                            <div className="mt-6 border border-zinc-800 rounded-lg bg-zinc-900 p-4">
                                <div className="text-xs font-bold uppercase text-zinc-400 mb-3">Crop Timeline</div>
                                <div className="flex h-8 rounded overflow-hidden">
                                    {segments.map((seg, i) => {
                                        const widthPct = ((seg.t_end - seg.t_start) / plan.duration) * 100;
                                        const color = SPEAKER_COLORS[seg.focus] ?? "#555";
                                        return (
                                            <div
                                                key={i}
                                                className="flex items-center justify-center text-[9px] font-bold border-r border-zinc-950"
                                                style={{
                                                    width: `${widthPct}%`,
                                                    backgroundColor: color + "40",
                                                    color: color,
                                                    minWidth: "2px",
                                                }}
                                                title={`${seg.t_start.toFixed(1)}s → ${seg.t_end.toFixed(1)}s: ${seg.focus}`}
                                            >
                                                {widthPct > 5 ? seg.focus.replace("Speaker ", "") : ""}
                                            </div>
                                        );
                                    })}
                                </div>
                                <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
                                    <span>0s</span>
                                    <span>{plan.duration}s</span>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Right: Detail + ffmpeg command */}
                    <div className="w-80 flex-shrink-0 space-y-4">
                        {/* Selected frame detail */}
                        {selectedFrame && (
                            <div className="border border-zinc-800 rounded-lg bg-zinc-900 p-4">
                                <div className="text-xs font-bold uppercase text-amber-300 mb-2">
                                    Frame at {selectedFrame.timestamp.toFixed(1)}s
                                </div>
                                {selectedFrame.segment && (
                                    <div className="space-y-1 text-xs">
                                        <div><span className="text-zinc-500">Focus:</span> <span style={{ color: SPEAKER_COLORS[selectedFrame.segment.focus] }}>{selectedFrame.segment.focus}</span></div>
                                        <div><span className="text-zinc-500">Crop X:</span> <span className="text-zinc-300">{selectedFrame.segment.crop_x}px</span></div>
                                        <div><span className="text-zinc-500">Crop Y:</span> <span className="text-zinc-300">{selectedFrame.segment.crop_y}px</span></div>
                                        <div><span className="text-zinc-500">Confidence:</span> <span className="text-zinc-300">{(selectedFrame.segment.confidence * 100).toFixed(0)}%</span></div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ffmpeg command */}
                        {ffmpegCmd && (
                            <div className="border border-zinc-800 rounded-lg bg-zinc-900 p-4">
                                <div className="text-xs font-bold uppercase text-zinc-400 mb-2">
                                    ffmpeg Command
                                </div>
                                <pre className="text-[10px] text-emerald-300 font-mono bg-zinc-950 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                                    {ffmpegCmd}
                                </pre>
                                <button
                                    onClick={() => navigator.clipboard.writeText(ffmpegCmd)}
                                    className="mt-2 w-full px-2 py-1.5 rounded text-xs font-bold bg-emerald-700/30 hover:bg-emerald-700/50 border border-emerald-800 text-emerald-200 transition"
                                >
                                    Copy Command
                                </button>
                            </div>
                        )}

                        {/* Logs */}
                        <div className="border border-zinc-800 rounded-lg bg-zinc-900 p-4">
                            <div className="text-xs font-bold uppercase text-zinc-400 mb-2">Logs</div>
                            <div className="space-y-0.5 max-h-48 overflow-y-auto font-mono text-[10px] text-zinc-500">
                                {logs.map((log, i) => (
                                    <div key={i} className={log.includes("ERROR") ? "text-red-400" : ""}>{log}</div>
                                ))}
                                {loading && <div className="text-amber-400 animate-pulse">{status}</div>}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
