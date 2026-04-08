"use client";

import { cn } from "@/lib/utils";
import type { Bbox, BboxVerdict } from "@/lib/types";

export const QUERY_COLORS: Record<string, string> = {
    "fiber optic spool": "#22c55e",   // green
    spool: "#10b981",                 // emerald
    "cable spool": "#06b6d4",         // cyan
    drone: "#3b82f6",                 // blue
    quadcopter: "#6366f1",            // indigo
    "fiber optic drone": "#84cc16",   // lime
    cable: "#f59e0b",                 // amber
    cylinder: "#ec4899",              // pink
    objects: "#a3a3a3",               // neutral
};

export function colorForQuery(q: string): string {
    return QUERY_COLORS[q] ?? "#ef4444";
}

export type AnnotatedBbox = Bbox & {
    query: string;
    verdict?: BboxVerdict;                          // human verdict
    vlm_verdict?: "YES" | "NO" | "UNSURE";         // Qwen VLM verdict
    vlm_reasoning?: string;
    idx: number;
};

type Props = {
    src: string;
    width: number;
    height: number;
    bboxes: AnnotatedBbox[];
    activeIdx?: number | null;
    onBboxClick?: (idx: number) => void;
    showLabels?: boolean;
};

/**
 * Image with overlaid bboxes. Bboxes are positioned with absolute % coords
 * so they scale automatically with the image's display size.
 */
export function BboxOverlay({
    src,
    width,
    height,
    bboxes,
    activeIdx = null,
    onBboxClick,
    showLabels = true,
}: Props) {
    return (
        <div className="relative w-full" style={{ aspectRatio: `${width} / ${height}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={src}
                alt=""
                className="absolute inset-0 h-full w-full object-contain"
                draggable={false}
            />
            {bboxes.map((b) => {
                const queryColor = colorForQuery(b.query);
                const isActive = activeIdx === b.idx;
                const human = b.verdict;
                const vlm = b.vlm_verdict;

                // Border style: VLM=NO uses dashed red, VLM=YES uses solid query color,
                // human verdict overrides VLM
                let borderStyle = `2px solid ${queryColor}`;
                let opacity = 1;
                if (human === "rejected") {
                    borderStyle = `2px dashed #ef4444`;
                    opacity = 0.35;
                } else if (human === "approved") {
                    borderStyle = `3px solid #10b981`;
                } else if (vlm === "NO") {
                    borderStyle = `2px dashed #f87171`;
                    opacity = 0.5;
                } else if (vlm === "YES") {
                    borderStyle = `2px solid ${queryColor}`;
                }

                const title = [
                    b.query,
                    vlm ? `Qwen: ${vlm}` : null,
                    b.vlm_reasoning ? `(${b.vlm_reasoning})` : null,
                    human ? `Human: ${human}` : null,
                ].filter(Boolean).join(" — ");

                return (
                    <div
                        key={b.idx}
                        className={cn(
                            "absolute cursor-pointer transition-all",
                            isActive && "ring-4 ring-white",
                        )}
                        style={{
                            left: `${b.x1_norm * 100}%`,
                            top: `${b.y1_norm * 100}%`,
                            width: `${(b.x2_norm - b.x1_norm) * 100}%`,
                            height: `${(b.y2_norm - b.y1_norm) * 100}%`,
                            border: borderStyle,
                            backgroundColor: human === "rejected" || vlm === "NO" ? "#00000010" : `${queryColor}10`,
                            opacity,
                        }}
                        onClick={(e) => {
                            e.stopPropagation();
                            onBboxClick?.(b.idx);
                        }}
                        title={title}
                    >
                        {showLabels && (
                            <span
                                className="absolute -top-5 left-0 whitespace-nowrap px-1 py-px text-[10px] font-bold text-black"
                                style={{ backgroundColor: queryColor }}
                            >
                                {b.query}
                                {vlm === "YES" && " ✓"}
                                {vlm === "NO" && " ✗"}
                                {human === "approved" && " 👤✓"}
                                {human === "rejected" && " 👤✗"}
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
