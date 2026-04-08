"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Bbox } from "@/lib/types";
import {
    fitViewport,
    zoomAt,
    imageToCanvas,
    hitBbox,
    type Viewport,
} from "@/lib/canvas-utils";
import { colorForQuery } from "@/components/BboxOverlay";

type AnnotatedBbox = Bbox & {
    query: string;
    vlm_verdict?: "YES" | "NO" | "UNSURE";
    vlm_reasoning?: string;
    verdict?: "approved" | "rejected" | "unsure";
};

type Props = {
    src: string;
    width: number;            // image native width in pixels
    height: number;           // image native height in pixels
    bboxes: AnnotatedBbox[];
    activeIdx: number | null;
    onBboxClick: (idx: number | null) => void;
    onBboxHover?: (idx: number | null) => void;
    showLabels?: boolean;
    /** Optional fixed canvas display size. If omitted, the canvas fills its parent
     *  width and uses `aspectRatio` to derive the height. */
    canvasWidth?: number;
    canvasHeight?: number;
    /** Aspect ratio (w/h) used when sizing responsively. Default 16/10. */
    aspectRatio?: number;
};

/**
 * Pure HTML5 Canvas bbox renderer + interaction.
 * Single <canvas>, draws image + bboxes in one pass per frame.
 * Mouse wheel = zoom around cursor. Drag = pan. Click = select. Hover = highlight.
 */
export function BboxCanvas({
    src,
    width: imgW,
    height: imgH,
    bboxes,
    activeIdx,
    onBboxClick,
    onBboxHover,
    showLabels = true,
    canvasWidth,
    canvasHeight,
    aspectRatio = 16 / 10,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const vpRef = useRef<Viewport>({ scale: 1, offsetX: 0, offsetY: 0 });
    const [hoverIdx, setHoverIdx] = useState<number | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    // Responsive size: if canvasWidth/Height are not provided, measure container.
    const [size, setSize] = useState<{ w: number; h: number }>(() => ({
        w: canvasWidth ?? 800,
        h: canvasHeight ?? Math.round((canvasWidth ?? 800) / aspectRatio),
    }));

    useEffect(() => {
        if (canvasWidth && canvasHeight) {
            setSize({ w: canvasWidth, h: canvasHeight });
            return;
        }
        const el = containerRef.current;
        if (!el) return;
        const update = () => {
            const w = Math.max(200, Math.floor(el.clientWidth));
            const h = Math.max(150, Math.floor(w / aspectRatio));
            setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, [canvasWidth, canvasHeight, aspectRatio]);

    // Refit viewport when canvas size changes (e.g., window resize)
    useEffect(() => {
        if (imgRef.current) {
            vpRef.current = fitViewport(imgW, imgH, size.w, size.h);
            requestAnimationFrame(draw);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [size.w, size.h]);

    const [pan, setPan] = useState<{ active: boolean; lastX: number; lastY: number }>({
        active: false,
        lastX: 0,
        lastY: 0,
    });

    // Load the image element once.
    // NOTE: we deliberately do NOT set crossOrigin — R2 presigned URLs don't send
    // CORS headers, and setting crossOrigin would block the load. The canvas becomes
    // "tainted" but drawImage still works; we just can't call toDataURL/getImageData
    // (which we don't need for rendering).
    useEffect(() => {
        const img = new window.Image();
        img.src = src;
        img.onload = () => {
            imgRef.current = img;
            // Reset viewport to fit on image change
            vpRef.current = fitViewport(imgW, imgH, size.w, size.h);
            setIsLoaded(true);
            requestAnimationFrame(draw);
        };
        img.onerror = () => {
            setIsLoaded(false);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, imgW, imgH]);

    // Redraw when bboxes / activeIdx / hover change
    useEffect(() => {
        if (isLoaded) requestAnimationFrame(draw);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bboxes, activeIdx, hoverIdx, isLoaded]);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const img = imgRef.current;
        if (!canvas || !img) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const vp = vpRef.current;
        const W = canvas.width;
        const H = canvas.height;

        // Background
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, W, H);

        // Image
        ctx.drawImage(img, vp.offsetX, vp.offsetY, imgW * vp.scale, imgH * vp.scale);

        // Bboxes — draw rejected first (under), then accepted, then highlighted
        const draws = bboxes.map((b, idx) => ({ b, idx }));
        // Sort: rejected first (drawn under), then unverified, then accepted, then active
        draws.sort((a, b) => {
            const sa = sortKey(a.b, a.idx === activeIdx, a.idx === hoverIdx);
            const sb = sortKey(b.b, b.idx === activeIdx, b.idx === hoverIdx);
            return sa - sb;
        });

        for (const { b, idx } of draws) {
            const isHover = idx === hoverIdx;
            const isActive = idx === activeIdx;
            const color = colorForQuery(b.query);
            const human = b.verdict;
            const vlm = b.vlm_verdict;

            // Rectangle in canvas coords
            const { cx: x1, cy: y1 } = imageToCanvas(vp, b.x1, b.y1);
            const { cx: x2, cy: y2 } = imageToCanvas(vp, b.x2, b.y2);
            const rectW = x2 - x1;
            const rectH = y2 - y1;

            // Style
            let strokeStyle = color;
            let lineWidth = 2;
            let fillStyle = `${color}1A`; // ~10% alpha
            ctx.setLineDash([]);

            if (human === "rejected") {
                strokeStyle = "#ef4444";
                lineWidth = 1.5;
                fillStyle = "#00000020";
                ctx.setLineDash([6, 4]);
            } else if (human === "approved") {
                strokeStyle = "#10b981";
                lineWidth = 3;
                fillStyle = `${color}26`; // ~15% alpha
            } else if (vlm === "NO") {
                strokeStyle = "#f87171";
                lineWidth = 1.5;
                fillStyle = "#00000018";
                ctx.setLineDash([5, 3]);
            } else if (vlm === "YES") {
                strokeStyle = color;
                lineWidth = 2;
                fillStyle = `${color}1F`;
            }

            if (isHover && !isActive) {
                lineWidth += 1;
                fillStyle = `${color}33`;
            }
            if (isActive) {
                lineWidth = 4;
                strokeStyle = "#ffffff";
                fillStyle = `${color}40`;
                ctx.setLineDash([]);
            }

            ctx.fillStyle = fillStyle;
            ctx.fillRect(x1, y1, rectW, rectH);
            ctx.strokeStyle = strokeStyle;
            ctx.lineWidth = lineWidth;
            ctx.strokeRect(x1, y1, rectW, rectH);

            // Label (only if showing labels AND bbox is large enough on screen)
            if (showLabels && rectW > 30 && rectH > 14) {
                const label = b.query + (vlm === "YES" ? " ✓" : vlm === "NO" ? " ✗" : "");
                ctx.font = "bold 11px -apple-system, system-ui, sans-serif";
                const metrics = ctx.measureText(label);
                const labelW = metrics.width + 8;
                const labelH = 16;
                const labelY = y1 - labelH;
                if (labelY > 0) {
                    ctx.fillStyle = strokeStyle;
                    ctx.fillRect(x1, labelY, labelW, labelH);
                    ctx.fillStyle = "#000000";
                    ctx.fillText(label, x1 + 4, labelY + 12);
                }
            }
        }

        // Bottom-right HUD: zoom % and bbox count
        ctx.font = "11px monospace";
        ctx.fillStyle = "#ffffff90";
        const hud = `${(vp.scale * 100).toFixed(0)}% zoom · ${bboxes.length} bboxes${hoverIdx !== null ? ` · #${hoverIdx + 1}` : ""}`;
        ctx.fillText(hud, 8, H - 8);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bboxes, activeIdx, hoverIdx, imgW, imgH, showLabels]);

    // Mouse handlers
    const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        if (pan.active) {
            const dx = cx - pan.lastX;
            const dy = cy - pan.lastY;
            vpRef.current = {
                ...vpRef.current,
                offsetX: vpRef.current.offsetX + dx,
                offsetY: vpRef.current.offsetY + dy,
            };
            setPan({ active: true, lastX: cx, lastY: cy });
            requestAnimationFrame(draw);
            return;
        }
        const idx = hitBbox(bboxes, cx, cy, vpRef.current);
        if (idx !== hoverIdx) {
            setHoverIdx(idx);
            onBboxHover?.(idx);
        }
    }, [bboxes, hoverIdx, onBboxHover, pan, draw]);

    const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        if (e.shiftKey) {
            setPan({ active: true, lastX: cx, lastY: cy });
            return;
        }
        const idx = hitBbox(bboxes, cx, cy, vpRef.current);
        onBboxClick(idx);
    }, [bboxes, onBboxClick]);

    const onMouseUp = useCallback(() => {
        setPan({ active: false, lastX: 0, lastY: 0 });
    }, []);

    // React 19's synthetic onWheel is passive, so e.preventDefault() is a no-op
    // and the page scrolls alongside the zoom. Attach a native non-passive listener.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const handler = (e: WheelEvent) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            vpRef.current = zoomAt(vpRef.current, cx, cy, factor);
            requestAnimationFrame(draw);
        };
        canvas.addEventListener("wheel", handler, { passive: false });
        return () => canvas.removeEventListener("wheel", handler);
    }, [draw]);

    const onDoubleClick = useCallback(() => {
        // Reset viewport
        vpRef.current = fitViewport(imgW, imgH, size.w, size.h);
        requestAnimationFrame(draw);
    }, [imgW, imgH, size.w, size.h, draw]);

    return (
        <div ref={containerRef} className="w-full">
            <canvas
                ref={canvasRef}
                width={size.w}
                height={size.h}
                className="block rounded border border-zinc-800 cursor-crosshair"
                style={{ width: size.w, height: size.h, maxWidth: "100%" }}
                onMouseMove={onMouseMove}
                onMouseDown={onMouseDown}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onDoubleClick={onDoubleClick}
            />
        </div>
    );
}

function sortKey(b: AnnotatedBbox, isActive: boolean, isHover: boolean): number {
    if (isActive) return 4;
    if (isHover) return 3;
    if (b.verdict === "approved") return 2;
    if (b.vlm_verdict === "YES") return 1;
    return 0;
}
