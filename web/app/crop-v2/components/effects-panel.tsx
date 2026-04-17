"use client";

import {
    Contrast,
    Droplets,
    Flame,
    RotateCcw,
    Sparkles,
    Sun,
    Thermometer,
    Trash2,
    Wand2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
    DEFAULT_EFFECTS,
    type CanvasEffects,
    type CanvasFilter,
    type Sticker,
} from "../lib/effects";

const STICKER_EMOJIS = ["🔥", "💯", "🤯", "😂", "👀", "🎯", "💀", "🚀"];

const FILTERS: { id: CanvasFilter; label: string; swatch: string }[] = [
    { id: "none", label: "None", swatch: "bg-zinc-600" },
    { id: "bw", label: "B&W", swatch: "bg-gradient-to-br from-zinc-200 to-zinc-700" },
    { id: "sepia", label: "Sepia", swatch: "bg-gradient-to-br from-amber-200 to-amber-800" },
    { id: "vintage", label: "Vintage", swatch: "bg-gradient-to-br from-yellow-300 to-rose-600" },
    { id: "duotone", label: "Duotone", swatch: "bg-gradient-to-br from-teal-400 to-rose-400" },
    { id: "invert", label: "Invert", swatch: "bg-gradient-to-br from-fuchsia-500 to-cyan-400" },
];

type Props = {
    effects: CanvasEffects;
    onChange: (next: CanvasEffects) => void;
    currentTime: number;
    disabled?: boolean;
    fps?: number;
};

export function EffectsPanel({
    effects,
    onChange,
    currentTime,
    disabled,
    fps,
}: Props) {
    const patch = (p: Partial<CanvasEffects>) => onChange({ ...effects, ...p });

    const addSticker = (emoji: string) => {
        const s: Sticker = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            emoji,
            t: Math.max(0, currentTime),
            duration: 2.5,
            x: 0.5,
            y: 0.25,
        };
        patch({ stickers: [...effects.stickers, s] });
    };

    const removeSticker = (id: string) => {
        patch({ stickers: effects.stickers.filter((s) => s.id !== id) });
    };

    const resetAll = () => onChange(DEFAULT_EFFECTS);

    return (
        <div
            className={cn(
                "flex flex-col gap-4 p-4 rounded-2xl bg-white/[0.03] border border-white/10",
                disabled && "opacity-60 pointer-events-none",
            )}
        >
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="size-7 rounded-lg bg-gradient-to-br from-fuchsia-500 to-amber-400 grid place-items-center">
                        <Wand2 className="size-3.5 text-black" />
                    </div>
                    <div>
                        <div className="text-[13px] font-semibold text-zinc-100 leading-tight">
                            Live Effects
                        </div>
                        <div className="text-[10px] text-zinc-500 leading-tight">
                            Instant canvas preview · no re-encode
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {fps != null && (
                        <Badge
                            variant="outline"
                            className="text-[9px] h-5 font-mono bg-black/30 border-white/15 text-zinc-300"
                        >
                            {fps.toFixed(0)} fps
                        </Badge>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={resetAll}
                        className="h-7 px-2 text-[10px] gap-1 text-zinc-400 hover:text-zinc-100"
                    >
                        <RotateCcw className="size-3" />
                        Reset
                    </Button>
                </div>
            </div>

            {/* Color sliders */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <ColorSlider
                    icon={<Sun className="size-3" />}
                    label="Exposure"
                    value={effects.exposure}
                    onChange={(v) => patch({ exposure: v })}
                />
                <ColorSlider
                    icon={<Contrast className="size-3" />}
                    label="Contrast"
                    value={effects.contrast}
                    onChange={(v) => patch({ contrast: v })}
                />
                <ColorSlider
                    icon={<Droplets className="size-3" />}
                    label="Saturation"
                    value={effects.saturation}
                    onChange={(v) => patch({ saturation: v })}
                />
                <ColorSlider
                    icon={<Thermometer className="size-3" />}
                    label="Warmth"
                    value={effects.warmth}
                    onChange={(v) => patch({ warmth: v })}
                />
            </div>

            {/* Filters */}
            <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">
                    Filter
                </div>
                <div className="grid grid-cols-6 gap-1.5">
                    {FILTERS.map((f) => (
                        <button
                            key={f.id}
                            onClick={() => patch({ filter: f.id })}
                            className={cn(
                                "rounded-lg border p-1.5 flex flex-col items-center gap-1 text-[10px] transition",
                                effects.filter === f.id
                                    ? "border-amber-400/70 bg-amber-400/10 text-amber-200"
                                    : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-100",
                            )}
                        >
                            <span
                                className={cn(
                                    "size-5 rounded-md ring-1 ring-white/10",
                                    f.swatch,
                                )}
                            />
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Overlay toggles */}
            <div className="flex gap-2">
                <ToggleChip
                    active={effects.vignette}
                    onClick={() => patch({ vignette: !effects.vignette })}
                    label="Vignette"
                />
                <ToggleChip
                    active={effects.grain}
                    onClick={() => patch({ grain: !effects.grain })}
                    label="Grain"
                />
            </div>

            {/* Emoji stickers */}
            <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2 flex items-center gap-1.5">
                    <Sparkles className="size-3" />
                    Tap to drop at playhead
                    <span className="ml-auto font-mono text-zinc-600">
                        {currentTime.toFixed(1)}s
                    </span>
                </div>
                <div className="grid grid-cols-8 gap-1">
                    {STICKER_EMOJIS.map((e) => (
                        <button
                            key={e}
                            onClick={() => addSticker(e)}
                            className="aspect-square rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/10 hover:border-amber-400/60 text-xl transition active:scale-90"
                        >
                            {e}
                        </button>
                    ))}
                </div>
            </div>

            {/* Sticker list */}
            {effects.stickers.length > 0 && (
                <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2 flex items-center gap-1.5">
                        <Flame className="size-3" />
                        Reactions · {effects.stickers.length}
                    </div>
                    <div className="flex flex-col gap-1">
                        {effects.stickers.map((s) => (
                            <div
                                key={s.id}
                                className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px]"
                            >
                                <span className="text-base">{s.emoji}</span>
                                <span className="font-mono text-zinc-400">
                                    {s.t.toFixed(1)}s
                                </span>
                                <span className="text-zinc-600">
                                    · {s.duration.toFixed(1)}s
                                </span>
                                <div className="flex-1" />
                                <button
                                    onClick={() => removeSticker(s.id)}
                                    className="size-5 rounded-md hover:bg-white/10 text-zinc-500 hover:text-rose-400 grid place-items-center transition"
                                    title="Remove"
                                >
                                    <Trash2 className="size-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function ColorSlider({
    icon,
    label,
    value,
    onChange,
}: {
    icon: React.ReactNode;
    label: string;
    value: number;
    onChange: (v: number) => void;
}) {
    const active = value !== 0;
    return (
        <label className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[10px]">
                <span
                    className={cn(
                        "size-4 rounded grid place-items-center",
                        active ? "text-amber-300" : "text-zinc-500",
                    )}
                >
                    {icon}
                </span>
                <span
                    className={cn(
                        "font-medium",
                        active ? "text-zinc-100" : "text-zinc-400",
                    )}
                >
                    {label}
                </span>
                <span
                    className={cn(
                        "ml-auto font-mono tabular-nums",
                        active ? "text-amber-300" : "text-zinc-600",
                    )}
                >
                    {value > 0 ? `+${value}` : value}
                </span>
            </div>
            <input
                type="range"
                min={-50}
                max={50}
                step={1}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                onDoubleClick={() => onChange(0)}
                className={cn(
                    "w-full h-1 rounded-full appearance-none cursor-pointer",
                    "bg-white/10",
                    "[&::-webkit-slider-thumb]:appearance-none",
                    "[&::-webkit-slider-thumb]:size-3",
                    "[&::-webkit-slider-thumb]:rounded-full",
                    "[&::-webkit-slider-thumb]:bg-amber-400",
                    "[&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.6)]",
                    "[&::-moz-range-thumb]:size-3",
                    "[&::-moz-range-thumb]:rounded-full",
                    "[&::-moz-range-thumb]:bg-amber-400",
                    "[&::-moz-range-thumb]:border-0",
                )}
            />
        </label>
    );
}

function ToggleChip({
    active,
    onClick,
    label,
}: {
    active: boolean;
    onClick: () => void;
    label: string;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "flex-1 rounded-lg border px-3 py-1.5 text-[11px] font-medium transition",
                active
                    ? "bg-amber-400/15 border-amber-400/60 text-amber-200"
                    : "bg-white/[0.03] border-white/10 text-zinc-400 hover:border-white/20 hover:text-zinc-100",
            )}
        >
            {label}
        </button>
    );
}
