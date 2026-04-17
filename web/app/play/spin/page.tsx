"use client";

/**
 * /play/spin — Casino spin wheel for data labeling.
 *
 * Agents and humans spin a wheel to get a random label category:
 *   Header? | Table? | Invoice # | Total $ | Date | Name | Wild | JACKPOT
 *
 * Wherever it lands → fetch a challenge of that type → answer → score.
 * JACKPOT = double points. Wild = random from any category.
 *
 * Every answer feeds /api/rewards for GRPO training.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";

// ── Wheel segments ──────────────────────────────────────────

type Segment = {
  label: string;
  color: string;
  textColor: string;
  question: string;
  multiplier: number;
  icon: string;
};

const SEGMENTS: Segment[] = [
  { label: "Header?", color: "#2563EB", textColor: "#fff", question: "Is this block a section header?", multiplier: 1, icon: "H" },
  { label: "Table?", color: "#059669", textColor: "#fff", question: "Is this block a data table?", multiplier: 1, icon: "T" },
  { label: "Invoice #", color: "#7C3AED", textColor: "#fff", question: "Does this contain an invoice number?", multiplier: 1, icon: "#" },
  { label: "Total $", color: "#D97706", textColor: "#fff", question: "Does this show a total amount?", multiplier: 1.5, icon: "$" },
  { label: "Date", color: "#DC2626", textColor: "#fff", question: "Does this contain a date?", multiplier: 1, icon: "D" },
  { label: "Name", color: "#0891B2", textColor: "#fff", question: "Does this contain a person or company name?", multiplier: 1, icon: "N" },
  { label: "Wild", color: "#6D28D9", textColor: "#FFD700", question: "Is this block correctly labeled?", multiplier: 2, icon: "?" },
  { label: "JACKPOT", color: "#FFD700", textColor: "#000", question: "Can you identify what type of content this is?", multiplier: 3, icon: "★" },
];

const SEGMENT_ANGLE = 360 / SEGMENTS.length;

// ── Challenge type ──────────────────────────────────────────

type Challenge = {
  challenge_id: string;
  block_text: string;
  bbox: number[];
  page_image_url: string;
  question: string;
  question_field: string;
  tentative_type: string;
};

type AnswerResult = {
  correct: boolean;
  was_honeypot: boolean;
  trust_score: number;
  score: number;
  label_accepted: boolean;
};

const AGENT_ID = typeof window !== "undefined"
  ? "spinner-" + (localStorage.getItem("dlf-spin-id") || (() => { const id = Math.random().toString(36).slice(2, 8); localStorage.setItem("dlf-spin-id", id); return id; })())
  : "spinner";

export default function SpinPage() {
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [landed, setLanded] = useState<Segment | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [answering, setAnswering] = useState(false);
  const [lastResult, setLastResult] = useState<{ answer: string; result: AnswerResult; segment: Segment } | null>(null);
  const [score, setScore] = useState(0);
  const [spins, setSpins] = useState(0);
  const [streak, setStreak] = useState(0);
  const [trust, setTrust] = useState(100);
  const [history, setHistory] = useState<Array<{ segment: string; answer: string; points: number }>>([]);
  const [showConfetti, setShowConfetti] = useState(false);

  const wheelRef = useRef<HTMLDivElement>(null);

  // ── Spin the wheel ──
  const spin = useCallback(() => {
    if (spinning || answering) return;
    setSpinning(true);
    setLanded(null);
    setChallenge(null);
    setLastResult(null);

    // Pick a random segment (weighted: JACKPOT is rarer)
    const weights = SEGMENTS.map((s) => (s.label === "JACKPOT" ? 0.5 : 1));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * totalWeight;
    let segIdx = 0;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) { segIdx = i; break; }
    }

    // Calculate target rotation: 3-5 full spins + land on segment
    const extraSpins = 3 + Math.floor(Math.random() * 3);
    const segCenter = segIdx * SEGMENT_ANGLE + SEGMENT_ANGLE / 2;
    // Wheel rotates clockwise; pointer is at top (0°).
    // We want the segment at segIdx to end up under the pointer.
    const targetAngle = rotation + extraSpins * 360 + (360 - segCenter);

    setRotation(targetAngle);

    // After animation completes (4s), reveal the segment + fetch challenge
    setTimeout(() => {
      setLanded(SEGMENTS[segIdx]);
      setSpinning(false);
      setSpins((s) => s + 1);
      if (SEGMENTS[segIdx].label === "JACKPOT") {
        setShowConfetti(true);
        setTimeout(() => setShowConfetti(false), 2000);
      }
      fetchChallenge(SEGMENTS[segIdx]);
    }, 4000);
  }, [spinning, answering, rotation]);

  // ── Fetch a challenge based on landed segment ──
  const fetchChallenge = async (seg: Segment) => {
    try {
      const r = await fetch(`/api/agent?action=doc-challenge&agent_id=${AGENT_ID}`, { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        // Override the question with the segment's question
        setChallenge({ ...data, question: `${seg.question} Answer YES or NO.` });
      }
    } catch {}
  };

  // ── Submit answer ──
  const answer = async (ans: "YES" | "NO") => {
    if (!challenge || !landed) return;
    setAnswering(true);
    try {
      const r = await fetch("/api/agent?action=doc-answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-id": AGENT_ID },
        body: JSON.stringify({ challenge_id: challenge.challenge_id, answer: ans }),
      });
      const result: AnswerResult = await r.json();

      const points = Math.round(
        (result.correct ? 10 : 0) * landed.multiplier * (streak >= 3 ? 1.5 : 1),
      );
      setScore((s) => s + points);
      setTrust(result.trust_score);

      if (result.was_honeypot && result.correct) {
        setStreak((s) => s + 1);
      } else if (result.was_honeypot && !result.correct) {
        setStreak(0);
      }

      setLastResult({ answer: ans, result, segment: landed });
      setHistory((h) => [{ segment: landed.label, answer: ans, points }, ...h].slice(0, 15));
    } catch {} finally {
      setAnswering(false);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === " " || e.key === "Enter") {
        if (!spinning && !challenge) spin();
        if (lastResult) { setLastResult(null); setChallenge(null); setLanded(null); }
      }
      if (e.key === "y" || e.key === "Y") answer("YES");
      if (e.key === "n" || e.key === "N") answer("NO");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spinning, challenge, lastResult, spin]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Confetti burst */}
      {showConfetti && (
        <div className="fixed inset-0 pointer-events-none z-50">
          {Array.from({ length: 30 }).map((_, i) => (
            <div
              key={i}
              className="absolute rounded-full"
              style={{
                left: `${30 + Math.random() * 40}%`,
                top: `-10px`,
                width: 8 + Math.random() * 8,
                height: 8 + Math.random() * 8,
                background: ["#FFD700", "#FF3366", "#33FF66", "#3366FF", "#FF9933"][i % 5],
                animation: `confettiFall ${1.5 + Math.random()}s ease-out forwards`,
                animationDelay: `${Math.random() * 0.5}s`,
              }}
            />
          ))}
        </div>
      )}

      {/* Nav */}
      <nav className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/" className="text-lg font-bold">Data Label Factory</Link>
          <div className="flex gap-6 text-sm text-zinc-400">
            <Link href="/go" className="hover:text-white">Go</Link>
            <Link href="/play" className="hover:text-white">Images</Link>
            <Link href="/play/docs" className="hover:text-white">Docs</Link>
            <Link href="/play/spin" className="text-white">Spin</Link>
            <Link href="/arena" className="hover:text-white">Arena</Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* Stats bar */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex gap-6">
            <StatBadge label="score" value={String(score)} color="text-blue-400" />
            <StatBadge label="spins" value={String(spins)} color="text-zinc-300" />
            <StatBadge label="streak" value={String(streak)} color="text-emerald-400" />
            <StatBadge label="trust" value={String(trust)} color={trust < 50 ? "text-red-400" : "text-zinc-300"} />
          </div>
          <div className="text-xs text-zinc-600">
            Press SPACE to spin · Y/N to answer
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-[1fr_400px]">
          {/* Wheel */}
          <div className="flex flex-col items-center">
            {/* Pointer */}
            <div className="relative mb-[-12px] z-10">
              <div className="w-0 h-0 border-l-[12px] border-l-transparent border-r-[12px] border-r-transparent border-t-[20px] border-t-white" />
            </div>

            {/* Wheel container */}
            <div className="relative" style={{ width: 340, height: 340 }}>
              <div
                ref={wheelRef}
                className="absolute inset-0 rounded-full border-4 border-zinc-700 overflow-hidden"
                style={{
                  transform: `rotate(${rotation}deg)`,
                  transition: spinning ? "transform 4s cubic-bezier(0.2, 0.8, 0.3, 1)" : "none",
                }}
              >
                {SEGMENTS.map((seg, i) => {
                  const startAngle = i * SEGMENT_ANGLE;
                  return (
                    <div
                      key={i}
                      className="absolute origin-bottom-left"
                      style={{
                        width: "50%",
                        height: "50%",
                        left: "50%",
                        top: "0",
                        transformOrigin: "0% 100%",
                        transform: `rotate(${startAngle}deg) skewY(-${90 - SEGMENT_ANGLE}deg)`,
                        background: seg.color,
                      }}
                    >
                      <span
                        className="absolute font-bold text-xs"
                        style={{
                          color: seg.textColor,
                          transform: `skewY(${90 - SEGMENT_ANGLE}deg) rotate(${SEGMENT_ANGLE / 2}deg)`,
                          transformOrigin: "0 0",
                          left: "30%",
                          top: "10%",
                          textShadow: "0 1px 2px rgba(0,0,0,0.5)",
                        }}
                      >
                        {seg.icon} {seg.label}
                      </span>
                    </div>
                  );
                })}
                {/* Center circle */}
                <div className="absolute inset-[35%] rounded-full bg-zinc-900 border-2 border-zinc-700 flex items-center justify-center">
                  <span className="text-sm font-bold text-zinc-300">SPIN</span>
                </div>
              </div>
            </div>

            {/* Spin button */}
            <button
              onClick={spin}
              disabled={spinning || !!challenge}
              className={`mt-6 rounded-xl px-10 py-4 text-lg font-bold transition shadow-lg ${
                spinning || challenge
                  ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                  : "bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white shadow-blue-500/30"
              }`}
            >
              {spinning ? "Spinning..." : challenge ? "Answer first!" : "SPIN"}
            </button>

            {/* Landed segment callout */}
            {landed && !lastResult && (
              <div
                className="mt-4 rounded-xl px-6 py-3 text-center font-bold text-lg animate-bounce"
                style={{ background: landed.color + "30", color: landed.color === "#FFD700" ? "#FFD700" : landed.color, borderColor: landed.color }}
              >
                {landed.icon} {landed.label}!
                {landed.multiplier > 1 && (
                  <span className="ml-2 text-sm opacity-80">{landed.multiplier}x points</span>
                )}
              </div>
            )}
          </div>

          {/* Challenge panel */}
          <div className="space-y-4">
            {!challenge && !lastResult && (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-center">
                <div className="text-6xl mb-4 opacity-20">🎰</div>
                <div className="text-lg font-semibold">Spin to get a challenge</div>
                <div className="text-sm text-zinc-500 mt-2">
                  Each spin picks a label type. Answer correctly to earn points.
                  JACKPOT = 3x multiplier!
                </div>
              </div>
            )}

            {challenge && !lastResult && (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
                <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
                  Challenge — {landed?.label}
                </div>
                <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-4 mb-4">
                  <p className="text-base leading-relaxed">{challenge.block_text}</p>
                </div>
                <div className="text-center mb-4">
                  <div className="text-sm font-semibold">{challenge.question}</div>
                </div>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => answer("NO")}
                    disabled={answering}
                    className="rounded-xl bg-red-600/20 border border-red-500/40 hover:bg-red-600/30 px-8 py-3 font-bold text-red-300 disabled:opacity-40"
                  >
                    NO
                  </button>
                  <button
                    onClick={() => answer("YES")}
                    disabled={answering}
                    className="rounded-xl bg-emerald-600/20 border border-emerald-500/40 hover:bg-emerald-600/30 px-8 py-3 font-bold text-emerald-300 disabled:opacity-40"
                  >
                    YES
                  </button>
                </div>
              </div>
            )}

            {lastResult && (
              <div
                className={`rounded-2xl border p-6 ${
                  lastResult.result.was_honeypot
                    ? lastResult.result.correct
                      ? "border-emerald-500/40 bg-emerald-600/10"
                      : "border-red-500/40 bg-red-600/10"
                    : "border-blue-500/40 bg-blue-600/10"
                }`}
              >
                <div className="text-center">
                  {lastResult.result.was_honeypot ? (
                    lastResult.result.correct ? (
                      <div className="text-2xl font-bold text-emerald-300">
                        +{Math.round(10 * lastResult.segment.multiplier * (streak >= 3 ? 1.5 : 1))} pts
                      </div>
                    ) : (
                      <div className="text-2xl font-bold text-red-300">Wrong! -25 trust</div>
                    )
                  ) : (
                    <div className="text-2xl font-bold text-blue-300">
                      Label accepted → training data
                    </div>
                  )}
                  <div className="text-xs text-zinc-500 mt-2">
                    {lastResult.segment.label} · answered {lastResult.answer}
                    {lastResult.segment.multiplier > 1 && ` · ${lastResult.segment.multiplier}x multiplier`}
                  </div>
                </div>
                <button
                  onClick={() => { setLastResult(null); setChallenge(null); setLanded(null); }}
                  className="mt-4 w-full rounded-xl bg-zinc-800 hover:bg-zinc-700 px-4 py-3 text-sm font-semibold"
                >
                  Spin again (SPACE)
                </button>
              </div>
            )}

            {/* History */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
              <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">History</div>
              {history.length === 0 ? (
                <div className="text-xs text-zinc-600 text-center py-2">No spins yet</div>
              ) : (
                <div className="space-y-1">
                  {history.map((h, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-zinc-400">{h.segment}</span>
                      <span className="text-zinc-500">{h.answer}</span>
                      <span className={h.points > 0 ? "text-emerald-400 font-bold" : "text-zinc-600"}>
                        {h.points > 0 ? `+${h.points}` : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* For agents */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Agents</div>
              <div className="text-xs text-zinc-500">
                Same game via MCP: <code className="text-blue-300">play_flywheel_docs(action=&quot;challenge&quot;)</code>
                <br />
                Every spin = one labeled training example.
              </div>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes confettiFall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`font-mono text-lg font-bold ${color}`}>{value}</div>
    </div>
  );
}
