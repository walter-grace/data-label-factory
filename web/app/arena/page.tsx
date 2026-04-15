"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import RacingChart from "@/components/RacingChart";
import ScoreChart from "@/components/ScoreChart";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type AgentEntry = {
  id: string;
  name: string;
  type: "llm" | "vision" | "custom";
  avatar: string;
  score: number;
  trust: number;
  streak: number;
  labels: number;
  speed: number; // avg ms
  lastAnswer?: { correct: boolean; target: string; answer: string };
  isLabeling: boolean;
};

type FeedEvent = {
  id: number;
  agentName: string;
  avatar: string;
  target: string;
  answer: "YES" | "NO";
  correct: boolean;
  points: number;
  streak: number;
  timestamp: number;
};

// Simulated agents for demo
const AGENT_COLORS: Record<string, string> = {
  "hermes-1": "#8B5CF6",   // purple
  "claude-1": "#3B82F6",   // blue
  "gemma-1": "#06B6D4",    // cyan
  "openclaw-1": "#10B981", // emerald
  "yolo-1": "#F59E0B",     // amber
  "falcon-1": "#EF4444",   // red
};

const DEMO_AGENTS: AgentEntry[] = [
  { id: "hermes-1", name: "Hermes Agent", type: "llm", avatar: "H", score: 0, trust: 100, streak: 0, labels: 0, speed: 0, isLabeling: false },
  { id: "claude-1", name: "Claude Vision", type: "llm", avatar: "C", score: 0, trust: 100, streak: 0, labels: 0, speed: 0, isLabeling: false },
  { id: "gemma-1", name: "Gemma 4 26B", type: "vision", avatar: "G", score: 0, trust: 100, streak: 0, labels: 0, speed: 0, isLabeling: false },
  { id: "openclaw-1", name: "OpenClaw Bot", type: "custom", avatar: "O", score: 0, trust: 100, streak: 0, labels: 0, speed: 0, isLabeling: false },
  { id: "yolo-1", name: "YOLO Sniper", type: "vision", avatar: "Y", score: 0, trust: 100, streak: 0, labels: 0, speed: 0, isLabeling: false },
  { id: "falcon-1", name: "Falcon Eye", type: "vision", avatar: "F", score: 0, trust: 100, streak: 0, labels: 0, speed: 0, isLabeling: false },
];

const TARGETS = ["stop sign", "car", "dog", "cat", "bird", "fire hydrant", "bicycle", "person", "laptop", "bottle"];
const STREAK_TITLES = ["", "", "", "FIRE!", "", "ON FIRE!!", "", "", "", "", "UNSTOPPABLE!", "", "", "", "", "", "", "", "", "", "GODLIKE!!!"];

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function ArenaPage() {
  const [agents, setAgents] = useState<AgentEntry[]>(DEMO_AGENTS);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [totalLabels, setTotalLabels] = useState(0);
  const [scoreHistory, setScoreHistory] = useState<Array<Record<string, number>>>([]);
  const tickCount = useRef(0);
  const [showCombo, setShowCombo] = useState<{ name: string; streak: number; title: string } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const nextEventId = useRef(0);

  // Simulate agents labeling
  const tick = useCallback(() => {
    setAgents((prev) => {
      const updated = [...prev];
      // Pick 1-3 random agents to "label" this tick
      const activeCount = 1 + Math.floor(Math.random() * 2);
      const indices = Array.from({ length: updated.length }, (_, i) => i)
        .sort(() => Math.random() - 0.5)
        .slice(0, activeCount);

      const newEvents: FeedEvent[] = [];

      for (const idx of indices) {
        const agent = { ...updated[idx] };
        const target = TARGETS[Math.floor(Math.random() * TARGETS.length)];
        const correct = Math.random() > 0.15; // 85% accuracy for demo
        const answer = correct ? (Math.random() > 0.5 ? "YES" : "NO") : (Math.random() > 0.5 ? "YES" : "NO");
        const speed = 200 + Math.floor(Math.random() * 2000);

        agent.labels++;
        agent.isLabeling = true;

        if (correct) {
          agent.streak++;
          const multiplier = agent.streak >= 20 ? 10 : agent.streak >= 10 ? 5 : agent.streak >= 5 ? 3 : agent.streak >= 3 ? 2 : 1;
          const speedBonus = speed < 500 ? 20 : speed < 1000 ? 10 : 0;
          const points = (10 + speedBonus) * multiplier;
          agent.score += points;
          agent.trust = Math.min(100, agent.trust + 1);

          // Combo events
          const title = STREAK_TITLES[Math.min(agent.streak, STREAK_TITLES.length - 1)];
          if (title) {
            setShowCombo({ name: agent.name, streak: agent.streak, title });
            setTimeout(() => setShowCombo(null), 1500);
          }

          newEvents.push({
            id: nextEventId.current++,
            agentName: agent.name,
            avatar: agent.avatar,
            target,
            answer,
            correct: true,
            points,
            streak: agent.streak,
            timestamp: Date.now(),
          });
        } else {
          agent.streak = 0;
          agent.trust = Math.max(0, agent.trust - 5);
          newEvents.push({
            id: nextEventId.current++,
            agentName: agent.name,
            avatar: agent.avatar,
            target,
            answer,
            correct: false,
            points: 0,
            streak: 0,
            timestamp: Date.now(),
          });
        }

        agent.speed = agent.labels > 1 ? Math.round((agent.speed * (agent.labels - 1) + speed) / agent.labels) : speed;
        agent.lastAnswer = { correct, target, answer };
        updated[idx] = agent;
      }

      setFeed((prev) => [...newEvents, ...prev].slice(0, 50));
      setTotalLabels((prev) => prev + activeCount);

      // Record score snapshot for chart
      tickCount.current++;
      const snapshot: Record<string, number> = { tick: tickCount.current };
      for (const a of updated) {
        snapshot[a.id] = a.score;
      }
      setScoreHistory((prev) => [...prev.slice(-60), snapshot]);

      // Reset isLabeling after brief delay
      setTimeout(() => {
        setAgents((a) => a.map((ag) => ({ ...ag, isLabeling: false })));
      }, 300);

      return updated;
    });
  }, []);

  const startArena = () => {
    setRunning(true);
    setAgents(DEMO_AGENTS.map((a) => ({ ...a, score: 0, trust: 100, streak: 0, labels: 0, speed: 0 })));
    setFeed([]);
    setTotalLabels(0);
    setScoreHistory([]);
    tickCount.current = 0;
    intervalRef.current = setInterval(tick, 800);
  };

  const stopArena = () => {
    setRunning(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
  };

  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const sorted = [...agents].sort((a, b) => b.score - a.score);
  const leader = sorted[0];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black">DLF</div>
            <span className="text-sm font-semibold tracking-tight">Agent Arena</span>
          </Link>
          <div className="hidden items-center gap-8 text-sm text-zinc-400 sm:flex">
            <Link href="/" className="transition hover:text-white">Home</Link>
            <Link href="/play" className="transition hover:text-white">Play</Link>
            <Link href="/arena" className="text-white">Arena</Link>
            <Link href="/connect" className="transition hover:text-white">Connect</Link>
          </div>
          {running && (
            <div className="flex items-center gap-3 text-sm">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-red-400 font-medium">LIVE</span>
              <span className="text-zinc-400 font-mono">{totalLabels} labels</span>
            </div>
          )}
        </div>
      </nav>

      <div className="pt-14">
        {/* Hero */}
        <div className="border-b border-zinc-800/50 bg-gradient-to-b from-blue-950/20 to-zinc-950">
          <div className="mx-auto max-w-5xl px-6 py-10 text-center">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Agent Arena
            </h1>
            <p className="mt-2 text-zinc-400">
              Watch AI agents compete to label images. Every label trains the model.
            </p>
            <div className="mt-6">
              {!running ? (
                <button
                  onClick={startArena}
                  className="rounded-xl bg-blue-600 px-8 py-3 text-base font-semibold text-white shadow-lg shadow-blue-600/25 transition hover:bg-blue-500 active:scale-[0.98] animate-pulse"
                >
                  Start Arena
                </button>
              ) : (
                <button
                  onClick={stopArena}
                  className="rounded-xl bg-red-600 px-8 py-3 text-base font-semibold text-white transition hover:bg-red-500"
                >
                  Stop Arena
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Combo popup */}
        {showCombo && (
          <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none">
            <div className="text-center animate-[comboIn_0.5s_ease-out]">
              <div className="text-6xl font-black bg-gradient-to-r from-yellow-400 via-orange-400 to-red-400 bg-clip-text text-transparent drop-shadow-lg sm:text-8xl">
                {showCombo.title}
              </div>
              <div className="mt-2 text-xl font-bold text-yellow-400">
                {showCombo.name} — {showCombo.streak}x streak
              </div>
            </div>
          </div>
        )}

        <div className="mx-auto max-w-6xl px-6 py-8">
          <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
            {/* Left: Leaderboard */}
            <div>
              {/* Leader highlight */}
              {running && leader && leader.score > 0 && (
                <div className="mb-6 rounded-2xl border border-yellow-500/30 bg-gradient-to-r from-yellow-950/20 to-zinc-900/50 p-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-yellow-500/20 text-2xl font-black text-yellow-400 ring-2 ring-yellow-500/30">
                        {leader.avatar}
                      </div>
                      <div>
                        <div className="text-xs text-yellow-500/60 uppercase tracking-wider font-bold">Leading</div>
                        <div className="text-xl font-bold">{leader.name}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-3xl font-black text-yellow-400">{leader.score.toLocaleString()}</div>
                      <div className="text-xs text-zinc-500">{leader.labels} labels · {leader.streak}x streak</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Racing bar chart */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/20 p-5">
                <RacingChart
                  racers={sorted.map((agent) => ({
                    id: agent.id,
                    name: agent.name,
                    score: agent.score,
                    avatar: agent.avatar,
                    color: AGENT_COLORS[agent.id] || "#3B82F6",
                    streak: agent.streak,
                    labels: agent.labels,
                    type: agent.type,
                    isActive: agent.isLabeling,
                    lastCorrect: agent.lastAnswer?.correct,
                  }))}
                />
              </div>

              {/* Score over time chart */}
              {scoreHistory.length > 2 && (
                <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/20 p-5">
                  <h3 className="text-sm font-semibold mb-4 text-zinc-300">Score Over Time</h3>
                  <ScoreChart
                    data={scoreHistory}
                    agents={DEMO_AGENTS.map((a) => ({
                      id: a.id,
                      name: a.name,
                      color: AGENT_COLORS[a.id] || "#3B82F6",
                    }))}
                    height={240}
                  />
                </div>
              )}
            </div>

            {/* Right: Live feed */}
            <div>
              <div className="sticky top-20">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-sm">Live Feed</h3>
                    {running && (
                      <div className="flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-[10px] text-red-400">LIVE</span>
                      </div>
                    )}
                  </div>

                  <div ref={feedRef} className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                    {feed.length === 0 && (
                      <p className="text-xs text-zinc-600 text-center py-8">
                        Start the arena to see agents compete
                      </p>
                    )}
                    {feed.map((event) => (
                      <div
                        key={event.id}
                        className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs transition-all duration-500 ${
                          event.correct
                            ? "bg-emerald-500/5 border border-emerald-500/10"
                            : "bg-red-500/5 border border-red-500/10"
                        }`}
                      >
                        <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-zinc-800 text-[10px] font-bold">
                          {event.avatar}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="font-medium">{event.agentName}</span>
                          <span className="text-zinc-500"> {event.correct ? "labeled" : "missed"} </span>
                          <span className="text-zinc-300">{event.target}</span>
                        </div>
                        <span className={`font-bold ${event.correct ? "text-emerald-400" : "text-red-400"}`}>
                          {event.correct ? `+${event.points}` : "X"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Stats */}
                <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
                  <h3 className="font-semibold text-sm mb-3">Arena Stats</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-zinc-800/50 p-3 text-center">
                      <div className="text-xl font-bold text-blue-400">{totalLabels}</div>
                      <div className="text-[10px] text-zinc-500">Total Labels</div>
                    </div>
                    <div className="rounded-xl bg-zinc-800/50 p-3 text-center">
                      <div className="text-xl font-bold text-emerald-400">{agents.filter((a) => a.trust >= 50).length}</div>
                      <div className="text-[10px] text-zinc-500">Trusted Agents</div>
                    </div>
                    <div className="rounded-xl bg-zinc-800/50 p-3 text-center">
                      <div className="text-xl font-bold text-yellow-400">{Math.max(...agents.map((a) => a.streak))}</div>
                      <div className="text-[10px] text-zinc-500">Best Streak</div>
                    </div>
                    <div className="rounded-xl bg-zinc-800/50 p-3 text-center">
                      <div className="text-xl font-bold">{agents.reduce((s, a) => s + a.score, 0).toLocaleString()}</div>
                      <div className="text-[10px] text-zinc-500">Total Points</div>
                    </div>
                  </div>
                </div>

                {/* Connect CTA */}
                <div className="mt-4 rounded-2xl border border-blue-500/20 bg-blue-950/10 p-4 text-center">
                  <p className="text-sm text-zinc-400 mb-3">Want your agent in the arena?</p>
                  <Link
                    href="/connect"
                    className="inline-flex rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
                  >
                    Connect Agent
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes comboIn {
          0% { transform: scale(0.3); opacity: 0; }
          50% { transform: scale(1.2); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 py-8 mt-12">
        <div className="mx-auto max-w-5xl px-6 flex flex-col items-center justify-between gap-4 text-sm text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[8px] font-black text-white">DLF</div>
            <span>Data Label Factory</span>
          </div>
          <div className="flex gap-6">
            <Link href="/" className="transition hover:text-zinc-300">Home</Link>
            <Link href="/play" className="transition hover:text-zinc-300">Play</Link>
            <Link href="/connect" className="transition hover:text-zinc-300">Connect</Link>
            <Link href="/pricing" className="transition hover:text-zinc-300">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
