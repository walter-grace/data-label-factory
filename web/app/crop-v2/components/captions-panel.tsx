"use client";

import {
    AlignCenter,
    AlignEndVertical,
    AlignStartVertical,
    ArrowDown,
    ArrowUp,
    Bold,
    Loader2,
    Mic,
    Move,
    RotateCcw,
    Sparkles,
    Type,
    Wand2,
    Flame,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
    CAPTION_PRESETS,
    DEFAULT_CAPTION_STYLE,
    type CaptionBackground,
    type CaptionFont,
    type CaptionMode,
    type CaptionPosition,
    type CaptionStyle,
} from "../lib/captions";

type Props = {
    style: CaptionStyle;
    onChange: (next: CaptionStyle) => void;
    transcriptAvailable: boolean;
    transcribing: boolean;
    segmentCount: number;
    onFetchTranscript: () => void;
    onBake?: () => void;
    baking?: boolean;
    disabled?: boolean;
};

const FONT_OPTIONS: { id: CaptionFont; label: string }[] = [
    { id: "arial", label: "Arial" },
    { id: "helvetica", label: "Helvetica" },
    { id: "impact", label: "Impact" },
    { id: "montserrat", label: "Montserrat" },
    { id: "mono", label: "Mono" },
];

const POSITION_OPTIONS: {
    id: CaptionPosition;
    label: string;
    icon: React.ReactNode;
}[] = [
    { id: "top", label: "Top", icon: <AlignStartVertical className="size-3" /> },
    { id: "middle", label: "Middle", icon: <AlignCenter className="size-3" /> },
    {
        id: "bottom",
        label: "Bottom",
        icon: <AlignEndVertical className="size-3" />,
    },
];

const BACKGROUND_OPTIONS: { id: CaptionBackground; label: string }[] = [
    { id: "none", label: "None" },
    { id: "box", label: "Box" },
    { id: "shadow", label: "Shadow" },
];

const MODE_OPTIONS: { id: CaptionMode; label: string }[] = [
    { id: "line", label: "Line" },
    { id: "word", label: "One word" },
];

// Resolve current effective Y (0..1) for display next to the nudge
// buttons — either the explicit positionY or the derived top/middle/bottom.
function currentY(style: CaptionStyle): number {
    if (typeof style.positionY === "number") return style.positionY;
    if (style.position === "top") return 0.1;
    if (style.position === "middle") return 0.5;
    return 0.9;
}

export function CaptionsPanel({
    style,
    onChange,
    transcriptAvailable,
    transcribing,
    segmentCount,
    onFetchTranscript,
    onBake,
    baking,
    disabled,
}: Props) {
    const patch = (p: Partial<CaptionStyle>) => onChange({ ...style, ...p });

    const applyPreset = (key: string) => {
        const preset = CAPTION_PRESETS[key];
        if (!preset) return;
        // Preserve `enabled` from current state so picking a preset
        // doesn't silently toggle captions off/on.
        onChange({ ...preset, enabled: style.enabled || preset.enabled });
    };

    const reset = () => onChange({ ...DEFAULT_CAPTION_STYLE, enabled: style.enabled });

    return (
        <div
            className={cn(
                "flex flex-col gap-4 p-4 rounded-2xl bg-white/[0.03] border border-white/10",
                disabled && "opacity-60 pointer-events-none",
            )}
        >
            {/* Header + enable toggle */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="size-7 rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 grid place-items-center">
                        <Type className="size-3.5 text-black" />
                    </div>
                    <div>
                        <div className="text-[13px] font-semibold text-zinc-100 leading-tight">
                            Captions
                        </div>
                        <div className="text-[10px] text-zinc-500 leading-tight">
                            Live preview · burn when ready
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {transcriptAvailable && (
                        <Badge
                            variant="outline"
                            className="text-[9px] h-5 bg-emerald-500/10 border-emerald-400/40 text-emerald-200"
                        >
                            {segmentCount} seg
                        </Badge>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={reset}
                        className="h-7 px-2 text-[10px] gap-1 text-zinc-400 hover:text-zinc-100"
                    >
                        <RotateCcw className="size-3" />
                        Reset
                    </Button>
                </div>
            </div>

            {/* Enable + transcribe row */}
            <div className="flex items-center gap-2">
                <button
                    onClick={() => patch({ enabled: !style.enabled })}
                    className={cn(
                        "flex-1 rounded-lg border px-3 py-2 text-[11px] font-medium transition flex items-center justify-center gap-2",
                        style.enabled
                            ? "bg-emerald-400/15 border-emerald-400/60 text-emerald-200"
                            : "bg-white/[0.03] border-white/10 text-zinc-400 hover:border-white/20 hover:text-zinc-100",
                    )}
                >
                    <Sparkles className="size-3" />
                    {style.enabled ? "Captions ON" : "Show captions"}
                </button>
                {!transcriptAvailable && (
                    <Button
                        size="sm"
                        onClick={onFetchTranscript}
                        disabled={transcribing}
                        className="h-8 gap-1.5 bg-cyan-500 hover:bg-cyan-400 text-black text-[11px]"
                    >
                        {transcribing ? (
                            <>
                                <Loader2 className="size-3 animate-spin" />
                                Transcribing…
                            </>
                        ) : (
                            <>
                                <Mic className="size-3" />
                                Transcribe
                            </>
                        )}
                    </Button>
                )}
            </div>

            {/* Presets */}
            <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">
                    Presets
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                    {Object.keys(CAPTION_PRESETS).map((key) => (
                        <button
                            key={key}
                            onClick={() => applyPreset(key)}
                            className={cn(
                                "rounded-lg border p-1.5 text-[10px] transition capitalize",
                                "border-white/10 bg-white/[0.03] text-zinc-300",
                                "hover:border-cyan-400/60 hover:text-cyan-200",
                            )}
                        >
                            {key}
                        </button>
                    ))}
                </div>
            </div>

            {/* Mode: Line vs One word */}
            <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">
                    Mode
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                    {MODE_OPTIONS.map((m) => (
                        <button
                            key={m.id}
                            onClick={() => patch({ mode: m.id })}
                            className={cn(
                                "rounded-lg border p-2 text-[11px] font-medium transition",
                                style.mode === m.id
                                    ? "border-fuchsia-400/70 bg-fuchsia-400/10 text-fuchsia-200"
                                    : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-100",
                            )}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Font */}
            <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">
                    Font
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                    {FONT_OPTIONS.map((f) => (
                        <button
                            key={f.id}
                            onClick={() => patch({ font: f.id })}
                            className={cn(
                                "rounded-lg border p-1.5 text-[10px] transition",
                                style.font === f.id
                                    ? "border-cyan-400/70 bg-cyan-400/10 text-cyan-200"
                                    : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-100",
                            )}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Size + Outline sliders */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <RangeSlider
                    label="Size"
                    min={16}
                    max={96}
                    step={1}
                    value={style.size}
                    onChange={(v) => patch({ size: v })}
                    display={`${style.size}px`}
                />
                <RangeSlider
                    label="Outline"
                    min={0}
                    max={12}
                    step={1}
                    value={style.outlineWidth}
                    onChange={(v) => patch({ outlineWidth: v })}
                    display={`${style.outlineWidth}`}
                />
                <RangeSlider
                    label="Margin"
                    min={0}
                    max={300}
                    step={5}
                    value={style.marginY}
                    onChange={(v) => patch({ marginY: v })}
                    display={`${style.marginY}px`}
                />
                <RangeSlider
                    label="Max words"
                    min={1}
                    max={10}
                    step={1}
                    value={style.maxWordsPerLine}
                    onChange={(v) => patch({ maxWordsPerLine: v })}
                    display={`${style.maxWordsPerLine}`}
                    disabled={style.mode === "word"}
                />
            </div>

            {/* Colors */}
            <div className="grid grid-cols-3 gap-2">
                <ColorPick
                    label="Text"
                    value={style.color}
                    onChange={(v) => patch({ color: v })}
                />
                <ColorPick
                    label="Outline"
                    value={style.outlineColor}
                    onChange={(v) => patch({ outlineColor: v })}
                />
                <ColorPick
                    label="Highlight"
                    value={style.highlightColor}
                    onChange={(v) => patch({ highlightColor: v })}
                />
            </div>

            {/* Position */}
            <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2 flex items-center justify-between">
                    <span>Position</span>
                    {(style.positionX !== undefined ||
                        style.positionY !== undefined) && (
                        <button
                            onClick={() =>
                                patch({
                                    positionX: undefined,
                                    positionY: undefined,
                                })
                            }
                            className="normal-case tracking-normal text-[9px] text-zinc-400 hover:text-cyan-300 transition"
                        >
                            Reset position
                        </button>
                    )}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                    {POSITION_OPTIONS.map((p) => (
                        <button
                            key={p.id}
                            onClick={() =>
                                patch({
                                    position: p.id,
                                    // Clear explicit overrides so the radio group takes over.
                                    positionX: undefined,
                                    positionY: undefined,
                                })
                            }
                            className={cn(
                                "rounded-lg border p-1.5 text-[10px] transition flex items-center justify-center gap-1",
                                style.position === p.id &&
                                    style.positionY === undefined
                                    ? "border-cyan-400/70 bg-cyan-400/10 text-cyan-200"
                                    : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-100",
                            )}
                        >
                            {p.icon}
                            {p.label}
                        </button>
                    ))}
                </div>
                {/* Nudge up/down by 5% */}
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <button
                        onClick={() => {
                            const cur = currentY(style);
                            const next = Math.max(0.02, Math.min(0.98, cur - 0.05));
                            patch({ positionY: next });
                        }}
                        className="rounded-lg border border-white/10 bg-white/[0.03] p-1.5 text-[10px] text-zinc-300 hover:border-cyan-400/60 hover:text-cyan-200 transition flex items-center justify-center gap-1"
                        title="Nudge caption up 5%"
                    >
                        <ArrowUp className="size-3" />
                        Nudge up
                    </button>
                    <button
                        onClick={() => {
                            const cur = currentY(style);
                            const next = Math.max(0.02, Math.min(0.98, cur + 0.05));
                            patch({ positionY: next });
                        }}
                        className="rounded-lg border border-white/10 bg-white/[0.03] p-1.5 text-[10px] text-zinc-300 hover:border-cyan-400/60 hover:text-cyan-200 transition flex items-center justify-center gap-1"
                        title="Nudge caption down 5%"
                    >
                        <ArrowDown className="size-3" />
                        Nudge down
                    </button>
                </div>
                <div className="mt-1.5 flex items-center gap-1 text-[9px] text-zinc-500">
                    <Move className="size-3" />
                    Drag the caption on the video to reposition.
                </div>
            </div>

            {/* Background */}
            <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">
                    Background
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                    {BACKGROUND_OPTIONS.map((b) => (
                        <button
                            key={b.id}
                            onClick={() => patch({ background: b.id })}
                            className={cn(
                                "rounded-lg border p-1.5 text-[10px] transition",
                                style.background === b.id
                                    ? "border-cyan-400/70 bg-cyan-400/10 text-cyan-200"
                                    : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-100",
                            )}
                        >
                            {b.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Toggles */}
            <div className="flex gap-2">
                <ToggleChip
                    active={style.uppercase}
                    onClick={() => patch({ uppercase: !style.uppercase })}
                    label="UPPER"
                />
                <ToggleChip
                    active={style.bold}
                    onClick={() => patch({ bold: !style.bold })}
                    icon={<Bold className="size-3" />}
                    label="Bold"
                />
                <ToggleChip
                    active={style.highlightMode === "word"}
                    onClick={() =>
                        patch({
                            highlightMode:
                                style.highlightMode === "word" ? "none" : "word",
                        })
                    }
                    icon={<Wand2 className="size-3" />}
                    label="Word pop"
                />
            </div>

            {/* Burn button */}
            {onBake && (
                <Button
                    onClick={onBake}
                    disabled={baking || !style.enabled || !transcriptAvailable}
                    className="h-9 gap-1.5 bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-black hover:brightness-110 disabled:opacity-40 disabled:grayscale"
                >
                    {baking ? (
                        <>
                            <Loader2 className="size-3.5 animate-spin" />
                            Burning captions…
                        </>
                    ) : (
                        <>
                            <Flame className="size-3.5" />
                            Burn captions into mp4
                        </>
                    )}
                </Button>
            )}
        </div>
    );
}

/* ---------- helpers ---------- */

function RangeSlider({
    label,
    min,
    max,
    step,
    value,
    onChange,
    display,
    disabled,
}: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    onChange: (v: number) => void;
    display: string;
    disabled?: boolean;
}) {
    return (
        <label
            className={cn(
                "flex flex-col gap-1",
                disabled && "opacity-40 pointer-events-none",
            )}
        >
            <div className="flex items-center gap-1.5 text-[10px]">
                <span className="font-medium text-zinc-300">{label}</span>
                <span className="ml-auto font-mono tabular-nums text-cyan-300">
                    {display}
                </span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(Number(e.target.value))}
                className={cn(
                    "w-full h-1 rounded-full appearance-none cursor-pointer bg-white/10",
                    "[&::-webkit-slider-thumb]:appearance-none",
                    "[&::-webkit-slider-thumb]:size-3",
                    "[&::-webkit-slider-thumb]:rounded-full",
                    "[&::-webkit-slider-thumb]:bg-cyan-400",
                    "[&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.6)]",
                    "[&::-moz-range-thumb]:size-3",
                    "[&::-moz-range-thumb]:rounded-full",
                    "[&::-moz-range-thumb]:bg-cyan-400",
                    "[&::-moz-range-thumb]:border-0",
                )}
            />
        </label>
    );
}

function ColorPick({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
}) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-400">{label}</span>
            <div className="relative flex items-center rounded-lg border border-white/10 bg-white/[0.03] px-2 h-8 overflow-hidden">
                <input
                    type="color"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                />
                <div
                    className="size-4 rounded border border-white/20 shrink-0"
                    style={{ backgroundColor: value }}
                />
                <span className="ml-2 text-[10px] font-mono text-zinc-300">
                    {value.toUpperCase()}
                </span>
            </div>
        </label>
    );
}

function ToggleChip({
    active,
    onClick,
    label,
    icon,
}: {
    active: boolean;
    onClick: () => void;
    label: string;
    icon?: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition flex items-center justify-center gap-1",
                active
                    ? "bg-cyan-400/15 border-cyan-400/60 text-cyan-200"
                    : "bg-white/[0.03] border-white/10 text-zinc-400 hover:border-white/20 hover:text-zinc-100",
            )}
        >
            {icon}
            {label}
        </button>
    );
}
