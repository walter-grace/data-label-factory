"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import {
    applyPixelEffects,
    drawGrain,
    drawSticker,
    drawVignette,
    hasPixelWork,
    type CanvasEffects,
} from "../lib/effects";
import {
    drawCaptions,
    getActiveCaptions,
    type CaptionStyle,
    type TranscriptSegment,
} from "../lib/captions";

export type VideoCanvasHandle = {
    video: HTMLVideoElement | null;
};

type Props = {
    src: string | null | undefined;
    effects: CanvasEffects;
    captionStyle?: CaptionStyle;
    transcript?: TranscriptSegment[];
    className?: string;
    style?: React.CSSProperties;
    autoPlay?: boolean;
    onPlay?: () => void;
    onPause?: () => void;
    onTimeUpdate?: (t: number) => void;
    onLoadedMetadata?: (d: {
        width: number;
        height: number;
        duration: number;
    }) => void;
    onFrameRate?: (fps: number) => void;
    /** Called when the user drags the caption. x/y are in [0,1] of the
     *  canvas display area. Only fires while captions are enabled. */
    onCaptionDrag?: (x: number, y: number) => void;
};

/**
 * VideoCanvas renders a native <video> element with visible controls, and
 * overlays a <canvas> that re-paints every frame with pixel + overlay
 * effects applied. The canvas is `pointer-events-none` so the user can
 * still scrub/play/pause the underlying video.
 *
 * Architecture:
 *   - Single RAF loop, started on `play`, ticks until `pause`/`ended`.
 *   - Effects are read through a ref so mid-loop updates don't re-subscribe.
 *   - On `seeked`/effect-change, the canvas repaints once even when paused.
 *   - Canvas pixel size matches `videoWidth`/`videoHeight`; CSS scales it.
 */
export const VideoCanvas = forwardRef<VideoCanvasHandle, Props>(
    function VideoCanvas(
        {
            src,
            effects,
            captionStyle,
            transcript,
            className,
            style,
            autoPlay,
            onPlay,
            onPause,
            onTimeUpdate,
            onLoadedMetadata,
            onFrameRate,
            onCaptionDrag,
        },
        ref,
    ) {
        const videoRef = useRef<HTMLVideoElement>(null);
        const canvasRef = useRef<HTMLCanvasElement>(null);
        const rafRef = useRef<number | null>(null);
        const effectsRef = useRef<CanvasEffects>(effects);
        const captionStyleRef = useRef<CaptionStyle | undefined>(captionStyle);
        const transcriptRef = useRef<TranscriptSegment[] | undefined>(transcript);
        const lastFrameTimesRef = useRef<number[]>([]);
        const fpsReportTimerRef = useRef<number | null>(null);
        const onCaptionDragRef = useRef(onCaptionDrag);
        const dragRef = useRef<{
            startX: number;
            startY: number;
            dragging: boolean;
            active: boolean;
        }>({ startX: 0, startY: 0, dragging: false, active: false });
        const [cursorMode, setCursorMode] = useState<
            "pointer" | "grab" | "grabbing"
        >("pointer");

        useEffect(() => {
            onCaptionDragRef.current = onCaptionDrag;
        }, [onCaptionDrag]);

        useImperativeHandle(
            ref,
            () => ({
                get video() {
                    return videoRef.current;
                },
            }),
            [],
        );

        // Keep latest effects in a ref so the RAF loop reads them without
        // re-subscribing (avoids jank from re-creating the loop on every tick).
        useEffect(() => {
            effectsRef.current = effects;
            // Paint once immediately so paused previews reflect the change.
            paintOnce();
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [effects]);

        useEffect(() => {
            captionStyleRef.current = captionStyle;
            paintOnce();
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [captionStyle]);

        useEffect(() => {
            transcriptRef.current = transcript;
            paintOnce();
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [transcript]);

        const paintOnce = () => {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (!video || !canvas) return;
            if (!video.videoWidth || !video.videoHeight) return;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            if (
                canvas.width !== video.videoWidth ||
                canvas.height !== video.videoHeight
            ) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
            }
            drawFrame(
                ctx,
                video,
                canvas,
                effectsRef.current,
                captionStyleRef.current,
                transcriptRef.current,
            );
        };

        useEffect(() => {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (!video || !canvas) return;

            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;

            const tick = () => {
                const now = performance.now();
                const times = lastFrameTimesRef.current;
                times.push(now);
                if (times.length > 60) times.shift();

                if (
                    canvas.width !== video.videoWidth ||
                    canvas.height !== video.videoHeight
                ) {
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                }

                drawFrame(
                    ctx,
                    video,
                    canvas,
                    effectsRef.current,
                    captionStyleRef.current,
                    transcriptRef.current,
                );
                onTimeUpdate?.(video.currentTime);

                if (video.paused || video.ended) {
                    rafRef.current = null;
                    return;
                }
                rafRef.current = requestAnimationFrame(tick);
            };

            const handlePlay = () => {
                onPlay?.();
                if (rafRef.current == null) {
                    rafRef.current = requestAnimationFrame(tick);
                }
            };
            const handlePause = () => {
                onPause?.();
                // One more paint so the last frame reflects current effects.
                paintOnce();
            };
            const handleSeeked = () => {
                paintOnce();
            };
            const handleLoadedMetadata = () => {
                onLoadedMetadata?.({
                    width: video.videoWidth,
                    height: video.videoHeight,
                    duration: video.duration,
                });
                paintOnce();
            };
            const handleLoadedData = () => {
                paintOnce();
            };

            video.addEventListener("play", handlePlay);
            video.addEventListener("pause", handlePause);
            video.addEventListener("seeked", handleSeeked);
            video.addEventListener("loadedmetadata", handleLoadedMetadata);
            video.addEventListener("loadeddata", handleLoadedData);

            // FPS reporting: once per second, compute average delta.
            if (onFrameRate) {
                fpsReportTimerRef.current = window.setInterval(() => {
                    const t = lastFrameTimesRef.current;
                    if (t.length < 2) return;
                    const first = t[0];
                    const last = t[t.length - 1];
                    const span = last - first;
                    if (span <= 0) return;
                    const fps = ((t.length - 1) / span) * 1000;
                    onFrameRate(fps);
                }, 1000);
            }

            return () => {
                video.removeEventListener("play", handlePlay);
                video.removeEventListener("pause", handlePause);
                video.removeEventListener("seeked", handleSeeked);
                video.removeEventListener("loadedmetadata", handleLoadedMetadata);
                video.removeEventListener("loadeddata", handleLoadedData);
                if (rafRef.current != null) {
                    cancelAnimationFrame(rafRef.current);
                    rafRef.current = null;
                }
                if (fpsReportTimerRef.current != null) {
                    window.clearInterval(fpsReportTimerRef.current);
                    fpsReportTimerRef.current = null;
                }
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [src]);

        return (
            <div
                className={`relative flex flex-col bg-black ${className ?? ""}`}
                style={style}
            >
                {/* Video frame: canvas is the sole visible surface. The <video>
                    element is kept in the tree (drives playback + audio) but
                    invisible. Click-to-play on the canvas. */}
                <div className="relative flex-1 min-h-0 w-full">
                    <video
                        ref={videoRef}
                        src={src ?? undefined}
                        playsInline
                        autoPlay={autoPlay}
                        className="absolute inset-0 w-full h-full object-contain opacity-0 pointer-events-none"
                    />
                    <canvas
                        ref={canvasRef}
                        className="absolute inset-0 w-full h-full object-contain"
                        style={{
                            imageRendering: "auto",
                            cursor:
                                cursorMode === "grabbing"
                                    ? "grabbing"
                                    : cursorMode === "grab"
                                        ? "grab"
                                        : "pointer",
                        }}
                        onMouseDown={(e) => {
                            const captionsOn =
                                captionStyleRef.current?.enabled === true;
                            dragRef.current = {
                                startX: e.clientX,
                                startY: e.clientY,
                                dragging: false,
                                active: true,
                            };
                            if (captionsOn) setCursorMode("grab");
                        }}
                        onMouseMove={(e) => {
                            const state = dragRef.current;
                            const captionsOn =
                                captionStyleRef.current?.enabled === true;
                            if (!state.active) {
                                setCursorMode(captionsOn ? "grab" : "pointer");
                                return;
                            }
                            if (!captionsOn) return;
                            const dx = e.clientX - state.startX;
                            const dy = e.clientY - state.startY;
                            if (!state.dragging && Math.sqrt(dx * dx + dy * dy) > 5) {
                                state.dragging = true;
                                setCursorMode("grabbing");
                            }
                            if (state.dragging && onCaptionDragRef.current) {
                                const canvas = canvasRef.current;
                                if (!canvas) return;
                                const rect = canvas.getBoundingClientRect();
                                const x = Math.max(
                                    0.02,
                                    Math.min(
                                        0.98,
                                        (e.clientX - rect.left) / rect.width,
                                    ),
                                );
                                const y = Math.max(
                                    0.02,
                                    Math.min(
                                        0.98,
                                        (e.clientY - rect.top) / rect.height,
                                    ),
                                );
                                onCaptionDragRef.current(x, y);
                            }
                        }}
                        onMouseUp={() => {
                            const state = dragRef.current;
                            const wasDragging = state.dragging;
                            state.active = false;
                            state.dragging = false;
                            const captionsOn =
                                captionStyleRef.current?.enabled === true;
                            setCursorMode(captionsOn ? "grab" : "pointer");
                            if (!wasDragging) {
                                // Treat as a click → play/pause.
                                const v = videoRef.current;
                                if (!v) return;
                                if (v.paused) v.play().catch(() => {});
                                else v.pause();
                            }
                        }}
                        onMouseLeave={() => {
                            const state = dragRef.current;
                            state.active = false;
                            state.dragging = false;
                            setCursorMode("pointer");
                        }}
                    />
                </div>
                {/* Custom control bar */}
                <VideoControls videoRef={videoRef} />
            </div>
        );
    },
);

function drawFrame(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    effects: CanvasEffects,
    captionStyle?: CaptionStyle,
    transcript?: TranscriptSegment[],
) {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;

    ctx.drawImage(video, 0, 0, w, h);

    if (hasPixelWork(effects)) {
        const img = ctx.getImageData(0, 0, w, h);
        applyPixelEffects(img.data, effects);
        ctx.putImageData(img, 0, 0);
    }

    if (effects.vignette) drawVignette(ctx, w, h);
    if (effects.grain) drawGrain(ctx, w, h);

    // Captions paint AFTER color/overlay work so they always stay legible,
    // but BEFORE stickers so a well-placed emoji can still sit on top.
    if (captionStyle?.enabled && transcript && transcript.length > 0) {
        const active = getActiveCaptions(transcript, video.currentTime, captionStyle);
        if (active) {
            drawCaptions(ctx, w, h, active, video.currentTime, captionStyle);
        }
    }

    if (effects.stickers.length) {
        const t = video.currentTime;
        for (const s of effects.stickers) {
            if (t >= s.t && t < s.t + s.duration) {
                drawSticker(ctx, s, w, h, t - s.t);
            }
        }
    }
}

function VideoControls({
    videoRef,
}: {
    videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [muted, setMuted] = useState(false);

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        const onPlay = () => setPlaying(true);
        const onPause = () => setPlaying(false);
        const onTime = () => setCurrentTime(v.currentTime);
        const onMeta = () => setDuration(v.duration || 0);
        const onVol = () => setMuted(v.muted);
        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        v.addEventListener("timeupdate", onTime);
        v.addEventListener("loadedmetadata", onMeta);
        v.addEventListener("volumechange", onVol);
        return () => {
            v.removeEventListener("play", onPlay);
            v.removeEventListener("pause", onPause);
            v.removeEventListener("timeupdate", onTime);
            v.removeEventListener("loadedmetadata", onMeta);
            v.removeEventListener("volumechange", onVol);
        };
    }, [videoRef]);

    const fmt = (t: number) => {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${String(s).padStart(2, "0")}`;
    };

    return (
        <div className="flex items-center gap-2 px-3 py-2 bg-black/90 border-t border-white/10">
            <button
                onClick={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    if (v.paused) v.play().catch(() => {});
                    else v.pause();
                }}
                className="size-7 rounded-full bg-white/10 hover:bg-white/20 grid place-items-center text-white transition shrink-0"
                aria-label={playing ? "Pause" : "Play"}
            >
                {playing ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="5" width="4" height="14" />
                        <rect x="14" y="5" width="4" height="14" />
                    </svg>
                ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                    </svg>
                )}
            </button>
            <div className="text-[10px] font-mono text-white/70 tabular-nums min-w-[60px]">
                {fmt(currentTime)} / {fmt(duration)}
            </div>
            <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={currentTime}
                onChange={(e) => {
                    const v = videoRef.current;
                    if (v) v.currentTime = Number(e.target.value);
                }}
                className="flex-1 accent-amber-400 h-1"
            />
            <button
                onClick={() => {
                    const v = videoRef.current;
                    if (v) v.muted = !v.muted;
                }}
                className="size-7 rounded-full hover:bg-white/10 grid place-items-center text-white/70 hover:text-white transition shrink-0"
                aria-label={muted ? "Unmute" : "Mute"}
            >
                {muted ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 5 6 9H2v6h4l5 4V5z" />
                        <line x1="23" y1="9" x2="17" y2="15" />
                        <line x1="17" y1="9" x2="23" y2="15" />
                    </svg>
                ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 5 6 9H2v6h4l5 4V5z" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                )}
            </button>
        </div>
    );
}
