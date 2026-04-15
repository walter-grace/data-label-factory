"use client";

import { useEffect, useState } from "react";

/**
 * Ambient background: faded image cards with bounding box labels,
 * like real detections happening behind the hero text.
 */

type DetectionCard = {
  id: number;
  x: number;
  y: number;
  label: string;
  emoji: string;
  phase: "entering" | "visible" | "exiting";
  rotation: number;
};

const OBJECTS = [
  { label: "stop sign", emoji: "\u{1F6D1}" },
  { label: "drone", emoji: "\u{1F681}" },
  { label: "fire hydrant", emoji: "\u{1F6D2}" },
  { label: "bird", emoji: "\u{1F426}" },
  { label: "car", emoji: "\u{1F697}" },
  { label: "dog", emoji: "\u{1F415}" },
  { label: "cat", emoji: "\u{1F408}" },
  { label: "bicycle", emoji: "\u{1F6B2}" },
  { label: "bottle", emoji: "\u{1F37E}" },
  { label: "laptop", emoji: "\u{1F4BB}" },
  { label: "phone", emoji: "\u{1F4F1}" },
  { label: "umbrella", emoji: "\u{2602}" },
  { label: "backpack", emoji: "\u{1F392}" },
  { label: "clock", emoji: "\u{1F570}" },
  { label: "chair", emoji: "\u{1FA91}" },
  { label: "pizza", emoji: "\u{1F355}" },
];

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

export default function HeroAnimation() {
  const [cards, setCards] = useState<DetectionCard[]>([]);

  useEffect(() => {
    // Use seeded random for consistent SSR/client
    const rng = seededRandom(42);
    const initial: DetectionCard[] = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      x: 2 + rng() * 85,
      y: 2 + rng() * 75,
      label: OBJECTS[i % OBJECTS.length].label,
      emoji: OBJECTS[i % OBJECTS.length].emoji,
      phase: "visible" as const,
      rotation: (rng() - 0.5) * 8,
    }));
    setCards(initial);

    let nextId = initial.length;
    const interval = setInterval(() => {
      setCards((prev) => {
        // Cycle one card out and a new one in
        const exitIdx = nextId % prev.length;
        const objIdx = nextId % OBJECTS.length;
        const r = Math.random;
        return prev.map((card, i) => {
          if (i === exitIdx) {
            return {
              id: nextId++,
              x: 2 + r() * 85,
              y: 2 + r() * 75,
              label: OBJECTS[objIdx].label,
              emoji: OBJECTS[objIdx].emoji,
              phase: "entering" as const,
              rotation: (r() - 0.5) * 8,
            };
          }
          if (card.phase === "entering") return { ...card, phase: "visible" as const };
          return card;
        });
      });
    }, 2500);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" suppressHydrationWarning>
      {/* Subtle grid */}
      <div className="absolute inset-0 opacity-[0.02]" style={{
        backgroundImage: "linear-gradient(rgba(96,165,250,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,0.4) 1px, transparent 1px)",
        backgroundSize: "80px 80px",
      }} />

      {/* Detection cards */}
      {cards.map((card) => (
        <div
          key={card.id}
          className="absolute transition-all duration-1000"
          style={{
            left: `${card.x}%`,
            top: `${card.y}%`,
            opacity: card.phase === "entering" ? 0 : card.phase === "visible" ? 1 : 0,
            transform: `rotate(${card.rotation}deg) scale(${card.phase === "entering" ? 0.8 : 1})`,
          }}
        >
          {/* Image-like card with emoji content */}
          <div className="relative w-20 h-16 rounded-lg bg-zinc-800/40 border border-zinc-700/20 overflow-hidden backdrop-blur-sm">
            {/* Faded "image" content */}
            <div className="absolute inset-0 flex items-center justify-center text-3xl opacity-20">
              {card.emoji}
            </div>

            {/* Bbox overlay */}
            <div className="absolute inset-1 rounded-sm border border-blue-400/30">
              <div className="absolute top-0 left-0 h-1 w-1 border-t border-l border-blue-400/50" />
              <div className="absolute top-0 right-0 h-1 w-1 border-t border-r border-blue-400/50" />
              <div className="absolute bottom-0 left-0 h-1 w-1 border-b border-l border-blue-400/50" />
              <div className="absolute bottom-0 right-0 h-1 w-1 border-b border-r border-blue-400/50" />
            </div>

            {/* Label tag */}
            <div className="absolute -top-3.5 left-0.5 rounded-sm bg-blue-500/20 px-1 py-[1px] text-[7px] font-mono text-blue-400/50 whitespace-nowrap">
              {card.label}
            </div>

            {/* Confidence score */}
            <div className="absolute bottom-0.5 right-0.5 text-[6px] font-mono text-emerald-400/30">
              0.{85 + (card.id % 14)}
            </div>
          </div>
        </div>
      ))}

      {/* Radial fade for readability */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(9,9,11,0.85)_0%,rgba(9,9,11,0.4)_60%,rgba(9,9,11,0.2)_100%)]" />
    </div>
  );
}
