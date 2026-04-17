"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import {
    type AudioTrack,
    type SceneGraph,
    type TextAnimation,
    type TextOverlay,
    type TextStylePreset,
    type TransitionKind,
    clipAtTime,
    clipDuration,
    emptyScene,
    sceneDuration,
    textActiveAt,
} from "./types";
import animStyles from "./animations.module.css";

type LibraryEntry = { label: string; path: string; size?: number };

const FALLBACK_LIBRARY: LibraryEntry[] = [
    { label: "Demo — burned captions", path: "/tmp/viral_clip_2_demo_render_sub.mp4" },
    { label: "Demo — rendered 16:9", path: "/tmp/viral_clip_2_demo_render.mp4" },
    { label: "Viral clip 1", path: "/tmp/viral_clip_1.mp4" },
    { label: "Viral clip 2", path: "/tmp/viral_clip_2.mp4" },
];

const AUDIO_LIBRARY: { label: string; path: string }[] = [
    { label: "Demo audio 1", path: "/tmp/demo_audio_1.mp3" },
    { label: "Demo audio 2", path: "/tmp/demo_audio_2.mp3" },
];

const TEXT_STYLES: Record<TextStylePreset, { className: string; fontSize: string; color: string }> = {
    default: { className: "font-bold", fontSize: "clamp(16px, 4vw, 48px)", color: "#ffffff" },
    title: { className: "font-black uppercase tracking-wider", fontSize: "clamp(24px, 6vw, 72px)", color: "#ffffff" },
    caption: { className: "font-semibold", fontSize: "clamp(14px, 3vw, 32px)", color: "#ffff00" },
    hook: { className: "font-black uppercase", fontSize: "clamp(20px, 5vw, 56px)", color: "#ff3b3b" },
};

const serveUrl = (path: string) => `/api/serve-clip?path=${encodeURIComponent(path)}`;

const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const fmtFine = (s: number) => `${s.toFixed(1)}s`;

const snap = (s: number) => Math.round(s * 10) / 10;

function probeDuration(src: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.src = src;
        v.onloadedmetadata = () => resolve(v.duration || 0);
        v.onerror = () => reject(new Error("probe failed"));
    });
}

const MIN_CLIP_DUR = 0.5;

type ChatMessage = { role: "user" | "assistant"; content: string };
type ChatOp = { kind: string; summary: string };

export default function StudioPage() {
    const [scene, setScene] = useState<SceneGraph>(emptyScene);
    const [library, setLibrary] = useState<LibraryEntry[]>(FALLBACK_LIBRARY);
    const [libraryLoading, setLibraryLoading] = useState(false);

    const refreshLibrary = useCallback(async () => {
        setLibraryLoading(true);
        try {
            const res = await fetch("/api/studio-library", { cache: "no-store" });
            const data = await res.json();
            if (data?.ok && Array.isArray(data.clips) && data.clips.length > 0) {
                setLibrary(data.clips.map((c: LibraryEntry) => ({ label: c.label, path: c.path, size: c.size })));
            }
        } catch {} finally {
            setLibraryLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshLibrary();
    }, [refreshLibrary]);
    const [time, setTime] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [probing, setProbing] = useState<string | null>(null);
    const [dragIdx, setDragIdx] = useState<number | null>(null);
    const [trimmingLabel, setTrimmingLabel] = useState<string | null>(null);

    const [showTextEditor, setShowTextEditor] = useState(false);
    const [textDraft, setTextDraft] = useState({ content: "", start: 0, end: 2, style: "default" as TextStylePreset });
    const [showAudioPicker, setShowAudioPicker] = useState(false);
    const [audioPath, setAudioPath] = useState("");

    const [exporting, setExporting] = useState(false);
    const [exportStartedAt, setExportStartedAt] = useState<number | null>(null);
    const [exportElapsedMs, setExportElapsedMs] = useState(0);
    const [exportPath, setExportPath] = useState<string | null>(null);
    const [exportError, setExportError] = useState<string | null>(null);

    useEffect(() => {
        if (!exporting || exportStartedAt == null) return;
        const id = setInterval(() => setExportElapsedMs(Date.now() - exportStartedAt), 100);
        return () => clearInterval(id);
    }, [exporting, exportStartedAt]);

    const [chatOpen, setChatOpen] = useState(false);
    const [chatMsgs, setChatMsgs] = useState<ChatMessage[]>([]);
    const [chatInput, setChatInput] = useState("");
    const [chatLoading, setChatLoading] = useState(false);
    const [lastOps, setLastOps] = useState<ChatOp[]>([]);

    const [captionsOpen, setCaptionsOpen] = useState(false);
    const [highlightedTextId, setHighlightedTextId] = useState<string | null>(null);
    const [transcribing, setTranscribing] = useState(false);
    const [transcribeStartedAt, setTranscribeStartedAt] = useState<number | null>(null);
    const [transcribeElapsedMs, setTranscribeElapsedMs] = useState(0);
    const [transitionPopoverClipId, setTransitionPopoverClipId] = useState<string | null>(null);

    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [rubberBand, setRubberBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
    const rubberBandActiveRef = useRef(false);

    const [libraryDrag, setLibraryDrag] = useState<{ label: string; path: string } | null>(null);
    const [dropInsertIndex, setDropInsertIndex] = useState<number | null>(null);

    useEffect(() => {
        if (!transcribing || transcribeStartedAt == null) return;
        const id = setInterval(() => setTranscribeElapsedMs(Date.now() - transcribeStartedAt), 100);
        return () => clearInterval(id);
    }, [transcribing, transcribeStartedAt]);

    const videoRef = useRef<HTMLVideoElement>(null);
    const secondaryVideoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const totalDuration = useMemo(() => sceneDuration(scene), [scene]);
    const cursor = useMemo(() => clipAtTime(scene, time), [scene, time]);
    const activeTexts = useMemo(() => textActiveAt(scene, time), [scene, time]);

    // Transition preview: if cursor is near the end of a clip and the *next*
    // clip has a non-cut transitionIn, mix in the next clip.
    const transitionPreview = useMemo(() => {
        if (!cursor) return null;
        const nextIdx = cursor.index + 1;
        if (nextIdx >= scene.clips.length) return null;
        const next = scene.clips[nextIdx];
        const t = next.transitionIn;
        if (!t || t.kind === "cut") return null;
        let offset = 0;
        for (let i = 0; i < nextIdx; i++) offset += clipDuration(scene.clips[i]);
        const boundary = offset;
        const dur = Math.max(0.1, t.duration);
        if (time < boundary - dur) return null;
        if (time > boundary) return null;
        const progress = Math.max(0, Math.min(1, (time - (boundary - dur)) / dur));
        return { kind: t.kind, progress, clip: next };
    }, [cursor, scene.clips, time]);

    useEffect(() => {
        const sv = secondaryVideoRef.current;
        if (!sv) return;
        if (!transitionPreview) {
            sv.pause();
            return;
        }
        const want = transitionPreview.clip.src;
        if (sv.src !== want && !sv.src.endsWith(want)) {
            sv.src = want;
        }
        const local = transitionPreview.clip.in;
        if (Math.abs(sv.currentTime - local) > 0.3) {
            try {
                sv.currentTime = local;
            } catch {}
        }
    }, [transitionPreview]);

    const addClipAt = useCallback(
        async (entry: { label: string; path: string }, insertIndex?: number) => {
            const src = serveUrl(entry.path);
            setProbing(entry.path);
            setPlaying(false);
            try {
                const duration = await probeDuration(src);
                let newOffset = 0;
                setScene((prev) => {
                    const newClip = {
                        id: `${entry.path}-${Date.now()}`,
                        src,
                        label: entry.label,
                        sourceDuration: duration,
                        in: 0,
                        out: duration,
                    };
                    const clips = [...prev.clips];
                    const at = insertIndex == null ? clips.length : Math.max(0, Math.min(clips.length, insertIndex));
                    clips.splice(at, 0, newClip);
                    for (let i = 0; i < at; i++) newOffset += clipDuration(clips[i]);
                    return { ...prev, clips };
                });
                setTime(newOffset);
            } catch {
                alert(`Could not load ${entry.path}`);
            } finally {
                setProbing(null);
            }
        },
        [],
    );

    const addClip = useCallback(
        (entry: { label: string; path: string }) => addClipAt(entry),
        [addClipAt],
    );

    const removeClip = useCallback((id: string) => {
        setScene((prev) => ({ ...prev, clips: prev.clips.filter((c) => c.id !== id) }));
    }, []);

    const moveClip = useCallback((from: number, to: number) => {
        setScene((prev) => {
            if (from === to || from < 0 || to < 0 || from >= prev.clips.length || to >= prev.clips.length) return prev;
            const next = [...prev.clips];
            const [item] = next.splice(from, 1);
            next.splice(to, 0, item);
            return { ...prev, clips: next };
        });
    }, []);

    const beginTrim = useCallback(
        (clipId: string, side: "left" | "right", e: React.PointerEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const trackEl = (e.currentTarget.closest("[data-clip-track]") as HTMLDivElement) ?? null;
            if (!trackEl) return;
            const trackRect = trackEl.getBoundingClientRect();

            const clipAtStart = scene.clips.find((c) => c.id === clipId);
            if (!clipAtStart) return;
            const clipIdx = scene.clips.findIndex((c) => c.id === clipId);
            const otherClipsTotal = scene.clips.reduce((a, c, i) => (i === clipIdx ? a : a + clipDuration(c)), 0);
            const startIn = clipAtStart.in;
            const startOut = clipAtStart.out;
            const src = clipAtStart.src;
            const srcDur = clipAtStart.sourceDuration;

            const pxPerSec = trackRect.width / Math.max(0.01, otherClipsTotal + (startOut - startIn));

            const onMove = (ev: PointerEvent) => {
                const dx = ev.clientX - e.clientX;
                const dSec = dx / pxPerSec;
                setScene((prev) => {
                    const clips = prev.clips.slice();
                    const idx = clips.findIndex((c) => c.id === clipId);
                    if (idx === -1) return prev;
                    const c = clips[idx];
                    let nextIn = c.in;
                    let nextOut = c.out;
                    if (side === "left") {
                        nextIn = snap(Math.max(0, Math.min(startOut - MIN_CLIP_DUR, startIn + dSec)));
                    } else {
                        nextOut = snap(Math.max(startIn + MIN_CLIP_DUR, Math.min(srcDur, startOut + dSec)));
                    }
                    clips[idx] = { ...c, in: nextIn, out: nextOut };
                    return { ...prev, clips };
                });
                setTrimmingLabel(
                    side === "left"
                        ? `in ${fmtFine(Math.max(0, Math.min(startOut - MIN_CLIP_DUR, startIn + dSec)))}`
                        : `out ${fmtFine(Math.max(startIn + MIN_CLIP_DUR, Math.min(srcDur, startOut + dSec)))}`,
                );

                const preview = videoRef.current;
                if (preview) {
                    if (preview.src !== src && !preview.src.endsWith(src)) preview.src = src;
                    const seekTime =
                        side === "left"
                            ? Math.max(0, Math.min(startOut - MIN_CLIP_DUR, startIn + dSec))
                            : Math.max(startIn + MIN_CLIP_DUR, Math.min(srcDur, startOut + dSec));
                    try {
                        preview.currentTime = seekTime;
                    } catch {}
                }
            };

            const onUp = () => {
                setTrimmingLabel(null);
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        },
        [scene.clips],
    );

    const beginTrackItemDrag = useCallback(
        (
            kind: "text" | "audio",
            id: string,
            mode: "move" | "left" | "right",
            e: React.PointerEvent<HTMLDivElement>,
        ) => {
            e.preventDefault();
            e.stopPropagation();
            const trackEl = (e.currentTarget.closest("[data-track]") as HTMLDivElement) ?? null;
            if (!trackEl) return;
            const rect = trackEl.getBoundingClientRect();
            const pxPerSec = rect.width / Math.max(0.01, totalDuration);

            const origItem: TextOverlay | AudioTrack | undefined =
                kind === "text" ? scene.texts.find((t) => t.id === id) : scene.audio.find((a) => a.id === id);
            if (!origItem) return;
            const startS = origItem.start;
            const endS = origItem.end;

            const onMove = (ev: PointerEvent) => {
                const dx = ev.clientX - e.clientX;
                const dSec = dx / pxPerSec;
                setScene((prev) => {
                    if (kind === "text") {
                        const texts = prev.texts.slice();
                        const idx = texts.findIndex((t) => t.id === id);
                        if (idx === -1) return prev;
                        const t = texts[idx];
                        let ns = t.start;
                        let ne = t.end;
                        if (mode === "move") {
                            const dur = endS - startS;
                            ns = snap(Math.max(0, Math.min(totalDuration - dur, startS + dSec)));
                            ne = ns + dur;
                        } else if (mode === "left") {
                            ns = snap(Math.max(0, Math.min(endS - 0.2, startS + dSec)));
                        } else {
                            ne = snap(Math.max(startS + 0.2, Math.min(totalDuration, endS + dSec)));
                        }
                        texts[idx] = { ...t, start: ns, end: ne };
                        return { ...prev, texts };
                    } else {
                        const audio = prev.audio.slice();
                        const idx = audio.findIndex((a) => a.id === id);
                        if (idx === -1) return prev;
                        const a = audio[idx];
                        let ns = a.start;
                        let ne = a.end;
                        if (mode === "move") {
                            const dur = endS - startS;
                            ns = snap(Math.max(0, Math.min(totalDuration - dur, startS + dSec)));
                            ne = ns + dur;
                        } else if (mode === "left") {
                            ns = snap(Math.max(0, Math.min(endS - 0.2, startS + dSec)));
                        } else {
                            ne = snap(Math.max(startS + 0.2, Math.min(totalDuration, endS + dSec)));
                        }
                        audio[idx] = { ...a, start: ns, end: ne };
                        return { ...prev, audio };
                    }
                });
            };
            const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        },
        [scene, totalDuration],
    );

    const timelineRef = useRef<HTMLDivElement>(null);
    const [scrubbing, setScrubbing] = useState(false);

    const beginScrub = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const wrap = timelineRef.current;
            if (!wrap || totalDuration === 0) return;
            const rect = wrap.getBoundingClientRect();
            setPlaying(false);
            setScrubbing(true);
            const seekAt = (clientX: number) => {
                const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                setTime(pct * totalDuration);
            };
            seekAt(e.clientX);
            const onMove = (ev: PointerEvent) => seekAt(ev.clientX);
            const onUp = () => {
                setScrubbing(false);
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        },
        [totalDuration],
    );

    const toggleSelection = useCallback((key: string, shift: boolean) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (shift) {
                if (next.has(key)) next.delete(key);
                else next.add(key);
            } else {
                return new Set([key]);
            }
            return next;
        });
    }, []);

    const beginRubberBand = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;
            if (target.closest("[data-timeline-item], [data-trim-handle], [title='Drag to scrub'], button, input, textarea, select"))
                return;
            const wrap = timelineRef.current;
            if (!wrap) return;
            const wrapRect = wrap.getBoundingClientRect();
            const startX = e.clientX;
            const startY = e.clientY;
            const shift = e.shiftKey;
            let isDragging = false;
            let latest: { x0: number; y0: number; x1: number; y1: number } | null = null;

            const onMove = (ev: PointerEvent) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!isDragging && Math.abs(dx) + Math.abs(dy) > 4) {
                    isDragging = true;
                    rubberBandActiveRef.current = true;
                }
                if (isDragging) {
                    latest = {
                        x0: Math.min(startX, ev.clientX) - wrapRect.left,
                        y0: Math.min(startY, ev.clientY) - wrapRect.top,
                        x1: Math.max(startX, ev.clientX) - wrapRect.left,
                        y1: Math.max(startY, ev.clientY) - wrapRect.top,
                    };
                    setRubberBand(latest);
                }
            };
            const onUp = (ev: PointerEvent) => {
                if (isDragging && latest) {
                    const items = Array.from(wrap.querySelectorAll<HTMLElement>("[data-timeline-item]"));
                    const hit = new Set<string>();
                    const cx0 = latest.x0 + wrapRect.left;
                    const cy0 = latest.y0 + wrapRect.top;
                    const cx1 = latest.x1 + wrapRect.left;
                    const cy1 = latest.y1 + wrapRect.top;
                    for (const el of items) {
                        const r = el.getBoundingClientRect();
                        if (r.right >= cx0 && r.left <= cx1 && r.bottom >= cy0 && r.top <= cy1) {
                            const k = el.dataset.timelineItem;
                            if (k) hit.add(k);
                        }
                    }
                    setSelectedIds((prev) => (shift ? new Set([...prev, ...hit]) : hit));
                    setTimeout(() => {
                        rubberBandActiveRef.current = false;
                    }, 0);
                } else if (!shift && !(ev.target as HTMLElement | null)?.closest?.("[data-timeline-item]")) {
                    setSelectedIds(new Set());
                }
                setRubberBand(null);
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        },
        [],
    );

    const videoDrivenTimeRef = useRef(false);

    useEffect(() => {
        const v = videoRef.current;
        if (!v || trimmingLabel) return;
        if (!cursor) {
            v.removeAttribute("src");
            v.load();
            return;
        }
        const wantSrc = cursor.clip.src;
        const wantTime = cursor.localTime;
        const srcChanged = v.src !== wantSrc && !v.src.endsWith(wantSrc);
        if (srcChanged) {
            v.src = wantSrc;
            const seek = () => {
                v.currentTime = wantTime;
                if (playing) v.play().catch(() => {});
                v.removeEventListener("loadedmetadata", seek);
            };
            v.addEventListener("loadedmetadata", seek);
            videoDrivenTimeRef.current = false;
            return;
        }
        if (videoDrivenTimeRef.current) {
            videoDrivenTimeRef.current = false;
            return;
        }
        if (Math.abs(v.currentTime - wantTime) > 0.25) {
            v.currentTime = wantTime;
        }
    }, [cursor?.clip.id, cursor?.clip.in, cursor?.clip.out, cursor?.localTime, trimmingLabel]);

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        if (playing) v.play().catch(() => {});
        else v.pause();
        const a = audioRef.current;
        if (a) {
            if (playing) a.play().catch(() => {});
            else a.pause();
        }
    }, [playing]);

    useEffect(() => {
        const a = audioRef.current;
        if (!a) return;
        const cur = scene.audio.find((t) => time >= t.start && time < t.end);
        if (!cur) {
            a.pause();
            a.removeAttribute("src");
            return;
        }
        const want = serveUrl(cur.path);
        if (a.src !== want && !a.src.endsWith(want)) {
            a.src = want;
        }
        const local = Math.max(0, time - cur.start);
        if (Math.abs(a.currentTime - local) > 0.3) {
            try {
                a.currentTime = local;
            } catch {}
        }
        a.volume = cur.volume ?? 1;
        if (playing) a.play().catch(() => {});
    }, [time, scene.audio, playing]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (scene.clips.length === 0) return;
            const step = e.shiftKey ? 1 : 0.1;
            if (e.code === "Space") {
                e.preventDefault();
                setPlaying((p) => !p);
            } else if (e.code === "ArrowLeft") {
                e.preventDefault();
                setTime((v) => Math.max(0, v - step));
            } else if (e.code === "ArrowRight") {
                e.preventDefault();
                setTime((v) => Math.min(totalDuration, v + step));
            } else if (e.code === "Home") {
                e.preventDefault();
                setTime(0);
            } else if (e.code === "End") {
                e.preventDefault();
                setTime(totalDuration);
            } else if (e.code === "KeyJ") {
                e.preventDefault();
                setTime((v) => Math.max(0, v - 5));
            } else if (e.code === "KeyL") {
                e.preventDefault();
                setTime((v) => Math.min(totalDuration, v + 5));
            } else if (e.code === "KeyK") {
                e.preventDefault();
                setPlaying((p) => !p);
            } else if ((e.code === "Delete" || e.code === "Backspace") && selectedIds.size > 0) {
                e.preventDefault();
                setScene((prev) => ({
                    ...prev,
                    clips: prev.clips.filter((c) => !selectedIds.has(`clip:${c.id}`)),
                    texts: prev.texts.filter((t) => !selectedIds.has(`text:${t.id}`)),
                    audio: prev.audio.filter((a) => !selectedIds.has(`audio:${a.id}`)),
                }));
                setSelectedIds(new Set());
            } else if (e.code === "Escape") {
                setSelectedIds(new Set());
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [scene.clips.length, totalDuration, selectedIds]);

    const onTimeUpdate = useCallback(() => {
        const v = videoRef.current;
        if (!v || !cursor) return;
        const local = v.currentTime;
        if (local >= cursor.clip.out - 0.05) {
            let offset = 0;
            for (let i = 0; i < cursor.index; i++) offset += clipDuration(scene.clips[i]);
            const advanceTo = offset + clipDuration(scene.clips[cursor.index]);
            if (advanceTo >= totalDuration - 0.05) {
                setPlaying(false);
                setTime(totalDuration);
            } else {
                setTime(advanceTo + 0.01);
            }
            return;
        }
        let offset = 0;
        for (let i = 0; i < cursor.index; i++) offset += clipDuration(scene.clips[i]);
        videoDrivenTimeRef.current = true;
        setTime(offset + (local - cursor.clip.in));
    }, [cursor, scene.clips, totalDuration]);

    const seekTo = useCallback(
        (pct: number) => {
            const clamped = Math.max(0, Math.min(1, pct));
            setTime(clamped * totalDuration);
        },
        [totalDuration],
    );

    const addText = useCallback(() => {
        if (!textDraft.content.trim()) return;
        setScene((prev) => ({
            ...prev,
            texts: [
                ...prev.texts,
                {
                    id: `text-${Date.now()}`,
                    content: textDraft.content,
                    start: snap(textDraft.start),
                    end: snap(Math.max(textDraft.start + 0.5, textDraft.end)),
                    style: textDraft.style,
                },
            ],
        }));
        setTextDraft({ content: "", start: 0, end: 2, style: "default" });
        setShowTextEditor(false);
    }, [textDraft]);

    const removeText = useCallback((id: string) => {
        setScene((prev) => ({ ...prev, texts: prev.texts.filter((t) => t.id !== id) }));
    }, []);

    const updateText = useCallback((id: string, patch: Partial<TextOverlay>) => {
        setScene((prev) => {
            const texts = prev.texts.slice();
            const idx = texts.findIndex((t) => t.id === id);
            if (idx === -1) return prev;
            texts[idx] = { ...texts[idx], ...patch };
            return { ...prev, texts };
        });
    }, []);

    const setClipTransition = useCallback((clipId: string, kind: TransitionKind, duration: number = 0.5) => {
        setScene((prev) => {
            const clips = prev.clips.slice();
            const idx = clips.findIndex((c) => c.id === clipId);
            if (idx === -1) return prev;
            if (idx === 0) {
                clips[idx] = { ...clips[idx], transitionIn: { kind: "cut", duration: 0 } };
            } else {
                clips[idx] = { ...clips[idx], transitionIn: { kind, duration } };
            }
            return { ...prev, clips };
        });
    }, []);

    const autoCaption = useCallback(async () => {
        if (scene.clips.length === 0) {
            toast.error("No clips to caption");
            return;
        }
        // use clip at current playhead, fall back to first
        const at = clipAtTime(scene, time);
        const targetIdx = at?.index ?? 0;
        const target = scene.clips[targetIdx];
        const srcPath = decodeURIComponent(new URL(target.src, "http://x").searchParams.get("path") ?? "");
        if (!srcPath || !srcPath.startsWith("/tmp/")) {
            toast.error("Clip source not on /tmp/");
            return;
        }
        setTranscribing(true);
        setTranscribeStartedAt(Date.now());
        setTranscribeElapsedMs(0);
        try {
            const res = await fetch("/api/transcribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ output_file: srcPath }),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error ?? `http ${res.status}`);
            }
            type Seg = {
                start: number;
                end: number;
                text: string;
                words?: { word: string; start: number; end: number }[];
            };
            const segments: Seg[] = data.segments ?? [];
            if (segments.length === 0) {
                toast.error("No speech detected");
                return;
            }

            // compute timeline offset for this clip: sum of prior clip durations
            // and subtract this clip's `in` point since Whisper timestamps are
            // relative to the source file (we sent the full src path, not a trim).
            let timelineOffset = 0;
            for (let i = 0; i < targetIdx; i++) timelineOffset += clipDuration(scene.clips[i]);
            const clipIn = target.in;
            const clipOut = target.out;

            // chunk into 3-5 word phrases using word timestamps when possible
            const phrases: { content: string; start: number; end: number }[] = [];
            for (const seg of segments) {
                const words = seg.words ?? [];
                if (words.length > 0) {
                    for (let i = 0; i < words.length; i += 4) {
                        const chunk = words.slice(i, i + 4);
                        if (chunk.length === 0) continue;
                        const rawStart = chunk[0].start;
                        const rawEnd = chunk[chunk.length - 1].end;
                        // skip if outside the trimmed region
                        if (rawEnd < clipIn || rawStart > clipOut) continue;
                        const s = Math.max(clipIn, rawStart);
                        const e = Math.min(clipOut, rawEnd);
                        if (e - s < 0.05) continue;
                        phrases.push({
                            content: chunk.map((w) => w.word).join("").trim(),
                            start: timelineOffset + (s - clipIn),
                            end: timelineOffset + (e - clipIn),
                        });
                    }
                } else {
                    if (seg.end < clipIn || seg.start > clipOut) continue;
                    const s = Math.max(clipIn, seg.start);
                    const e = Math.min(clipOut, seg.end);
                    if (e - s < 0.05) continue;
                    phrases.push({
                        content: seg.text,
                        start: timelineOffset + (s - clipIn),
                        end: timelineOffset + (e - clipIn),
                    });
                }
            }

            if (phrases.length === 0) {
                toast.error("No phrases fit inside clip trim");
                return;
            }

            setScene((prev) => ({
                ...prev,
                texts: [
                    ...prev.texts,
                    ...phrases.map((p, i) => ({
                        id: `caption-${Date.now()}-${i}`,
                        content: p.content,
                        start: Math.round(p.start * 10) / 10,
                        end: Math.round(p.end * 10) / 10,
                        style: "caption" as TextStylePreset,
                        animation: "word-pop" as TextAnimation,
                    })),
                ],
            }));
            toast.success(`Added ${phrases.length} caption${phrases.length === 1 ? "" : "s"}`);
        } catch (e) {
            toast.error(`Transcribe failed: ${String(e).slice(0, 200)}`);
        } finally {
            setTranscribing(false);
            setTranscribeStartedAt(null);
        }
    }, [scene, time]);

    const addAudioFromPath = useCallback(async (path: string, label?: string) => {
        if (!path.trim()) return;
        const src = serveUrl(path);
        let dur = 5;
        try {
            const probed = await new Promise<number>((resolve, reject) => {
                const el = document.createElement("audio");
                el.preload = "metadata";
                el.src = src;
                el.onloadedmetadata = () => resolve(el.duration || 5);
                el.onerror = () => reject(new Error("probe"));
            });
            dur = probed;
        } catch {}
        setScene((prev) => ({
            ...prev,
            audio: [
                ...prev.audio,
                {
                    id: `audio-${Date.now()}`,
                    path,
                    label: label ?? path.split("/").pop() ?? path,
                    start: 0,
                    end: Math.min(dur, Math.max(totalDuration, dur)),
                    volume: 1,
                },
            ],
        }));
        setShowAudioPicker(false);
        setAudioPath("");
    }, [totalDuration]);

    const removeAudio = useCallback((id: string) => {
        setScene((prev) => ({ ...prev, audio: prev.audio.filter((a) => a.id !== id) }));
    }, []);

    const doExport = useCallback(async () => {
        if (scene.clips.length === 0) return;
        setExporting(true);
        setExportStartedAt(Date.now());
        setExportElapsedMs(0);
        setExportError(null);
        setExportPath(null);
        try {
            const serializable = {
                ...scene,
                clips: scene.clips.map((c) => ({
                    ...c,
                    path: decodeURIComponent(new URL(c.src, "http://x").searchParams.get("path") ?? ""),
                })),
            };
            const res = await fetch("/api/studio-render", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(serializable),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                setExportError(data.error ?? "render failed");
            } else {
                setExportPath(data.path);
            }
        } catch (e) {
            setExportError(String(e).slice(0, 300));
        } finally {
            setExporting(false);
            setExportStartedAt(null);
        }
    }, [scene]);

    const exportEstimateMs = useMemo(
        () => Math.round((3 + scene.clips.length * 1.0 + totalDuration * 0.6) * 1000),
        [scene.clips.length, totalDuration],
    );
    const exportProgressPct = Math.min(
        95,
        exportEstimateMs > 0 ? Math.round((exportElapsedMs / exportEstimateMs) * 100) : 0,
    );

    const applyOperations = useCallback(
        async (ops: Array<Record<string, unknown>>): Promise<ChatOp[]> => {
            const applied: ChatOp[] = [];
            for (const op of ops) {
                const name = op.name as string;
                const args = (op.arguments ?? {}) as Record<string, unknown>;
                try {
                    if (name === "add_clip") {
                        const path = args.path as string;
                        const entry = library.find((l) => l.path === path) ?? { label: path, path };
                        await addClip(entry);
                        applied.push({ kind: name, summary: `added clip ${entry.label}` });
                    } else if (name === "remove_clip") {
                        removeClip(args.id as string);
                        applied.push({ kind: name, summary: `removed clip ${args.id}` });
                    } else if (name === "trim_clip") {
                        setScene((prev) => {
                            const clips = prev.clips.slice();
                            const idx = clips.findIndex((c) => c.id === args.id);
                            if (idx === -1) return prev;
                            clips[idx] = {
                                ...clips[idx],
                                in: snap(Math.max(0, args.in as number)),
                                out: snap(Math.min(clips[idx].sourceDuration, args.out as number)),
                            };
                            return { ...prev, clips };
                        });
                        applied.push({ kind: name, summary: `trimmed ${args.in}-${args.out}s` });
                    } else if (name === "reorder_clip") {
                        setScene((prev) => {
                            const idx = prev.clips.findIndex((c) => c.id === args.id);
                            if (idx === -1) return prev;
                            const to = args.newIndex as number;
                            const clips = prev.clips.slice();
                            const [item] = clips.splice(idx, 1);
                            clips.splice(to, 0, item);
                            return { ...prev, clips };
                        });
                        applied.push({ kind: name, summary: `reordered to ${args.newIndex}` });
                    } else if (name === "add_text") {
                        setScene((prev) => ({
                            ...prev,
                            texts: [
                                ...prev.texts,
                                {
                                    id: `text-${Date.now()}-${Math.random()}`,
                                    content: args.content as string,
                                    start: snap((args.start as number) ?? 0),
                                    end: snap((args.end as number) ?? 2),
                                    style: (args.style as TextStylePreset) ?? "default",
                                    animation: (args.animation as TextAnimation) ?? "none",
                                },
                            ],
                        }));
                        applied.push({ kind: name, summary: `added text "${args.content}"` });
                    } else if (name === "add_audio") {
                        await addAudioFromPath(args.path as string);
                        applied.push({ kind: name, summary: `added audio ${args.path}` });
                    } else if (name === "edit_text") {
                        const id = args.id as string;
                        const patch: Partial<TextOverlay> = {};
                        if (typeof args.content === "string") patch.content = args.content;
                        if (typeof args.start === "number") patch.start = snap(args.start);
                        if (typeof args.end === "number") patch.end = snap(args.end);
                        if (typeof args.style === "string") patch.style = args.style as TextStylePreset;
                        if (typeof args.animation === "string") patch.animation = args.animation as TextAnimation;
                        updateText(id, patch);
                        applied.push({ kind: name, summary: `edited text ${id}` });
                    } else if (name === "set_transition") {
                        const clipId = args.clip_id as string;
                        const kind = (args.kind as TransitionKind) ?? "cut";
                        const duration = typeof args.duration === "number" ? args.duration : 0.5;
                        setClipTransition(clipId, kind, duration);
                        applied.push({ kind: name, summary: `transition ${kind} on ${clipId}` });
                    } else if (name === "auto_caption") {
                        await autoCaption();
                        applied.push({ kind: name, summary: `auto-captioned` });
                    } else if (name === "set_orientation") {
                        setScene((prev) => ({ ...prev, orientation: args.orientation as "vertical" | "horizontal" }));
                        applied.push({ kind: name, summary: `orientation ${args.orientation}` });
                    }
                } catch (e) {
                    applied.push({ kind: name, summary: `failed: ${String(e).slice(0, 80)}` });
                }
            }
            return applied;
        },
        [addClip, removeClip, addAudioFromPath, updateText, setClipTransition, autoCaption],
    );

    const sendChat = useCallback(async () => {
        if (!chatInput.trim() || chatLoading) return;
        const userMsg: ChatMessage = { role: "user", content: chatInput };
        const nextMsgs = [...chatMsgs, userMsg];
        setChatMsgs(nextMsgs);
        setChatInput("");
        setChatLoading(true);
        try {
            const res = await fetch("/api/studio-chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: nextMsgs, scene }),
            });
            const data = await res.json();
            const reply = data.reply ?? "(no reply)";
            const ops = Array.isArray(data.operations) ? data.operations : [];
            const applied = await applyOperations(ops);
            setLastOps(applied);
            setChatMsgs((m) => [...m, { role: "assistant", content: reply }]);
        } catch (e) {
            setChatMsgs((m) => [...m, { role: "assistant", content: `error: ${String(e).slice(0, 200)}` }]);
        } finally {
            setChatLoading(false);
        }
    }, [chatInput, chatLoading, chatMsgs, scene, applyOperations]);

    return (
        <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
            <header className="flex h-12 items-center justify-between border-b border-zinc-800 px-4">
                <div className="flex items-center gap-3">
                    <Link href="/crop-v2" className="text-xs text-zinc-400 hover:text-zinc-200">
                        ← Back
                    </Link>
                    <span className="text-sm font-semibold tracking-wider">STUDIO</span>
                    <span className="text-xs text-zinc-500">
                        untitled · {scene.clips.length} clips · {scene.texts.length} text · {scene.audio.length} audio · {fmt(totalDuration)}
                    </span>
                    {trimmingLabel && <span className="ml-2 rounded bg-orange-500/20 px-2 py-0.5 text-[10px] text-orange-200">{trimmingLabel}</span>}
                </div>
                <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setCaptionsOpen((o) => !o)}>
                        {captionsOpen ? "Close Captions" : "Captions"}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setChatOpen((o) => !o)}>
                        {chatOpen ? "Close Chat" : "Chat"}
                    </Button>
                    <Button size="sm" disabled={scene.clips.length === 0 || exporting} onClick={doExport}>
                        {exporting ? "Rendering…" : "Export"}
                    </Button>
                </div>
            </header>

            <div className="flex min-h-0 flex-1">
                <aside className="flex w-56 shrink-0 flex-col gap-3 border-r border-zinc-800 p-3">
                    <div>
                        <div className="mb-2 flex items-center justify-between">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                                Clip library
                                <span className="ml-1 text-zinc-600">· {library.length}</span>
                            </div>
                            <button
                                onClick={refreshLibrary}
                                disabled={libraryLoading}
                                className="text-[10px] text-zinc-500 transition-colors hover:text-orange-300 disabled:opacity-40"
                                title="Pick up new clips from /tmp on the Mac mini"
                            >
                                {libraryLoading ? "…" : "↻"}
                            </button>
                        </div>
                        <div className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto pr-1">
                            {library.map((entry) => {
                                const isProbing = probing === entry.path;
                                return (
                                    <button
                                        key={entry.path}
                                        onClick={() => addClip(entry)}
                                        disabled={isProbing}
                                        draggable
                                        onDragStart={(e) => {
                                            e.dataTransfer.setData("application/x-studio-library", JSON.stringify(entry));
                                            e.dataTransfer.effectAllowed = "copy";
                                            setLibraryDrag(entry);
                                        }}
                                        onDragEnd={() => {
                                            setLibraryDrag(null);
                                            setDropInsertIndex(null);
                                        }}
                                        className="cursor-grab rounded border border-zinc-800 bg-zinc-900/50 px-2 py-2 text-left text-xs text-zinc-200 hover:border-zinc-600 hover:bg-zinc-900 disabled:opacity-70"
                                    >
                                        <div className="flex items-center gap-1.5">
                                            {isProbing && (
                                                <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-zinc-700 border-t-orange-400" />
                                            )}
                                            <div className="font-medium">{entry.label}</div>
                                        </div>
                                        <div className="truncate text-[10px] text-zinc-500">{entry.path}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div>
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Add</div>
                        <div className="flex flex-col gap-1">
                            <Button size="sm" variant="secondary" onClick={() => setShowTextEditor((s) => !s)}>
                                + Text
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setShowAudioPicker((s) => !s)}>
                                + Audio
                            </Button>
                        </div>
                        {showTextEditor && (
                            <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/50 p-2">
                                <textarea
                                    value={textDraft.content}
                                    onChange={(e) => setTextDraft({ ...textDraft, content: e.target.value })}
                                    placeholder="Text content"
                                    className="mb-1 w-full rounded border border-zinc-700 bg-zinc-950 p-1 text-xs"
                                    rows={2}
                                />
                                <div className="mb-1 flex gap-1">
                                    <input
                                        type="number"
                                        step="0.1"
                                        value={textDraft.start}
                                        onChange={(e) => setTextDraft({ ...textDraft, start: parseFloat(e.target.value) })}
                                        className="w-1/2 rounded border border-zinc-700 bg-zinc-950 p-1 text-[10px]"
                                        placeholder="start"
                                    />
                                    <input
                                        type="number"
                                        step="0.1"
                                        value={textDraft.end}
                                        onChange={(e) => setTextDraft({ ...textDraft, end: parseFloat(e.target.value) })}
                                        className="w-1/2 rounded border border-zinc-700 bg-zinc-950 p-1 text-[10px]"
                                        placeholder="end"
                                    />
                                </div>
                                <select
                                    value={textDraft.style}
                                    onChange={(e) => setTextDraft({ ...textDraft, style: e.target.value as TextStylePreset })}
                                    className="mb-1 w-full rounded border border-zinc-700 bg-zinc-950 p-1 text-[10px]"
                                >
                                    <option value="default">default</option>
                                    <option value="title">title</option>
                                    <option value="caption">caption</option>
                                    <option value="hook">hook</option>
                                </select>
                                <Button size="sm" className="w-full" onClick={addText}>
                                    Add text
                                </Button>
                            </div>
                        )}
                        {showAudioPicker && (
                            <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/50 p-2">
                                {AUDIO_LIBRARY.map((a) => (
                                    <button
                                        key={a.path}
                                        onClick={() => addAudioFromPath(a.path, a.label)}
                                        className="mb-1 block w-full rounded border border-zinc-800 bg-zinc-900 px-1 py-1 text-left text-[10px] hover:border-zinc-600"
                                    >
                                        {a.label}
                                    </button>
                                ))}
                                <input
                                    type="text"
                                    value={audioPath}
                                    onChange={(e) => setAudioPath(e.target.value)}
                                    placeholder="/tmp/custom.mp3"
                                    className="mb-1 w-full rounded border border-zinc-700 bg-zinc-950 p-1 text-[10px]"
                                />
                                <Button size="sm" className="w-full" onClick={() => addAudioFromPath(audioPath)}>
                                    Add from path
                                </Button>
                            </div>
                        )}
                    </div>
                </aside>

                <main className="flex min-w-0 flex-1 flex-col">
                    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-6">
                        {exporting && (
                            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/80 backdrop-blur-sm">
                                <div className="flex items-center gap-3">
                                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-orange-400" />
                                    <span className="text-sm font-semibold tracking-wider text-zinc-100">RENDERING</span>
                                </div>
                                <div className="w-72">
                                    <div className="mb-1 flex justify-between font-mono text-[10px] text-zinc-400">
                                        <span>{(exportElapsedMs / 1000).toFixed(1)}s elapsed</span>
                                        <span>~{(exportEstimateMs / 1000).toFixed(0)}s est.</span>
                                    </div>
                                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                                        <div
                                            className="h-full bg-orange-400 transition-[width] duration-150"
                                            style={{ width: `${exportProgressPct}%` }}
                                        />
                                    </div>
                                </div>
                                <div className="text-[10px] text-zinc-500">
                                    ffmpeg · {scene.clips.length} clip{scene.clips.length === 1 ? "" : "s"} · {fmt(totalDuration)} · {scene.texts.length} text · {scene.audio.length} audio
                                </div>
                            </div>
                        )}
                        {scene.clips.length === 0 && !exportPath ? (
                            <div className="text-center text-sm text-zinc-500">
                                <div className="mb-1 text-zinc-400">Empty timeline</div>
                                <div>Add a clip from the library on the left.</div>
                            </div>
                        ) : exportPath ? (
                            <div className="flex flex-col items-center gap-2">
                                <video
                                    src={serveUrl(exportPath)}
                                    className="max-h-[70vh] max-w-full"
                                    controls
                                    playsInline
                                />
                                <div className="flex gap-2">
                                    <a
                                        href={serveUrl(exportPath)}
                                        download
                                        className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs hover:bg-zinc-800"
                                    >
                                        Download
                                    </a>
                                    <button
                                        className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs hover:bg-zinc-800"
                                        onClick={() => setExportPath(null)}
                                    >
                                        Back to editor
                                    </button>
                                </div>
                                <div className="text-[10px] text-zinc-500">{exportPath}</div>
                            </div>
                        ) : (
                            <>
                                <video
                                    ref={videoRef}
                                    onTimeUpdate={onTimeUpdate}
                                    className="max-h-full max-w-full"
                                    playsInline
                                    controls={false}
                                    style={
                                        transitionPreview && (transitionPreview.kind === "slide-left" || transitionPreview.kind === "slide-right")
                                            ? {
                                                  transform: `translateX(${transitionPreview.kind === "slide-left" ? -transitionPreview.progress * 100 : transitionPreview.progress * 100}%)`,
                                              }
                                            : undefined
                                    }
                                />
                                {transitionPreview && (
                                    <video
                                        ref={secondaryVideoRef}
                                        className="pointer-events-none absolute max-h-full max-w-full"
                                        playsInline
                                        muted
                                        style={
                                            transitionPreview.kind === "fade" || transitionPreview.kind === "crossfade"
                                                ? { opacity: transitionPreview.progress }
                                                : transitionPreview.kind === "slide-left"
                                                    ? { transform: `translateX(${(1 - transitionPreview.progress) * 100}%)` }
                                                    : { transform: `translateX(${-(1 - transitionPreview.progress) * 100}%)` }
                                        }
                                    />
                                )}
                                {activeTexts.map((t) => {
                                    const preset = TEXT_STYLES[t.style ?? "default"];
                                    const animation = t.animation ?? "none";
                                    const dur = Math.max(0.01, t.end - t.start);
                                    const animDur = Math.min(0.5, dur);
                                    const animCssDur = `${animDur.toFixed(3)}s`;
                                    let animClass = "";
                                    if (animation === "fade") animClass = animStyles.animFade;
                                    else if (animation === "slide-up") animClass = animStyles.animSlideUp;
                                    else if (animation === "pop") animClass = animStyles.animPop;

                                    let displayContent: React.ReactNode = t.content;
                                    if (animation === "typewriter") {
                                        const progress = Math.max(0, Math.min(1, (time - t.start) / Math.min(dur, 2)));
                                        const n = Math.floor(progress * t.content.length);
                                        displayContent = t.content.slice(0, Math.max(1, n));
                                    } else if (animation === "word-pop") {
                                        const words = t.content.split(/\s+/).filter(Boolean);
                                        if (words.length > 0) {
                                            const per = dur / words.length;
                                            const idx = Math.min(
                                                words.length - 1,
                                                Math.max(0, Math.floor((time - t.start) / per)),
                                            );
                                            displayContent = words[idx];
                                        }
                                    } else if (animation === "word-highlight") {
                                        const words = t.content.split(/\s+/).filter(Boolean);
                                        if (words.length > 0) {
                                            const per = dur / words.length;
                                            const activeIdx = Math.min(
                                                words.length - 1,
                                                Math.max(0, Math.floor((time - t.start) / per)),
                                            );
                                            displayContent = (
                                                <span>
                                                    {words.map((w, i) => {
                                                        const isActive = i === activeIdx;
                                                        return (
                                                            <span
                                                                key={i}
                                                                style={{
                                                                    color: isActive ? "#22e06b" : "#6aa8ff",
                                                                    transition: "color 120ms ease-out",
                                                                    marginRight: i < words.length - 1 ? "0.35em" : 0,
                                                                    display: "inline-block",
                                                                    transform: isActive ? "scale(1.08)" : "scale(1)",
                                                                    transformOrigin: "center bottom",
                                                                }}
                                                            >
                                                                {w}
                                                            </span>
                                                        );
                                                    })}
                                                </span>
                                            );
                                        }
                                    }

                                    const isHighlight = animation === "word-highlight";
                                    return (
                                        <div
                                            key={t.id}
                                            className={`pointer-events-none absolute left-1/2 bottom-16 -translate-x-1/2 text-center ${preset.className} ${animClass}`}
                                            style={{
                                                fontSize: preset.fontSize,
                                                color: isHighlight ? undefined : preset.color,
                                                textShadow: "0 2px 10px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.95)",
                                                ["--anim-dur" as string]: animCssDur,
                                            } as React.CSSProperties}
                                        >
                                            {displayContent}
                                        </div>
                                    );
                                })}
                            </>
                        )}
                        <audio ref={audioRef} />
                        {exportError && (
                            <div className="absolute bottom-2 right-2 max-w-sm rounded border border-red-800 bg-red-950/80 p-2 text-[10px] text-red-200">
                                {exportError}
                            </div>
                        )}
                    </div>

                    <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-3">
                        <div className="mb-3 flex items-center gap-4">
                            <button
                                onClick={() => setPlaying((p) => !p)}
                                disabled={scene.clips.length === 0}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-950 shadow-sm transition-all hover:scale-105 hover:bg-white disabled:cursor-not-allowed disabled:opacity-30 active:scale-95"
                                title={playing ? "Pause (Space)" : "Play (Space)"}
                                aria-label={playing ? "Pause" : "Play"}
                            >
                                {playing ? (
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1" width="3" height="10" rx="0.5"/><rect x="7" y="1" width="3" height="10" rx="0.5"/></svg>
                                ) : (
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l8-4.5z"/></svg>
                                )}
                            </button>
                            <div className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-zinc-400">
                                <span className="text-zinc-200">{fmt(time)}</span>
                                <span className="mx-1 text-zinc-600">/</span>
                                <span>{fmt(totalDuration)}</span>
                            </div>
                            {selectedIds.size > 0 && (
                                <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-orange-500/15 px-2.5 py-1 text-[10px] font-medium text-orange-200 ring-1 ring-orange-400/30" title="Press Delete to remove · Esc to clear">
                                    <span className="inline-block h-1 w-1 rounded-full bg-orange-300" />
                                    {selectedIds.size} selected
                                    <span className="text-orange-300/60">· Del to remove</span>
                                </span>
                            )}
                            <div className="ml-auto hidden shrink-0 items-center gap-4 whitespace-nowrap text-[10px] text-zinc-500 lg:flex" title="Shortcuts: Space play · ← → nudge 0.1s · J L ±5s · Home/End">
                                <span className="flex items-center gap-1.5">
                                    <kbd className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 ring-1 ring-zinc-800">space</kbd>
                                    play
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <kbd className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 ring-1 ring-zinc-800">← →</kbd>
                                    nudge
                                </span>
                                <span className="flex items-center gap-1.5">
                                    <kbd className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 ring-1 ring-zinc-800">j l</kbd>
                                    ±5s
                                </span>
                            </div>
                        </div>

                        <div ref={timelineRef} className="relative" onPointerDown={beginRubberBand}>
                        <div
                            data-clip-track
                            className={`relative h-14 w-full cursor-pointer rounded border bg-zinc-900 ${libraryDrag ? "border-orange-400" : "border-zinc-800"}`}
                            onClick={(e) => {
                                if (rubberBandActiveRef.current) return;
                                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                                seekTo((e.clientX - rect.left) / rect.width);
                            }}
                            onDragOver={(e) => {
                                if (!e.dataTransfer.types.includes("application/x-studio-library")) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "copy";
                                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                                const x = e.clientX - rect.left;
                                let idx = scene.clips.length;
                                if (scene.clips.length > 0) {
                                    let acc = 0;
                                    idx = scene.clips.length;
                                    for (let i = 0; i < scene.clips.length; i++) {
                                        const w = (clipDuration(scene.clips[i]) / Math.max(0.01, totalDuration)) * rect.width;
                                        if (x < acc + w / 2) { idx = i; break; }
                                        acc += w;
                                    }
                                } else {
                                    idx = 0;
                                }
                                setDropInsertIndex((prev) => (prev === idx ? prev : idx));
                            }}
                            onDragLeave={(e) => {
                                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                                setDropInsertIndex(null);
                            }}
                            onDrop={(e) => {
                                const raw = e.dataTransfer.getData("application/x-studio-library");
                                if (!raw) return;
                                e.preventDefault();
                                try {
                                    const entry = JSON.parse(raw) as { label: string; path: string };
                                    const idx = dropInsertIndex ?? scene.clips.length;
                                    addClipAt(entry, idx);
                                } catch {}
                                setLibraryDrag(null);
                                setDropInsertIndex(null);
                            }}
                        >
                            {scene.clips.length === 0 && (
                                <div className={`pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] ${libraryDrag ? "text-orange-300" : "text-zinc-600"}`}>
                                    {libraryDrag ? `Drop "${libraryDrag.label}" here` : "Drag a library clip here to start"}
                                </div>
                            )}
                            {dropInsertIndex !== null && scene.clips.length > 0 && (
                                <div
                                    className="pointer-events-none absolute top-0 z-20 h-full w-[3px] bg-orange-400 shadow-[0_0_8px_rgb(251,146,60)]"
                                    style={{
                                        left: (() => {
                                            const prior = scene.clips.slice(0, dropInsertIndex).reduce((a, c) => a + clipDuration(c), 0);
                                            return `${(prior / Math.max(0.01, totalDuration)) * 100}%`;
                                        })(),
                                    }}
                                />
                            )}
                            <div className="flex h-full w-full overflow-hidden rounded">
                                {scene.clips.map((c, i) => {
                                    const pct = totalDuration > 0 ? (clipDuration(c) / totalDuration) * 100 : 0;
                                    const isActive = cursor?.index === i;
                                    const isSelected = selectedIds.has(`clip:${c.id}`);
                                    return (
                                        <div
                                            key={c.id}
                                            data-timeline-item={`clip:${c.id}`}
                                            draggable
                                            onDragStart={() => setDragIdx(i)}
                                            onDragOver={(e) => {
                                                e.preventDefault();
                                                if (e.dataTransfer.types.includes("application/x-studio-library")) {
                                                    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                                                    const insertAt = e.clientX < rect.left + rect.width / 2 ? i : i + 1;
                                                    setDropInsertIndex(insertAt);
                                                }
                                            }}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                const raw = e.dataTransfer.getData("application/x-studio-library");
                                                if (raw) {
                                                    try {
                                                        const entry = JSON.parse(raw) as { label: string; path: string };
                                                        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                                                        const insertAt = e.clientX < rect.left + rect.width / 2 ? i : i + 1;
                                                        addClipAt(entry, insertAt);
                                                    } catch {}
                                                    setLibraryDrag(null);
                                                    setDropInsertIndex(null);
                                                    return;
                                                }
                                                if (dragIdx !== null) moveClip(dragIdx, i);
                                                setDragIdx(null);
                                            }}
                                            onPointerDown={(e) => {
                                                e.stopPropagation();
                                                toggleSelection(`clip:${c.id}`, e.shiftKey);
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            className={`relative flex h-full flex-col justify-between border-r border-zinc-950 px-2 py-1 text-[10px] transition-colors ${
                                                isSelected ? "ring-2 ring-orange-300 ring-inset " : ""
                                            }${
                                                isActive
                                                    ? "bg-orange-500/30 text-orange-100"
                                                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                                            }`}
                                            style={{ width: `${pct}%` }}
                                            title={c.label}
                                        >
                                            <div
                                                onPointerDown={(e) => beginTrim(c.id, "left", e)}
                                                className="absolute left-0 top-0 z-10 h-full w-2 cursor-ew-resize bg-orange-400/0 hover:bg-orange-400/60"
                                                title={`in ${fmtFine(c.in)}`}
                                            />
                                            {i > 0 && (
                                                <div className="absolute left-2 top-0 z-20">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setTransitionPopoverClipId((prev) => (prev === c.id ? null : c.id));
                                                        }}
                                                        className="mt-0.5 rounded bg-zinc-950/80 px-1 py-0.5 text-[9px] text-zinc-200 hover:bg-zinc-800"
                                                        title={`Transition: ${c.transitionIn?.kind ?? "cut"}`}
                                                    >
                                                        {c.transitionIn && c.transitionIn.kind !== "cut" ? "⇄ " + c.transitionIn.kind : "⇄"}
                                                    </button>
                                                    {transitionPopoverClipId === c.id && (
                                                        <div
                                                            className="absolute left-0 top-6 z-30 flex w-[260px] flex-wrap gap-1 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-xl"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            {(["cut", "fade", "crossfade", "slide-left", "slide-right"] as TransitionKind[]).map((k) => {
                                                                const active = (c.transitionIn?.kind ?? "cut") === k;
                                                                return (
                                                                    <button
                                                                        key={k}
                                                                        onClick={() => {
                                                                            setClipTransition(c.id, k, 0.5);
                                                                            setTransitionPopoverClipId(null);
                                                                        }}
                                                                        className={`rounded px-2 py-1 text-[10px] ${active ? "bg-orange-500 text-white" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"}`}
                                                                    >
                                                                        {k}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                            <div
                                                onPointerDown={(e) => beginTrim(c.id, "right", e)}
                                                className="absolute right-0 top-0 z-10 h-full w-2 cursor-ew-resize bg-orange-400/0 hover:bg-orange-400/60"
                                                title={`out ${fmtFine(c.out)}`}
                                            />
                                            <span className="truncate font-medium">{c.label}</span>
                                            <div className="flex items-center justify-between">
                                                <span className="text-zinc-400">
                                                    {fmtFine(c.in)}–{fmtFine(c.out)}
                                                </span>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        removeClip(c.id);
                                                    }}
                                                    className="text-zinc-500 hover:text-red-400"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div
                            data-track
                            className="relative mt-1 h-8 w-full rounded border border-zinc-800 bg-zinc-900/50"
                            onClick={(e) => {
                                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                                seekTo((e.clientX - rect.left) / rect.width);
                            }}
                        >
                            <span className="pointer-events-none absolute left-1 top-1 text-[9px] uppercase tracking-wider text-zinc-600">Text</span>
                            {scene.texts.map((t) => {
                                const left = totalDuration > 0 ? (t.start / totalDuration) * 100 : 0;
                                const width = totalDuration > 0 ? ((t.end - t.start) / totalDuration) * 100 : 0;
                                const isHi = highlightedTextId === t.id;
                                const isSelected = selectedIds.has(`text:${t.id}`);
                                return (
                                    <div
                                        key={t.id}
                                        data-timeline-item={`text:${t.id}`}
                                        onPointerDown={(e) => {
                                            if (e.shiftKey) {
                                                e.stopPropagation();
                                                toggleSelection(`text:${t.id}`, true);
                                                return;
                                            }
                                            toggleSelection(`text:${t.id}`, false);
                                            beginTrackItemDrag("text", t.id, "move", e);
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                        className={`absolute top-1 h-6 cursor-grab rounded border border-sky-700 bg-sky-900/70 px-1 text-[10px] text-sky-100 hover:border-sky-500 ${isHi ? animStyles.highlightRing : ""} ${isSelected ? "ring-2 ring-orange-300" : ""}`}
                                        style={{ left: `${left}%`, width: `${width}%` }}
                                        title={`${t.content} (${fmtFine(t.start)}-${fmtFine(t.end)})`}
                                    >
                                        <div
                                            onPointerDown={(e) => beginTrackItemDrag("text", t.id, "left", e)}
                                            className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize bg-sky-400/40"
                                        />
                                        <div
                                            onPointerDown={(e) => beginTrackItemDrag("text", t.id, "right", e)}
                                            className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize bg-sky-400/40"
                                        />
                                        <div className="flex items-center justify-between">
                                            <span className="truncate">{t.content}</span>
                                            <button
                                                className="text-sky-300 hover:text-red-400"
                                                onPointerDown={(e) => e.stopPropagation()}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    removeText(t.id);
                                                }}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div
                            data-track
                            className="relative mt-1 h-8 w-full rounded border border-zinc-800 bg-zinc-900/50"
                            onClick={(e) => {
                                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                                seekTo((e.clientX - rect.left) / rect.width);
                            }}
                        >
                            <span className="pointer-events-none absolute left-1 top-1 text-[9px] uppercase tracking-wider text-zinc-600">Audio</span>
                            {scene.audio.map((a) => {
                                const left = totalDuration > 0 ? (a.start / totalDuration) * 100 : 0;
                                const width = totalDuration > 0 ? ((a.end - a.start) / totalDuration) * 100 : 0;
                                const isSelected = selectedIds.has(`audio:${a.id}`);
                                return (
                                    <div
                                        key={a.id}
                                        data-timeline-item={`audio:${a.id}`}
                                        onPointerDown={(e) => {
                                            if (e.shiftKey) {
                                                e.stopPropagation();
                                                toggleSelection(`audio:${a.id}`, true);
                                                return;
                                            }
                                            toggleSelection(`audio:${a.id}`, false);
                                            beginTrackItemDrag("audio", a.id, "move", e);
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                        className={`absolute top-1 h-6 cursor-grab rounded border border-emerald-700 bg-emerald-900/70 px-1 text-[10px] text-emerald-100 hover:border-emerald-500 ${isSelected ? "ring-2 ring-orange-300" : ""}`}
                                        style={{ left: `${left}%`, width: `${width}%` }}
                                        title={`${a.label} (${fmtFine(a.start)}-${fmtFine(a.end)})`}
                                    >
                                        <div
                                            onPointerDown={(e) => beginTrackItemDrag("audio", a.id, "left", e)}
                                            className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize bg-emerald-400/40"
                                        />
                                        <div
                                            onPointerDown={(e) => beginTrackItemDrag("audio", a.id, "right", e)}
                                            className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize bg-emerald-400/40"
                                        />
                                        <div className="flex items-center justify-between">
                                            <span className="truncate">{a.label}</span>
                                            <button
                                                className="text-emerald-300 hover:text-red-400"
                                                onPointerDown={(e) => e.stopPropagation()}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    removeAudio(a.id);
                                                }}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {totalDuration > 0 && (
                            <>
                                <div
                                    className="pointer-events-none absolute top-0 z-20 h-full w-[2px] -translate-x-px bg-orange-400"
                                    style={{ left: `${(time / totalDuration) * 100}%` }}
                                />
                                <div
                                    onPointerDown={beginScrub}
                                    className={`absolute top-0 z-30 h-full w-3 -translate-x-1/2 cursor-ew-resize ${scrubbing ? "cursor-grabbing" : ""}`}
                                    style={{ left: `${(time / totalDuration) * 100}%` }}
                                    title="Drag to scrub"
                                >
                                    <div className={`absolute left-1/2 top-0 h-3 w-3 -translate-x-1/2 rounded-sm bg-orange-400 ring-2 ring-orange-400/40 ${scrubbing ? "scale-125" : ""} transition-transform`} />
                                </div>
                            </>
                        )}
                        {rubberBand && (
                            <div
                                className="pointer-events-none absolute z-40 border border-orange-400 bg-orange-400/15"
                                style={{
                                    left: rubberBand.x0,
                                    top: rubberBand.y0,
                                    width: rubberBand.x1 - rubberBand.x0,
                                    height: rubberBand.y1 - rubberBand.y0,
                                }}
                            />
                        )}
                        </div>
                    </div>
                </main>

                {captionsOpen && (
                    <aside className={`flex w-96 shrink-0 flex-col border-l border-zinc-800 ${animStyles.drawerIn}`}>
                        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Captions</div>
                            <div className="text-[10px] text-zinc-500">{scene.texts.length} entries</div>
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-xs">
                            {scene.texts.length === 0 && (
                                <div className="text-zinc-600">No text overlays yet. Click Auto-caption below or add text from the sidebar.</div>
                            )}
                            {[...scene.texts]
                                .sort((a, b) => a.start - b.start)
                                .map((t) => (
                                    <div
                                        key={t.id}
                                        onMouseEnter={() => setHighlightedTextId(t.id)}
                                        onMouseLeave={() => setHighlightedTextId(null)}
                                        onClick={() => setTime(t.start)}
                                        className="cursor-pointer rounded border border-zinc-800 bg-zinc-900/50 p-2 hover:border-zinc-600"
                                    >
                                        <textarea
                                            value={t.content}
                                            onChange={(e) => updateText(t.id, { content: e.target.value })}
                                            onClick={(e) => e.stopPropagation()}
                                            className="mb-1 w-full rounded border border-zinc-700 bg-zinc-950 p-1 text-xs"
                                            rows={2}
                                        />
                                        <div className="mb-1 flex items-center gap-1">
                                            <input
                                                type="number"
                                                step="0.1"
                                                value={t.start}
                                                onChange={(e) => updateText(t.id, { start: parseFloat(e.target.value) || 0 })}
                                                onClick={(e) => e.stopPropagation()}
                                                className="w-16 rounded border border-zinc-700 bg-zinc-950 p-1 text-[10px]"
                                            />
                                            <span className="text-[10px] text-zinc-500">→</span>
                                            <input
                                                type="number"
                                                step="0.1"
                                                value={t.end}
                                                onChange={(e) => updateText(t.id, { end: parseFloat(e.target.value) || 0 })}
                                                onClick={(e) => e.stopPropagation()}
                                                className="w-16 rounded border border-zinc-700 bg-zinc-950 p-1 text-[10px]"
                                            />
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    removeText(t.id);
                                                }}
                                                className="ml-auto rounded border border-red-800 bg-red-950/50 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-900"
                                            >
                                                delete
                                            </button>
                                        </div>
                                        <div className="flex gap-1">
                                            <select
                                                value={t.style ?? "default"}
                                                onChange={(e) => updateText(t.id, { style: e.target.value as TextStylePreset })}
                                                onClick={(e) => e.stopPropagation()}
                                                className="flex-1 rounded border border-zinc-700 bg-zinc-950 p-1 text-[10px]"
                                            >
                                                <option value="default">default</option>
                                                <option value="title">title</option>
                                                <option value="caption">caption</option>
                                                <option value="hook">hook</option>
                                            </select>
                                            <select
                                                value={t.animation ?? "none"}
                                                onChange={(e) => updateText(t.id, { animation: e.target.value as TextAnimation })}
                                                onClick={(e) => e.stopPropagation()}
                                                className="flex-1 rounded border border-zinc-700 bg-zinc-950 p-1 text-[10px]"
                                            >
                                                <option value="none">none</option>
                                                <option value="fade">fade</option>
                                                <option value="slide-up">slide-up</option>
                                                <option value="pop">pop</option>
                                                <option value="typewriter">typewriter</option>
                                                <option value="word-pop">word-pop</option>
                                                <option value="word-highlight">word-highlight (blue · green)</option>
                                            </select>
                                        </div>
                                    </div>
                                ))}
                        </div>
                        <div className="border-t border-zinc-800 p-2">
                            <Button
                                size="sm"
                                className="w-full"
                                disabled={transcribing || scene.clips.length === 0}
                                onClick={autoCaption}
                            >
                                {transcribing
                                    ? `Transcribing… ${(transcribeElapsedMs / 1000).toFixed(1)}s`
                                    : "Auto-caption (Whisper)"}
                            </Button>
                        </div>
                    </aside>
                )}

                {chatOpen && (
                    <aside className={`flex w-80 shrink-0 flex-col border-l border-zinc-800 ${animStyles.drawerIn}`}>
                        <div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                            Studio chat
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-xs">
                            {chatMsgs.length === 0 && (
                                <div className="text-zinc-600">Try: "Add the demo clip and trim to 0-3s" or "Add hook text Hello at 0-2s".</div>
                            )}
                            {chatMsgs.map((m, i) => (
                                <div
                                    key={i}
                                    className={`rounded p-2 ${m.role === "user" ? "bg-zinc-800 text-zinc-100" : "bg-zinc-900 text-zinc-300"}`}
                                >
                                    <div className="text-[9px] uppercase text-zinc-500">{m.role}</div>
                                    <div className="whitespace-pre-wrap">{m.content}</div>
                                </div>
                            ))}
                            {chatLoading && (
                                <div className="flex items-center gap-2 rounded bg-zinc-900 p-2">
                                    <div className="text-[9px] uppercase text-zinc-500">assistant</div>
                                    <div className="flex gap-1">
                                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:0ms]" />
                                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:150ms]" />
                                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:300ms]" />
                                    </div>
                                </div>
                            )}
                        </div>
                        {lastOps.length > 0 && (
                            <div className="flex flex-wrap gap-1 border-t border-zinc-800 p-2">
                                {lastOps.map((o, i) => (
                                    <span key={i} className="rounded border border-orange-800 bg-orange-950/50 px-1.5 py-0.5 text-[9px] text-orange-200">
                                        {o.summary}
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-1 border-t border-zinc-800 p-2">
                            <input
                                type="text"
                                value={chatInput}
                                onChange={(e) => setChatInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") sendChat();
                                }}
                                placeholder="Ask Claude to edit…"
                                className="flex-1 rounded border border-zinc-700 bg-zinc-950 p-1 text-xs"
                            />
                            <Button size="sm" onClick={sendChat} disabled={chatLoading}>
                                Send
                            </Button>
                        </div>
                    </aside>
                )}
            </div>
            <Toaster theme="dark" position="bottom-right" />
        </div>
    );
}
