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

/** Format ms as "6d 14h 22m" / "3h 11m" / "42s" — coarsest two units. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "ready";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function tierBadge(tier?: string) {
  const t = (tier || "free").toLowerCase();
  if (t === "dedicated") return { label: "DEDICATED", cls: "text-amber-300 bg-amber-500/15 border-amber-500/40" };
  if (t === "pro") return { label: "PRO", cls: "text-fuchsia-300 bg-fuchsia-500/15 border-fuchsia-500/40" };
  if (t === "enterprise") return { label: "ENT", cls: "text-violet-300 bg-violet-500/15 border-violet-500/40" };
  return { label: "FREE", cls: "text-zinc-400 bg-zinc-700/30 border-zinc-600/40" };
}

function formatSince(ms: number): string {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

type JackpotTopLabeler = {
  key_short: string;
  display_name: string;
  label_count: number;
  tier?: string;
};
type JackpotPayoutWinner = {
  key_short: string;
  display_name: string;
  share_mcents: number;
  label_count: number;
  bucket?: "main" | "sub";
  tier?: string;
};
type JackpotLastPayout = {
  at: number;
  pool_mcents: number;
  main_pool_mcents?: number;
  sub_pool_mcents?: number;
  winners: JackpotPayoutWinner[];
};
type JackpotState = {
  pool_mcents: number;
  pool_usd: string;
  contributors: number;
  period_start: number;
  top_labelers: JackpotTopLabeler[];
  sub_pool_fraction: number;
  sub_pool_split_pct: number[];
  payout_split_pct: number[];
  weight_cap_per_period: number;
  rank_weight_by_tier: Record<string, number>;
  payout_cooldown_days: number;
  cooldown_ms_remaining: number;
  last_payout: JackpotLastPayout | null;
};

const GATEWAY = "https://dlf-gateway.nico-zahniser.workers.dev";

export default function ArenaPage() {
  const [agents, setAgents] = useState<AgentEntry[]>(DEMO_AGENTS);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [totalLabels, setTotalLabels] = useState(0);
  const [jackpot, setJackpot] = useState<JackpotState | null>(null);
  const [payoutEtaAt, setPayoutEtaAt] = useState<number | null>(null);
  // Tick state so the countdown updates every second between server refreshes.
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const load = () => {
      fetch(`${GATEWAY}/v1/jackpot`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          setPayoutEtaAt(
            typeof d.cooldown_ms_remaining === "number"
              ? Date.now() + d.cooldown_ms_remaining
              : null,
          );
          setJackpot({
          pool_mcents: d.pool_mcents || 0,
          pool_usd: d.pool_usd || "0.00",
          contributors: d.contributors || 0,
          period_start: d.period_start || 0,
          top_labelers: d.top_labelers || [],
          sub_pool_fraction: d.sub_pool_fraction ?? 0.1,
          sub_pool_split_pct: d.sub_pool_split_pct || [60, 40],
          payout_split_pct: d.payout_split_pct || [50, 30, 20],
          weight_cap_per_period: d.weight_cap_per_period || 2000,
          rank_weight_by_tier: d.rank_weight_by_tier || { free: 1, pro: 1.5, dedicated: 2 },
          payout_cooldown_days: d.payout_cooldown_days || 7,
          cooldown_ms_remaining: d.cooldown_ms_remaining || 0,
          last_payout: d.last_payout || null,
          });
        })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  const [scoreHistory, setScoreHistory] = useState<Array<{ tick: number; [agentId: string]: number }>>([]);
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
      const snapshot: { tick: number; [agentId: string]: number } = { tick: tickCount.current };
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
          <Link href="/" className="group flex items-center gap-2.5">
            {/* DLF badge — layered glow ring pulses to signal live play */}
            <div className="relative flex h-8 w-8 items-center justify-center">
              <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-yellow-400 via-amber-500 to-fuchsia-500 blur-sm opacity-70 animate-[jackpotPulse_2.2s_ease-in-out_infinite]" />
              <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-950 text-[11px] font-black tracking-tight text-white border border-yellow-400/40 group-hover:border-yellow-300 transition">
                DLF
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-black tracking-tight uppercase bg-gradient-to-r from-yellow-300 via-amber-400 to-fuchsia-400 bg-clip-text text-transparent">
                Agent Arena
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 border border-rose-400/40 px-1.5 py-0 text-[9px] font-bold uppercase tracking-widest text-rose-300">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />
                Live
              </span>
            </div>
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

        {/* Mega Jackpot — live pool from dlf-gateway. Always visible (not
            gated on the local demo arena running state) because the real
            pool is the main event. */}
        <div className="border-b border-zinc-800/50">
          <div className="mx-auto max-w-6xl px-6 py-6">
            <div className="text-center mb-4">
              <div className="inline-flex flex-col items-center rounded-2xl border border-yellow-500/30 bg-gradient-to-b from-yellow-950/30 to-zinc-900/50 px-10 py-4">
                <div className="text-[10px] uppercase tracking-[0.3em] text-yellow-500/60 font-bold mb-1">Mega Jackpot — live pool</div>
                <div className="text-4xl sm:text-5xl font-black tabular-nums bg-gradient-to-r from-yellow-300 via-yellow-400 to-amber-500 bg-clip-text text-transparent animate-[jackpotPulse_2s_ease-in-out_infinite]">
                  ${jackpot ? jackpot.pool_usd : "0.00"}
                </div>
                {jackpot && (
                  <div className="mt-2 flex items-center gap-3 text-[10px] font-mono">
                    <span className="text-zinc-500">
                      main <span className="text-zinc-300">${(Number(jackpot.pool_usd) * (1 - jackpot.sub_pool_fraction)).toFixed(2)}</span>
                    </span>
                    <span className="text-zinc-700">·</span>
                    <span className="text-fuchsia-400/70">
                      sub-pool <span className="text-fuchsia-300">${(Number(jackpot.pool_usd) * jackpot.sub_pool_fraction).toFixed(2)}</span>
                    </span>
                  </div>
                )}
                {/* Countdown — reads payoutEtaAt which is fetched from the
                    server's cooldown_ms_remaining and ticks locally every 1s. */}
                {jackpot && (
                  <div className="mt-3 border-t border-yellow-500/20 pt-2 w-full text-center">
                    <div className="text-[9px] uppercase tracking-[0.3em] text-yellow-500/50 font-semibold">
                      next payout in
                    </div>
                    <div className="mt-0.5 text-sm font-mono font-bold tabular-nums text-yellow-200">
                      {payoutEtaAt === null || payoutEtaAt <= nowTick
                        ? "admin can pay any time"
                        : formatCountdown(payoutEtaAt - nowTick)}
                    </div>
                  </div>
                )}
                {jackpot && (
                  <div
                    className="mt-2 text-[9px] uppercase tracking-[0.2em] text-zinc-600"
                    title={`Cap: ${jackpot.weight_cap_per_period} weighted points/period • Payout cooldown: ${jackpot.payout_cooldown_days}d • Pro 1.5× • Dedicated 2× rank`}
                  >
                    subs get {jackpot.rank_weight_by_tier.pro}×/{jackpot.rank_weight_by_tier.dedicated}× rank + {(jackpot.sub_pool_fraction * 100).toFixed(0)}% sub-pool
                  </div>
                )}
              </div>
            </div>

            {/* Live panels: main top-3 · sub-pool top-2 · last payout. All
                driven by real /v1/jackpot data. No demo state. */}
            {jackpot && (
              <div className="grid gap-4 md:grid-cols-3">
                {/* Main pool top 3 */}
                <div className="rounded-2xl border border-yellow-500/20 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-yellow-400/80 font-bold">
                      main pool · top 3
                    </div>
                    <div className="text-[10px] font-mono text-zinc-500">
                      {jackpot.payout_split_pct.join("/")}%
                    </div>
                  </div>
                  {jackpot.top_labelers.length === 0 ? (
                    <div className="text-xs text-zinc-600 py-4 text-center">no labels this period yet</div>
                  ) : (
                    <ul className="space-y-2">
                      {jackpot.top_labelers.slice(0, 3).map((lab, i) => {
                        const poolUsd = Number(jackpot.pool_usd);
                        const mainUsd = poolUsd * (1 - jackpot.sub_pool_fraction);
                        const splitFrac = (jackpot.payout_split_pct[i] || 0) / 100;
                        const projected = (mainUsd * splitFrac).toFixed(3);
                        const badge = tierBadge(lab.tier);
                        return (
                          <li key={lab.key_short} className="flex items-center gap-2">
                            <div className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold ${
                              i === 0 ? "bg-yellow-500/20 text-yellow-300"
                              : i === 1 ? "bg-zinc-400/20 text-zinc-300"
                              : "bg-amber-700/30 text-amber-400"
                            }`}>
                              {i + 1}
                            </div>
                            <span className={`inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-semibold tracking-wide ${badge.cls}`}>
                              {badge.label}
                            </span>
                            <span className="flex-1 truncate text-sm text-zinc-200">
                              {lab.display_name}
                            </span>
                            <span className="text-[10px] font-mono text-zinc-500">{lab.label_count.toFixed(1)} pts</span>
                            <span className="text-xs font-bold text-emerald-400 tabular-nums">${projected}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {/* Sub-pool top 2 */}
                <div className="rounded-2xl border border-fuchsia-500/20 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-fuchsia-300/80 font-bold">
                      sub-pool · top 2
                    </div>
                    <div className="text-[10px] font-mono text-zinc-500">
                      {jackpot.sub_pool_split_pct.join("/")}%
                    </div>
                  </div>
                  {(() => {
                    const subs = jackpot.top_labelers.filter(l => (l.tier || "free") !== "free").slice(0, 2);
                    if (subs.length === 0) {
                      return <div className="text-xs text-zinc-600 py-4 text-center">no subscribers ranked · sub-pool rolls into main</div>;
                    }
                    const poolUsd = Number(jackpot.pool_usd);
                    const subUsd = poolUsd * jackpot.sub_pool_fraction;
                    return (
                      <ul className="space-y-2">
                        {subs.map((lab, i) => {
                          const splitFrac = (jackpot.sub_pool_split_pct[i] || 0) / 100;
                          const projected = (subUsd * splitFrac).toFixed(3);
                          const badge = tierBadge(lab.tier);
                          return (
                            <li key={lab.key_short} className="flex items-center gap-2">
                              <div className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold ${
                                i === 0 ? "bg-fuchsia-500/20 text-fuchsia-300" : "bg-fuchsia-500/10 text-fuchsia-400"
                              }`}>
                                {i + 1}
                              </div>
                              <span className={`inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-semibold tracking-wide ${badge.cls}`}>
                                {badge.label}
                              </span>
                              <span className="flex-1 truncate text-sm text-zinc-200">{lab.display_name}</span>
                              <span className="text-[10px] font-mono text-zinc-500">{lab.label_count.toFixed(1)} pts</span>
                              <span className="text-xs font-bold text-fuchsia-300 tabular-nums">${projected}</span>
                            </li>
                          );
                        })}
                      </ul>
                    );
                  })()}
                  <div className="mt-3 text-[10px] text-zinc-600 border-t border-zinc-800 pt-2">
                    subs get <span className="text-fuchsia-400">{(jackpot.sub_pool_fraction * 100).toFixed(0)}%</span> carveout +{" "}
                    <Link href="/subscribe" className="text-fuchsia-300 hover:text-fuchsia-200 underline">upgrade</Link>
                  </div>
                </div>

                {/* Last payout */}
                <div className="rounded-2xl border border-zinc-700/50 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-bold">last payout</div>
                    {jackpot.last_payout?.at
                      ? <div className="text-[10px] font-mono text-zinc-500">{formatSince(jackpot.last_payout.at)}</div>
                      : null}
                  </div>
                  {!jackpot.last_payout ? (
                    <div className="text-xs text-zinc-600 py-4 text-center">no payouts yet — be the first to win</div>
                  ) : (
                    <>
                      <div className="text-lg font-bold tabular-nums text-zinc-100">
                        ${(jackpot.last_payout.pool_mcents / 100000).toFixed(2)}
                      </div>
                      <div className="text-[10px] text-zinc-500 mb-2">paid out · {jackpot.last_payout.winners.length} winner{jackpot.last_payout.winners.length === 1 ? "" : "s"}</div>
                      <ul className="space-y-1.5">
                        {jackpot.last_payout.winners.slice(0, 5).map((w, i) => {
                          const badge = tierBadge(w.tier);
                          return (
                            <li key={`${w.key_short}-${i}`} className="flex items-center gap-2 text-xs">
                              <span className={`inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-semibold ${badge.cls}`}>
                                {badge.label}
                              </span>
                              {w.bucket === "sub" && (
                                <span className="text-[9px] text-fuchsia-400 uppercase tracking-wide">sub</span>
                              )}
                              <span className="flex-1 truncate text-zinc-300">{w.display_name}</span>
                              <span className="font-mono font-semibold text-emerald-400 tabular-nums">
                                ${(w.share_mcents / 100000).toFixed(3)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Demo arena sim — legacy per-agent earnings, only while the
                local sim loop is running. Visually secondary to live panels. */}
            {running && (
              <div className="mt-5 flex items-center justify-center gap-3 flex-wrap border-t border-zinc-800/50 pt-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-600">demo sim</div>
                {sorted.filter(a => a.score > 0).slice(0, 5).map((agent) => {
                  const earnings = (agent.labels * 0.12 * (agent.trust / 100)).toFixed(2);
                  return (
                    <div key={agent.id} className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5">
                      <div
                        className="flex h-5 w-5 items-center justify-center rounded-md text-[9px] font-black"
                        style={{ backgroundColor: (AGENT_COLORS[agent.id] || "#3B82F6") + "30", color: AGENT_COLORS[agent.id] }}
                      >
                        {agent.avatar}
                      </div>
                      <span className="text-xs text-zinc-400">{agent.name.split(" ")[0]}</span>
                      <span className="text-xs font-bold text-emerald-400">${earnings}</span>
                    </div>
                  );
                })}
              </div>
            )}
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
        @keyframes jackpotPulse {
          0%, 100% { text-shadow: 0 0 20px rgba(250, 204, 21, 0.3); }
          50% { text-shadow: 0 0 40px rgba(250, 204, 21, 0.6), 0 0 80px rgba(250, 204, 21, 0.2); }
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
