"use client";

import { useEffect, useState, useMemo } from "react";

/**
 * Ambient background animation: bounding boxes being drawn and labeled
 * across a grid, like the pipeline is running behind the hero text.
 * Low opacity, purely atmospheric.
 */

type Detection = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  phase: "scan" | "detect" | "verify" | "fade";
};

const LABELS = [
  "stop sign", "drone", "fire hydrant", "bird", "car", "person",
  "bicycle", "dog", "cat", "traffic light", "bottle", "chair",
  "phone", "laptop", "backpack", "umbrella", "handbag", "clock",
];

function randomDetection(id: number): Detection {
  return {
    id,
    x: 5 + Math.random() * 80,
    y: 5 + Math.random() * 80,
    w: 8 + Math.random() * 18,
    h: 8 + Math.random() * 18,
    label: LABELS[Math.floor(Math.random() * LABELS.length)],
    phase: "scan",
  };
}

export default function HeroAnimation() {
  const [detections, setDetections] = useState<Detection[]>([]);

  useEffect(() => {
    // Seed initial detections
    const initial = Array.from({ length: 6 }, (_, i) => randomDetection(i));
    setDetections(initial);

    let nextId = initial.length;

    const interval = setInterval(() => {
      setDetections((prev) => {
        const updated = prev.map((d) => {
          if (d.phase === "scan") return { ...d, phase: "detect" as const };
          if (d.phase === "detect") return { ...d, phase: "verify" as const };
          if (d.phase === "verify") return { ...d, phase: "fade" as const };
          return d;
        });

        // Remove faded, add new
        const alive = updated.filter((d) => d.phase !== "fade");
        while (alive.length < 6) {
          alive.push(randomDetection(nextId++));
        }
        return alive;
      });
    }, 1800);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Grid lines */}
      <div className="absolute inset-0 opacity-[0.03]">
        <div className="h-full w-full" style={{
          backgroundImage: "linear-gradient(rgba(96,165,250,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,0.3) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
        }} />
      </div>

      {/* Detections */}
      {detections.map((d) => (
        <div
          key={d.id}
          className="absolute transition-all duration-700"
          style={{
            left: `${d.x}%`,
            top: `${d.y}%`,
            width: `${d.w}%`,
            height: `${d.h}%`,
            opacity: d.phase === "scan" ? 0 : d.phase === "fade" ? 0 : 1,
          }}
        >
          {/* Bbox */}
          <div
            className="absolute inset-0 rounded-[2px] transition-colors duration-500"
            style={{
              border: `1px solid ${d.phase === "verify" ? "rgba(52,211,153,0.25)" : "rgba(96,165,250,0.2)"}`,
              boxShadow: d.phase === "verify"
                ? "0 0 20px rgba(52,211,153,0.05)"
                : "0 0 20px rgba(96,165,250,0.03)",
            }}
          />

          {/* Corner ticks */}
          {["top-0 left-0 border-t border-l", "top-0 right-0 border-t border-r", "bottom-0 left-0 border-b border-l", "bottom-0 right-0 border-b border-r"].map((pos, i) => (
            <div
              key={i}
              className={`absolute h-1.5 w-1.5 ${pos} transition-colors duration-500`}
              style={{ borderColor: d.phase === "verify" ? "rgba(52,211,153,0.4)" : "rgba(96,165,250,0.3)" }}
            />
          ))}

          {/* Label */}
          {d.phase !== "scan" && (
            <div
              className="absolute -top-4 left-0 rounded-sm px-1 py-[1px] text-[8px] font-medium tracking-wide transition-colors duration-500 whitespace-nowrap"
              style={{
                backgroundColor: d.phase === "verify" ? "rgba(52,211,153,0.15)" : "rgba(96,165,250,0.1)",
                color: d.phase === "verify" ? "rgba(52,211,153,0.5)" : "rgba(96,165,250,0.4)",
              }}
            >
              {d.label}
            </div>
          )}

          {/* Scan line */}
          {d.phase === "detect" && (
            <div className="absolute left-0 right-0 h-px bg-blue-400/10 animate-[scanline_1.5s_ease-in-out_infinite]" />
          )}
        </div>
      ))}

      {/* Radial fade to make center readable */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(9,9,11,0.9)_0%,rgba(9,9,11,0.5)_60%,rgba(9,9,11,0.3)_100%)]" />

      <style jsx>{`
        @keyframes scanline {
          0% { top: 0%; }
          100% { top: 100%; }
        }
      `}</style>
    </div>
  );
}
