"use client";

import { useState, useRef, useCallback, useEffect } from "react";

type MappedElement = {
    bbox_norm: { x1: number; y1: number; x2: number; y2: number };
    bbox_px: { x1: number; y1: number; x2: number; y2: number };
    label: string;
    confidence: number;
    iou_score: number;
    selector: string;
    tag: string;
    element_id: string | null;
    element_classes: string[];
    data_testid: string | null;
    styles?: {
        fontSize?: string;
        fontWeight?: string;
        fontFamily?: string;
        color?: string;
        backgroundColor?: string;
        padding?: string;
        margin?: string;
        border?: string;
        borderRadius?: string;
        display?: string;
        width?: string;
        height?: string;
    };
};

type DomElement = {
    selector: string;
    tag: string;
    id: string | null;
    classes: string[];
    x1: number; y1: number; x2: number; y2: number;
    text: string | null;
    styles?: Record<string, string>;
};

type InspectResult = {
    ok: boolean;
    url: string;
    title: string;
    screenshot_base64: string;
    dom_count: number;
    all_dom_count: number;
    detection: {
        ok: boolean;
        count: number;
        mapped: MappedElement[];
        unmatched: number;
        elapsed_seconds: number;
    };
    html?: string;
    all_dom_bounds?: DomElement[];
    error?: string;
};

const COLORS = [
    "#FF3366", "#33FF66", "#3366FF", "#FF9933", "#FF33CC",
    "#33FFCC", "#CC33FF", "#FFCC33", "#33CCFF", "#FF6633",
    "#66FF33", "#9933FF", "#FF3399", "#33FF99", "#3399FF",
    "#FFFF33", "#33FFFF", "#FF33FF", "#99FF33", "#3333FF",
];

export default function InspectorPage() {
    const [url, setUrl] = useState("https://github.com");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<InspectResult | null>(null);
    const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
    const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
    const [showLabels, setShowLabels] = useState(true);
    const [showHtml, setShowHtml] = useState(false);
    const [drawMode, setDrawMode] = useState(false);
    const [drawing, setDrawing] = useState(false);
    const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
    const [drawEnd, setDrawEnd] = useState<{ x: number; y: number } | null>(null);
    const [drawMatch, setDrawMatch] = useState<DomElement | null>(null);
    // Saved labels (persist drawn annotations)
    type SavedLabel = { name: string; match: DomElement; color: string; drawBox: { x1: number; y1: number; x2: number; y2: number } };
    const [savedLabels, setSavedLabels] = useState<SavedLabel[]>([]);
    const [labelName, setLabelName] = useState("");
    // Chat
    type ChatMsg = { role: "user" | "assistant"; content: string };
    const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
    const [chatInput, setChatInput] = useState("");
    const [chatLoading, setChatLoading] = useState(false);
    const chatEndRef = useRef<HTMLDivElement>(null);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);

    // Convert mouse event to canvas pixel coords
    const canvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
        };
    }, []);

    // Find best DOM element matching a drawn rectangle (IoU)
    const findDrawMatch = useCallback((x1: number, y1: number, x2: number, y2: number) => {
        if (!result?.all_dom_bounds) return null;
        const drawnBox = { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
        const drawnArea = (drawnBox.x2 - drawnBox.x1) * (drawnBox.y2 - drawnBox.y1);
        if (drawnArea < 100) return null;

        let bestIou = 0;
        let bestEl: DomElement | null = null;
        for (const el of result.all_dom_bounds) {
            const ix1 = Math.max(drawnBox.x1, el.x1);
            const iy1 = Math.max(drawnBox.y1, el.y1);
            const ix2 = Math.min(drawnBox.x2, el.x2);
            const iy2 = Math.min(drawnBox.y2, el.y2);
            const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
            if (inter === 0) continue;
            const elArea = (el.x2 - el.x1) * (el.y2 - el.y1);
            const iou = inter / (drawnArea + elArea - inter);
            if (iou > bestIou) {
                bestIou = iou;
                bestEl = el;
            }
        }
        return bestEl;
    }, [result]);

    const saveLabel = useCallback(() => {
        if (!drawMatch || !drawStart || !drawEnd) return;
        const name = labelName.trim() || `label-${savedLabels.length + 1}`;
        const color = COLORS[(savedLabels.length + 5) % COLORS.length];
        setSavedLabels((prev) => [
            ...prev,
            {
                name,
                match: drawMatch,
                color,
                drawBox: {
                    x1: Math.min(drawStart.x, drawEnd.x),
                    y1: Math.min(drawStart.y, drawEnd.y),
                    x2: Math.max(drawStart.x, drawEnd.x),
                    y2: Math.max(drawStart.y, drawEnd.y),
                },
            },
        ]);
        setLabelName("");
        setDrawMatch(null);
        setDrawStart(null);
        setDrawEnd(null);
    }, [drawMatch, drawStart, drawEnd, labelName, savedLabels.length]);

    const sendChat = useCallback(async () => {
        if (!chatInput.trim() || !result) return;
        const userMsg = chatInput.trim();
        setChatInput("");
        setChatMessages((prev) => [...prev, { role: "user", content: userMsg }]);
        setChatLoading(true);
        try {
            const r = await fetch("/api/inspector-chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: userMsg,
                    screenshot_base64: result.screenshot_base64,
                    labels: savedLabels,
                    mapped: result.detection.mapped,
                    all_dom: result.all_dom_bounds?.slice(0, 300),
                    html_snippet: result.html?.slice(0, 30000),
                    history: chatMessages.slice(-10),
                }),
            });
            const data = await r.json();
            if (data.ok) {
                setChatMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
                // Parse label commands from the response
                const labelRegex = /```label\s*\n?([\s\S]*?)```/g;
                // Extract label commands — try code fence format AND bare JSON
                const labelCmds: { selector: string; name: string }[] = [];
                let lmatch;
                while ((lmatch = labelRegex.exec(data.reply)) !== null) {
                    try { labelCmds.push(JSON.parse(lmatch[1].trim())); } catch { /* skip */ }
                }
                // Also try bare JSON objects with "selector" key anywhere in the response
                const bareJsonRegex = /\{[^{}]*"selector"\s*:\s*"[^"]+?"[^{}]*\}/g;
                let bjmatch;
                while ((bjmatch = bareJsonRegex.exec(data.reply)) !== null) {
                    try {
                        const parsed = JSON.parse(bjmatch[0]);
                        if (parsed.selector && !labelCmds.some((c) => c.selector === parsed.selector)) {
                            labelCmds.push(parsed);
                        }
                    } catch { /* skip */ }
                }

                for (const cmd of labelCmds) {
                    if (!cmd.selector || !result?.all_dom_bounds) continue;
                    const sel = cmd.selector;
                    const allDom = result.all_dom_bounds;

                    // 1. Exact selector match
                    let domEl = allDom.find((d) => d.selector === sel);

                    // 2. ID match — "#hero-section-brand-heading" → find by id
                    if (!domEl && sel.startsWith("#")) {
                        const id = sel.slice(1);
                        domEl = allDom.find((d) => d.id === id);
                    }

                    // 3. Selector contains match (partial)
                    if (!domEl) {
                        domEl = allDom.find((d) => d.selector?.includes(sel) || sel.includes(d.selector || "___"));
                    }

                    // 4. Text content match (use the label name)
                    if (!domEl && cmd.name) {
                        const needle = cmd.name.toLowerCase().slice(0, 40);
                        domEl = allDom.find(
                            (d) => d.text && d.text.toLowerCase().includes(needle),
                        );
                    }

                    // 5. Class substring match
                    if (!domEl) {
                        const classPart = sel.replace(/^[^.#]*/, "").replace(/[.#]/, "").split(/[:\s]/)[0];
                        if (classPart && classPart.length > 3) {
                            domEl = allDom.find(
                                (d) => d.classes?.some((c: string) => c.includes(classPart)) ||
                                    d.selector?.includes(classPart),
                            );
                        }
                    }

                    // 6. ID substring match (the id might be stored differently)
                    if (!domEl && sel.startsWith("#")) {
                        const idPart = sel.slice(1).toLowerCase();
                        domEl = allDom.find(
                            (d) => d.id?.toLowerCase().includes(idPart) ||
                                d.selector?.toLowerCase().includes(idPart),
                        );
                    }

                    if (domEl) {
                        console.log("[vision-inspector] Label matched:", cmd.name, "→", domEl.selector, "bbox:", domEl.x1, domEl.y1, domEl.x2, domEl.y2);
                        const color = COLORS[(savedLabels.length + labelCmds.indexOf(cmd) + 5) % COLORS.length];
                        const matchedEl = domEl!;
                        setSavedLabels((prev) => [
                            ...prev,
                            {
                                name: cmd.name || cmd.selector,
                                match: matchedEl,
                                color,
                                drawBox: { x1: matchedEl.x1, y1: matchedEl.y1, x2: matchedEl.x2, y2: matchedEl.y2 },
                            },
                        ]);
                        // Auto-scroll canvas to show the labeled element
                        requestAnimationFrame(() => {
                            const container = canvasContainerRef.current;
                            if (container) {
                                container.scrollTop = 0;
                            }
                        });
                    } else {
                        console.warn("[vision-inspector] Could not find DOM element for selector:", sel, "name:", cmd.name);
                    }
                }
            } else {
                setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.error}` }]);
            }
        } catch (e) {
            setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${String(e)}` }]);
        } finally {
            setChatLoading(false);
        }
    }, [chatInput, result, savedLabels, chatMessages]);

    // Auto-scroll chat (only within its own container, NOT the canvas panel)
    useEffect(() => {
        const el = chatEndRef.current;
        if (el) {
            const container = el.closest(".overflow-y-auto");
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }, [chatMessages]);

    // Load preloaded data from pipeline (if navigated via "Open in Inspector")
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.get("preload") === "true") {
            try {
                const raw = sessionStorage.getItem("inspector-preload");
                if (raw) {
                    const data = JSON.parse(raw);
                    setUrl(data.url);
                    setResult({
                        ok: true,
                        url: data.url,
                        title: data.title ?? "",
                        screenshot_base64: data.screenshot_base64,
                        dom_count: data.detection?.mapped?.length ?? 0,
                        all_dom_count: data.all_dom_bounds?.length ?? 0,
                        detection: data.detection,
                        all_dom_bounds: data.all_dom_bounds ?? [],
                    });
                    // Load Gemma labels from pipeline as saved labels
                    if (data.savedLabels && data.savedLabels.length > 0) {
                        setSavedLabels(data.savedLabels);
                    }
                    sessionStorage.removeItem("inspector-preload");
                }
            } catch { /* ignore */ }
        }
    }, []);

    const inspect = useCallback(async () => {
        setLoading(true);
        setError("");
        setResult(null);
        setSelectedIdx(null);
        try {
            const r = await fetch("/api/inspect-url", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, conf: 0.05, styles: true }),
            });
            const data = (await r.json()) as InspectResult;
            if (!data.ok) {
                setError(data.error ?? "unknown error");
            } else {
                setResult(data);
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [url]);

    // Draw screenshot + bboxes on canvas
    useEffect(() => {
        if (!result?.screenshot_base64 || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const img = new Image();
        img.onload = () => {
            imgRef.current = img;
            canvas.width = img.width;
            canvas.height = img.height;
            drawFrame(ctx, img, result.detection.mapped, hoveredIdx, selectedIdx, showLabels, drawStart, drawEnd, drawMatch, savedLabels);
        };
        img.src = `data:image/png;base64,${result.screenshot_base64}`;
    }, [result]);

    // Redraw on state change
    useEffect(() => {
        if (!canvasRef.current || !imgRef.current || !result) return;
        const ctx = canvasRef.current.getContext("2d");
        if (!ctx) return;
        drawFrame(ctx, imgRef.current, result.detection.mapped, hoveredIdx, selectedIdx, showLabels, drawStart, drawEnd, drawMatch, savedLabels);
    }, [hoveredIdx, selectedIdx, showLabels, result, drawStart, drawEnd, drawMatch, savedLabels]);

    const mapped = result?.detection.mapped ?? [];
    const selected = selectedIdx !== null ? mapped[selectedIdx] : null;

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
            {/* Header */}
            <div className="border-b border-zinc-800 bg-zinc-900 px-6 py-4">
                <div className="flex items-center gap-4 max-w-7xl mx-auto">
                    <a href="/inspector" className="text-lg font-bold text-fuchsia-300 whitespace-nowrap hover:text-fuchsia-200">
                        Vision Inspector
                    </a>
                    <a href="/pipeline" className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition whitespace-nowrap">Pipeline</a>
                    <a href="/crop" className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition whitespace-nowrap">Smart Crop</a>
                    <input
                        type="text"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && inspect()}
                        placeholder="https://example.com"
                        className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-4 py-2 text-sm font-mono focus:border-fuchsia-500 focus:outline-none"
                    />
                    <button
                        onClick={inspect}
                        disabled={loading || !url}
                        className="px-5 py-2 rounded-lg text-sm font-bold bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-40 disabled:cursor-not-allowed transition whitespace-nowrap"
                    >
                        {loading ? "Inspecting…" : "Inspect"}
                    </button>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="bg-red-950/50 border border-red-800 text-red-300 px-6 py-3 text-sm">
                    {error}
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="flex-1 flex items-center justify-center text-zinc-500">
                    <div className="text-center space-y-3">
                        <div className="animate-spin w-8 h-8 border-2 border-fuchsia-500 border-t-transparent rounded-full mx-auto" />
                        <div className="text-sm">Screenshotting + detecting UI elements…</div>
                    </div>
                </div>
            )}

            {/* Results */}
            {result && !loading && (
                <div className="flex-1 flex overflow-hidden">
                    {/* Left: Screenshot with overlays */}
                    <div ref={canvasContainerRef} className="flex-1 overflow-auto p-4 bg-zinc-950 flex items-start justify-center">
                        <div className="relative inline-block">
                            <canvas
                                ref={canvasRef}
                                className={`max-w-full rounded-lg border border-zinc-800 ${drawMode ? "cursor-crosshair" : "cursor-pointer"}`}
                                style={{ maxHeight: "calc(100vh - 140px)" }}
                                onMouseDown={(e) => {
                                    if (!drawMode) return;
                                    const c = canvasCoords(e);
                                    setDrawing(true);
                                    setDrawStart(c);
                                    setDrawEnd(c);
                                    setDrawMatch(null);
                                }}
                                onMouseMove={(e) => {
                                    if (drawMode && drawing) {
                                        setDrawEnd(canvasCoords(e));
                                        return;
                                    }
                                    if (drawMode) return;
                                    const c = canvasCoords(e);
                                    const idx = mapped.findIndex((m) => {
                                        const b = m.bbox_px;
                                        return c.x >= b.x1 && c.x <= b.x2 && c.y >= b.y1 && c.y <= b.y2;
                                    });
                                    setHoveredIdx(idx >= 0 ? idx : null);
                                }}
                                onMouseUp={() => {
                                    if (!drawMode || !drawing || !drawStart || !drawEnd) return;
                                    setDrawing(false);
                                    const match = findDrawMatch(drawStart.x, drawStart.y, drawEnd.x, drawEnd.y);
                                    setDrawMatch(match);
                                }}
                                onClick={(e) => {
                                    if (drawMode) return;
                                    const c = canvasCoords(e);
                                    const idx = mapped.findIndex((m) => {
                                        const b = m.bbox_px;
                                        return c.x >= b.x1 && c.x <= b.x2 && c.y >= b.y1 && c.y <= b.y2;
                                    });
                                    setSelectedIdx(idx >= 0 ? idx : null);
                                }}
                                onMouseLeave={() => { setHoveredIdx(null); if (drawing) { setDrawing(false); } }}
                            />
                        </div>
                    </div>

                    {/* Right: Sidebar */}
                    <div className="w-96 border-l border-zinc-800 bg-zinc-900 overflow-y-auto flex-shrink-0">
                        {/* Summary bar */}
                        <div className="p-4 border-b border-zinc-800 space-y-2">
                            <div className="text-xs text-zinc-500 font-mono truncate" title={result.url}>
                                {result.title || result.url}
                            </div>
                            <div className="flex gap-3 text-xs">
                                <span className="text-fuchsia-300 font-bold">{mapped.length} detected</span>
                                <span className="text-zinc-500">{result.detection.unmatched} unmatched</span>
                                <span className="text-zinc-500">{result.dom_count} DOM</span>
                                <span className="text-zinc-500">{result.detection.elapsed_seconds}s</span>
                            </div>
                            <div className="flex gap-4">
                                <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={showLabels}
                                        onChange={(e) => setShowLabels(e.target.checked)}
                                        className="accent-fuchsia-500"
                                    />
                                    Labels
                                </label>
                                <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={drawMode}
                                        onChange={(e) => { setDrawMode(e.target.checked); setDrawMatch(null); setDrawStart(null); setDrawEnd(null); }}
                                        className="accent-amber-500"
                                    />
                                    Draw to select
                                </label>
                                <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={showHtml}
                                        onChange={(e) => setShowHtml(e.target.checked)}
                                        className="accent-emerald-500"
                                    />
                                    HTML
                                </label>
                                <button
                                    onClick={() => {
                                        if (!result) return;
                                        const prompt =
                                            "Review the OmniParser detections above. For each important UI element that was MISSED " +
                                            "(headings, images, text blocks, sections, forms, footers — anything a frontend engineer would want to select), " +
                                            "draw a box around it using a label command. Also note if any existing detections seem wrong. " +
                                            "Focus on the most important 5-10 missing elements.";
                                        setChatInput(prompt);
                                        // Auto-send
                                        setChatMessages((prev) => [...prev, { role: "user", content: prompt }]);
                                        setChatLoading(true);
                                        fetch("/api/inspector-chat", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({
                                                message: prompt,
                                                screenshot_base64: result.screenshot_base64,
                                                labels: savedLabels,
                                                mapped: result.detection.mapped,
                                                all_dom: result.all_dom_bounds?.slice(0, 300),
                                                html_snippet: result.html?.slice(0, 30000),
                                                history: chatMessages.slice(-6),
                                            }),
                                        })
                                            .then((r) => r.json())
                                            .then((data) => {
                                                if (data.ok) {
                                                    setChatMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
                                                    // Parse label commands
                                                    const labelRegex = /```label\s*\n?([\s\S]*?)```/g;
                                                    const bareJsonRegex = /\{[^{}]*"selector"\s*:\s*"[^"]+?"[^{}]*\}/g;
                                                    const cmds: { selector: string; name: string }[] = [];
                                                    let m;
                                                    while ((m = labelRegex.exec(data.reply)) !== null) {
                                                        try { cmds.push(JSON.parse(m[1].trim())); } catch {}
                                                    }
                                                    while ((m = bareJsonRegex.exec(data.reply)) !== null) {
                                                        try {
                                                            const p = JSON.parse(m[0]);
                                                            if (p.selector && !cmds.some((c) => c.selector === p.selector)) cmds.push(p);
                                                        } catch {}
                                                    }
                                                    for (const cmd of cmds) {
                                                        if (!cmd.selector || !result.all_dom_bounds) continue;
                                                        let domEl = result.all_dom_bounds.find((d) => d.selector === cmd.selector);
                                                        if (!domEl && cmd.selector.startsWith("#")) {
                                                            domEl = result.all_dom_bounds.find((d) => d.id === cmd.selector.slice(1));
                                                        }
                                                        if (!domEl && cmd.name) {
                                                            const needle = cmd.name.toLowerCase().slice(0, 40);
                                                            domEl = result.all_dom_bounds.find((d) => d.text?.toLowerCase().includes(needle));
                                                        }
                                                        if (!domEl) {
                                                            const part = cmd.selector.replace(/^[^.#]*/, "").replace(/[.#]/, "").split(/[:\s]/)[0];
                                                            if (part && part.length > 3) {
                                                                domEl = result.all_dom_bounds.find((d) => d.selector?.includes(part));
                                                            }
                                                        }
                                                        if (domEl) {
                                                            const color = COLORS[(savedLabels.length + cmds.indexOf(cmd) + 7) % COLORS.length];
                                                            setSavedLabels((prev) => [
                                                                ...prev,
                                                                { name: cmd.name || cmd.selector, match: domEl!, color, drawBox: { x1: domEl!.x1, y1: domEl!.y1, x2: domEl!.x2, y2: domEl!.y2 } },
                                                            ]);
                                                        }
                                                    }
                                                } else {
                                                    setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.error}` }]);
                                                }
                                            })
                                            .catch((e) => {
                                                setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${String(e)}` }]);
                                            })
                                            .finally(() => {
                                                setChatLoading(false);
                                                setChatInput("");
                                            });
                                    }}
                                    disabled={chatLoading || !result}
                                    className="px-3 py-1 rounded text-[11px] font-bold bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 transition whitespace-nowrap"
                                >
                                    Gemma Check
                                </button>
                            </div>
                        </div>

                        {/* Draw-to-select match */}
                        {drawMatch && (
                            <div className="p-4 border-b border-amber-800/50 bg-amber-950/20">
                                <div className="text-xs font-bold uppercase tracking-wider text-amber-300 mb-2">
                                    Draw Match
                                </div>
                                <div className="space-y-1.5 text-xs">
                                    <div>
                                        <span className="text-zinc-500">tag:</span>{" "}
                                        <span className="text-zinc-100 font-mono">&lt;{drawMatch.tag}&gt;</span>
                                    </div>
                                    <div>
                                        <span className="text-zinc-500">selector:</span>{" "}
                                        <span className="text-zinc-100 font-mono break-all">{drawMatch.selector}</span>
                                    </div>
                                    {drawMatch.id && (
                                        <div>
                                            <span className="text-zinc-500">id:</span>{" "}
                                            <span className="text-zinc-100 font-mono">#{drawMatch.id}</span>
                                        </div>
                                    )}
                                    {drawMatch.text && (
                                        <div>
                                            <span className="text-zinc-500">text:</span>{" "}
                                            <span className="text-zinc-200">{drawMatch.text.slice(0, 120)}</span>
                                        </div>
                                    )}
                                    {drawMatch.classes && drawMatch.classes.length > 0 && (
                                        <div>
                                            <span className="text-zinc-500">classes:</span>{" "}
                                            <span className="text-zinc-100 font-mono break-all">{drawMatch.classes.join(" ")}</span>
                                        </div>
                                    )}
                                    {drawMatch.styles && (
                                        <div className="mt-2 pt-2 border-t border-zinc-800">
                                            <div className="text-[10px] text-zinc-500 uppercase mb-1">Styles</div>
                                            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                                                {Object.entries(drawMatch.styles).map(([k, v]) =>
                                                    v ? (
                                                        <div key={k} className="flex justify-between">
                                                            <span className="text-zinc-500">{k}:</span>
                                                            <span className="text-zinc-200 font-mono truncate ml-1">{String(v).slice(0, 20)}</span>
                                                        </div>
                                                    ) : null,
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    <div className="text-[10px] text-zinc-600 mt-2">
                                        bbox: ({drawMatch.x1.toFixed(0)}, {drawMatch.y1.toFixed(0)}) → ({drawMatch.x2.toFixed(0)}, {drawMatch.y2.toFixed(0)})
                                    </div>
                                    {/* Save label */}
                                    <div className="flex gap-2 mt-3">
                                        <input
                                            type="text"
                                            value={labelName}
                                            onChange={(e) => setLabelName(e.target.value)}
                                            onKeyDown={(e) => e.key === "Enter" && saveLabel()}
                                            placeholder="Label name…"
                                            className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs font-mono focus:border-amber-500 focus:outline-none"
                                        />
                                        <button
                                            onClick={saveLabel}
                                            className="px-3 py-1 rounded text-xs font-bold bg-amber-600 hover:bg-amber-500 text-black transition"
                                        >
                                            Save
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Saved labels */}
                        {savedLabels.length > 0 && (
                            <div className="p-4 border-b border-zinc-800">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="text-xs font-bold uppercase tracking-wider text-amber-300">
                                        Saved Labels ({savedLabels.length})
                                    </div>
                                    <button
                                        onClick={() => setSavedLabels([])}
                                        className="text-[10px] text-zinc-500 hover:text-red-400 underline-offset-2 hover:underline"
                                    >
                                        clear
                                    </button>
                                </div>
                                <div className="space-y-1.5">
                                    {savedLabels.map((l, i) => {
                                        const isExpanded = selectedIdx === -(i + 1);
                                        return (
                                            <div key={i}>
                                                <button
                                                    onClick={() => setSelectedIdx(isExpanded ? null : -(i + 1))}
                                                    className={`w-full text-left px-2.5 py-2 rounded text-xs transition-all ${
                                                        isExpanded
                                                            ? "bg-amber-950/40 border border-amber-700"
                                                            : "border border-zinc-800 hover:bg-zinc-800/50"
                                                    }`}
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: l.color }} />
                                                        <span className="text-amber-200 font-bold flex-1 truncate">{l.name}</span>
                                                        <span className="text-zinc-500 font-mono text-[10px]">&lt;{l.match.tag}&gt;</span>
                                                        <span
                                                            role="button"
                                                            onClick={(e) => { e.stopPropagation(); setSavedLabels((prev) => prev.filter((_, j) => j !== i)); }}
                                                            className="text-zinc-600 hover:text-red-400 text-xs flex-shrink-0 ml-1 cursor-pointer"
                                                        >
                                                            ×
                                                        </span>
                                                    </div>
                                                    <div className="text-[10px] text-zinc-500 font-mono truncate mt-0.5 pl-[18px]">
                                                        {l.match.selector}
                                                    </div>
                                                </button>
                                                {isExpanded && (
                                                    <div className="mt-1 ml-4 p-2.5 rounded bg-zinc-950 border border-amber-800/30 space-y-1.5 text-xs">
                                                        <div>
                                                            <span className="text-zinc-500">tag:</span>{" "}
                                                            <span className="text-zinc-100 font-mono">&lt;{l.match.tag}&gt;</span>
                                                        </div>
                                                        <div>
                                                            <span className="text-zinc-500">selector:</span>{" "}
                                                            <span className="text-zinc-100 font-mono break-all">{l.match.selector}</span>
                                                        </div>
                                                        {l.match.id && (
                                                            <div>
                                                                <span className="text-zinc-500">id:</span>{" "}
                                                                <span className="text-zinc-100 font-mono">#{l.match.id}</span>
                                                            </div>
                                                        )}
                                                        {l.match.classes && l.match.classes.length > 0 && (
                                                            <div>
                                                                <span className="text-zinc-500">classes:</span>{" "}
                                                                <span className="text-zinc-100 font-mono break-all">{l.match.classes.join(" ")}</span>
                                                            </div>
                                                        )}
                                                        {l.match.text && (
                                                            <div>
                                                                <span className="text-zinc-500">text:</span>{" "}
                                                                <span className="text-zinc-200">{l.match.text.slice(0, 100)}</span>
                                                            </div>
                                                        )}
                                                        <div>
                                                            <span className="text-zinc-500">bbox:</span>{" "}
                                                            <span className="text-zinc-400 font-mono">
                                                                ({l.match.x1.toFixed(0)}, {l.match.y1.toFixed(0)}) → ({l.match.x2.toFixed(0)}, {l.match.y2.toFixed(0)})
                                                            </span>
                                                        </div>
                                                        {l.match.styles && (
                                                            <div className="mt-2 pt-2 border-t border-zinc-800">
                                                                <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">
                                                                    Computed Styles
                                                                </div>
                                                                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                                                                    {Object.entries(l.match.styles).map(([k, v]) =>
                                                                        v ? (
                                                                            <div key={k} className="flex justify-between">
                                                                                <span className="text-zinc-500">{k}:</span>
                                                                                <span className="text-zinc-200 font-mono truncate ml-1" title={String(v)}>
                                                                                    {String(v).slice(0, 20)}
                                                                                </span>
                                                                            </div>
                                                                        ) : null,
                                                                    )}
                                                                </div>
                                                                {l.match.styles.color && (
                                                                    <div className="flex items-center gap-2 mt-2">
                                                                        <div className="w-4 h-4 rounded border border-zinc-700" style={{ backgroundColor: l.match.styles.color }} />
                                                                        <span className="text-[10px] text-zinc-500">color</span>
                                                                        {l.match.styles.backgroundColor && (
                                                                            <>
                                                                                <div className="w-4 h-4 rounded border border-zinc-700" style={{ backgroundColor: l.match.styles.backgroundColor }} />
                                                                                <span className="text-[10px] text-zinc-500">bg</span>
                                                                            </>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                        {/* Add to chat button */}
                                                        <button
                                                            onClick={() => {
                                                                const ctx = `[${l.name}] <${l.match.tag}> selector="${l.match.selector}"${l.match.text ? ` text="${l.match.text.slice(0, 60)}"` : ""}${l.match.styles?.fontSize ? ` fontSize=${l.match.styles.fontSize}` : ""}${l.match.styles?.color ? ` color=${l.match.styles.color}` : ""} — `;
                                                                setChatInput((prev) => prev + ctx);
                                                                // Focus the chat input
                                                                const chatEl = document.querySelector<HTMLInputElement>('input[placeholder="Ask about the UI…"]');
                                                                chatEl?.focus();
                                                            }}
                                                            className="mt-2 w-full px-2 py-1.5 rounded text-[11px] font-bold bg-sky-700/30 hover:bg-sky-700/50 border border-sky-800 text-sky-200 transition"
                                                        >
                                                            + Add to Chat
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Selected element detail */}
                        {selected && (
                            <div className="p-4 border-b border-fuchsia-800/50 bg-fuchsia-950/20">
                                <div className="text-xs font-bold uppercase tracking-wider text-fuchsia-300 mb-2">
                                    Selected Element
                                </div>
                                <div className="space-y-1.5 text-xs">
                                    <div>
                                        <span className="text-zinc-500">tag:</span>{" "}
                                        <span className="text-zinc-100 font-mono">&lt;{selected.tag}&gt;</span>
                                    </div>
                                    <div>
                                        <span className="text-zinc-500">selector:</span>{" "}
                                        <span className="text-zinc-100 font-mono break-all">{selected.selector}</span>
                                    </div>
                                    {selected.element_id && (
                                        <div>
                                            <span className="text-zinc-500">id:</span>{" "}
                                            <span className="text-zinc-100 font-mono">#{selected.element_id}</span>
                                        </div>
                                    )}
                                    {selected.element_classes.length > 0 && (
                                        <div>
                                            <span className="text-zinc-500">classes:</span>{" "}
                                            <span className="text-zinc-100 font-mono break-all">
                                                {selected.element_classes.join(" ")}
                                            </span>
                                        </div>
                                    )}
                                    <div>
                                        <span className="text-zinc-500">confidence:</span>{" "}
                                        <span className="text-emerald-300 font-bold">{(selected.confidence * 100).toFixed(0)}%</span>
                                        <span className="text-zinc-500 ml-2">iou:</span>{" "}
                                        <span className="text-zinc-300">{selected.iou_score.toFixed(2)}</span>
                                    </div>
                                    {selected.data_testid && (
                                        <div>
                                            <span className="text-zinc-500">data-testid:</span>{" "}
                                            <span className="text-amber-300 font-mono">{selected.data_testid}</span>
                                        </div>
                                    )}
                                </div>

                                {/* Computed styles */}
                                {selected.styles && (
                                    <div className="mt-3 pt-3 border-t border-zinc-800">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1.5">
                                            Computed Styles
                                        </div>
                                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                                            {Object.entries(selected.styles).map(([k, v]) =>
                                                v ? (
                                                    <div key={k} className="flex justify-between">
                                                        <span className="text-zinc-500">{k}:</span>
                                                        <span className="text-zinc-200 font-mono truncate ml-1" title={String(v)}>
                                                            {String(v).slice(0, 20)}
                                                        </span>
                                                    </div>
                                                ) : null,
                                            )}
                                        </div>
                                        {/* Color preview */}
                                        {selected.styles.color && (
                                            <div className="flex items-center gap-2 mt-2">
                                                <div
                                                    className="w-4 h-4 rounded border border-zinc-700"
                                                    style={{ backgroundColor: selected.styles.color }}
                                                />
                                                <span className="text-[10px] text-zinc-500">color</span>
                                                {selected.styles.backgroundColor && (
                                                    <>
                                                        <div
                                                            className="w-4 h-4 rounded border border-zinc-700"
                                                            style={{ backgroundColor: selected.styles.backgroundColor }}
                                                        />
                                                        <span className="text-[10px] text-zinc-500">bg</span>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                                {/* Add to chat */}
                                <button
                                    onClick={() => {
                                        const ctx = `[${selected.tag}] selector="${selected.selector}"${selected.styles?.fontSize ? ` fontSize=${selected.styles.fontSize}` : ""}${selected.styles?.color ? ` color=${selected.styles.color}` : ""} — `;
                                        setChatInput((prev) => prev + ctx);
                                        const chatEl = document.querySelector<HTMLInputElement>('input[placeholder="Ask about the UI…"]');
                                        chatEl?.focus();
                                    }}
                                    className="mt-3 w-full px-2 py-1.5 rounded text-[11px] font-bold bg-sky-700/30 hover:bg-sky-700/50 border border-sky-800 text-sky-200 transition"
                                >
                                    + Add to Chat
                                </button>
                            </div>
                        )}

                        {/* Element list */}
                        <div className="p-4">
                            <div className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-3">
                                Detected Elements ({mapped.length})
                            </div>
                            <div className="space-y-1.5">
                                {mapped.map((m, i) => {
                                    const isSelected = selectedIdx === i;
                                    const isHovered = hoveredIdx === i;
                                    const color = COLORS[i % COLORS.length];
                                    return (
                                        <button
                                            key={i}
                                            onClick={() => setSelectedIdx(isSelected ? null : i)}
                                            onMouseEnter={() => setHoveredIdx(i)}
                                            onMouseLeave={() => setHoveredIdx(null)}
                                            className={`w-full text-left px-2.5 py-2 rounded text-xs transition-all ${
                                                isSelected
                                                    ? "bg-fuchsia-950/40 border border-fuchsia-700"
                                                    : isHovered
                                                      ? "bg-zinc-800 border border-zinc-700"
                                                      : "border border-transparent hover:bg-zinc-800/50"
                                            }`}
                                        >
                                            <div className="flex items-center gap-2">
                                                <div
                                                    className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                                                    style={{ backgroundColor: color }}
                                                />
                                                <span className="text-zinc-100 font-mono">
                                                    &lt;{m.tag}&gt;
                                                </span>
                                                <span className="text-emerald-300 font-bold ml-auto">
                                                    {(m.confidence * 100).toFixed(0)}%
                                                </span>
                                            </div>
                                            <div className="text-[10px] text-zinc-500 font-mono truncate mt-0.5 pl-[18px]">
                                                {m.selector}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* HTML panel */}
                        {showHtml && result.html && (
                            <div className="p-4 border-t border-zinc-800">
                                <div className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-2">
                                    Page HTML ({(result.html.length / 1024).toFixed(0)} KB)
                                </div>
                                <pre className="text-[10px] text-zinc-400 font-mono bg-zinc-950 border border-zinc-800 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">
                                    {result.html.slice(0, 50000)}
                                </pre>
                            </div>
                        )}

                        {/* Chat panel */}
                        <div className="border-t border-zinc-800 flex flex-col" style={{ minHeight: "200px" }}>
                            <div className="px-4 pt-3 pb-1">
                                <div className="text-xs font-bold uppercase tracking-wider text-sky-300">
                                    Chat
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto px-4 space-y-2 max-h-64">
                                {chatMessages.length === 0 && (
                                    <div className="text-[11px] text-zinc-600 italic py-2">
                                        Ask about any element: &quot;label the center title&quot;, &quot;what font is the signup button?&quot;, &quot;make the header background darker&quot;
                                    </div>
                                )}
                                {chatMessages.map((msg, i) => (
                                    <div
                                        key={i}
                                        className={`text-xs leading-relaxed rounded px-2.5 py-2 ${
                                            msg.role === "user"
                                                ? "bg-sky-950/40 border border-sky-900/50 text-sky-100"
                                                : "bg-zinc-800 border border-zinc-700 text-zinc-200"
                                        }`}
                                    >
                                        <div className="text-[9px] text-zinc-500 mb-0.5 uppercase font-bold">
                                            {msg.role === "user" ? "You" : "Vision Inspector"}
                                        </div>
                                        <div className="whitespace-pre-wrap">{msg.content}</div>
                                    </div>
                                ))}
                                {chatLoading && (
                                    <div className="text-xs text-zinc-500 flex items-center gap-2 py-1">
                                        <div className="animate-spin w-3 h-3 border border-sky-500 border-t-transparent rounded-full" />
                                        Thinking…
                                    </div>
                                )}
                                <div ref={chatEndRef} />
                            </div>
                            <div className="p-3 border-t border-zinc-800">
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={chatInput}
                                        onChange={(e) => setChatInput(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendChat()}
                                        placeholder="Ask about the UI…"
                                        className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs focus:border-sky-500 focus:outline-none"
                                        disabled={chatLoading}
                                    />
                                    <button
                                        onClick={sendChat}
                                        disabled={chatLoading || !chatInput.trim()}
                                        className="px-4 py-2 rounded-lg text-xs font-bold bg-sky-600 hover:bg-sky-500 disabled:opacity-40 transition"
                                    >
                                        Send
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Empty state */}
            {!result && !loading && !error && (
                <div className="flex-1 flex items-center justify-center text-zinc-600">
                    <div className="text-center space-y-2">
                        <div className="text-4xl">🔍</div>
                        <div className="text-sm">Enter a URL and click Inspect</div>
                        <div className="text-xs text-zinc-700">
                            Screenshots the page, detects UI elements via OmniParser,
                            <br />
                            maps them to DOM selectors, and shows computed styles.
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
}

// ── Canvas drawing ──

function drawFrame(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    mapped: MappedElement[],
    hoveredIdx: number | null,
    selectedIdx: number | null,
    showLabels: boolean,
    drawStart: { x: number; y: number } | null,
    drawEnd: { x: number; y: number } | null,
    drawMatch: { x1: number; y1: number; x2: number; y2: number; tag: string; selector: string } | null,
    savedLabels?: { name: string; match: { x1: number; y1: number; x2: number; y2: number }; color: string }[],
) {
    ctx.drawImage(img, 0, 0);

    // OmniParser detections
    for (let i = 0; i < mapped.length; i++) {
        const m = mapped[i];
        const b = m.bbox_px;
        const color = COLORS[i % COLORS.length];
        const isHovered = hoveredIdx === i;
        const isSelected = selectedIdx === i;
        const lineWidth = isSelected ? 4 : isHovered ? 3 : 2;
        const alpha = isSelected || isHovered ? 0.25 : 0.08;

        ctx.fillStyle = color + Math.round(alpha * 255).toString(16).padStart(2, "0");
        ctx.fillRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);

        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);

        if (showLabels || isHovered || isSelected) {
            const label = `<${m.tag}> ${(m.confidence * 100).toFixed(0)}%`;
            ctx.font = "bold 11px monospace";
            const tw = ctx.measureText(label).width;
            const lx = b.x1;
            const ly = Math.max(0, b.y1 - 16);
            ctx.fillStyle = color;
            ctx.fillRect(lx, ly, tw + 6, 15);
            ctx.fillStyle = "#fff";
            ctx.fillText(label, lx + 3, ly + 11);
        }
    }

    // Draw-to-select rectangle
    if (drawStart && drawEnd) {
        const dx = Math.min(drawStart.x, drawEnd.x);
        const dy = Math.min(drawStart.y, drawEnd.y);
        const dw = Math.abs(drawEnd.x - drawStart.x);
        const dh = Math.abs(drawEnd.y - drawStart.y);

        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2;
        ctx.strokeRect(dx, dy, dw, dh);
        ctx.setLineDash([]);

        ctx.fillStyle = "rgba(251, 191, 36, 0.1)";
        ctx.fillRect(dx, dy, dw, dh);
    }

    // Draw match highlight
    if (drawMatch) {
        const { x1, y1, x2, y2 } = drawMatch;
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 3;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.fillStyle = "rgba(251, 191, 36, 0.15)";
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);

        const label = `<${drawMatch.tag}> ${drawMatch.selector.slice(0, 30)}`;
        ctx.font = "bold 12px monospace";
        const tw = ctx.measureText(label).width;
        const ly = Math.max(0, y1 - 20);
        ctx.fillStyle = "#fbbf24";
        ctx.fillRect(x1, ly, tw + 8, 18);
        ctx.fillStyle = "#000";
        ctx.fillText(label, x1 + 4, ly + 13);
    }

    // Saved labels — drawn LAST so they render on top of everything
    if (savedLabels && savedLabels.length > 0) {
        for (const sl of savedLabels) {
            const { x1, y1, x2, y2 } = sl.match;
            const w = x2 - x1;
            const h = y2 - y1;
            if (w < 2 || h < 2) continue;

            // Orange bounding box — like a real detection bbox
            ctx.fillStyle = "rgba(255, 165, 0, 0.18)";
            ctx.fillRect(x1, y1, w, h);

            // Thick orange border
            ctx.strokeStyle = "#ff8c00";
            ctx.lineWidth = 4;
            ctx.strokeRect(x1, y1, w, h);
            // White inner border for contrast
            ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
            ctx.lineWidth = 2;
            ctx.strokeRect(x1 + 2, y1 + 2, w - 4, h - 4);

            // Orange label badge above the box
            ctx.font = "bold 14px monospace";
            const tw = ctx.measureText(sl.name).width;
            const ly = Math.max(0, y1 - 26);
            ctx.fillStyle = "#ff8c00";
            ctx.fillRect(x1, ly, tw + 12, 22);
            ctx.fillStyle = "#000";
            ctx.fillText(sl.name, x1 + 6, ly + 16);
        }
    }
}
