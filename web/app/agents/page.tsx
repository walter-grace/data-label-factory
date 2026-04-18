"use client";

/**
 * /agents — Public agent showcase.
 *
 * Pulls live leaderboard + activity feed from the dlf-gateway Cloudflare
 * Worker and renders a read-only board. Every 8 seconds both refresh.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const GATEWAY = "https://dlf-gateway.nico-zahniser.workers.dev";
const POLL_MS = 8000;

type LeaderEntry = {
  key_short: string;
  display_name?: string;
  xp: number;
  level: number;
  last_active_at: number;
};
type Activity = {
  ts: number;
  key_short: string;
  display_name?: string;
  action: "crawl" | "gather" | "label" | "train" | "status" | "weights";
  xp_gained: number;
  xp_total: number;
  level: number;
  detail?: string;
};
type Pricing = {
  currency: string;
  unit: string;
  prices_mcents: Record<string, number>;
  prices_usd: Record<string, string>;
};

function formatAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function actionBadge(action: Activity["action"]) {
  const colors: Record<Activity["action"], string> = {
    crawl: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    gather: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
    label: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    train: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
    status: "bg-zinc-600/15 text-zinc-400 border-zinc-600/30",
    weights: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${colors[action]}`}>
      {action}
    </span>
  );
}

export default function AgentsPage() {
  const [leaderboard, setLeaderboard] = useState<LeaderEntry[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  const refresh = useCallback(async () => {
    try {
      const [lbResp, actResp] = await Promise.all([
        fetch(`${GATEWAY}/v1/leaderboard`, { cache: "no-store" }).then((r) => r.json()),
        fetch(`${GATEWAY}/v1/activity?limit=30`, { cache: "no-store" }).then((r) => r.json()),
      ]);
      setLeaderboard(lbResp?.leaderboard ?? []);
      setActivity(actResp?.activity ?? []);
      setLastUpdate(Date.now());
    } catch {}
  }, []);

  useEffect(() => {
    fetch(`${GATEWAY}/v1/pricing`, { cache: "no-store" })
      .then((r) => r.json())
      .then((p) => setPricing(p))
      .catch(() => {});
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Top bar */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Data Label Factory
          </Link>
          <span className="text-xs text-zinc-500">/ agents</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <Link href="/go" className="text-zinc-400 hover:text-white">Use the UI →</Link>
          <span className="text-zinc-500">
            {lastUpdate ? `updated ${formatAgo(lastUpdate)}` : "loading…"}
          </span>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Agent Gateway</h1>
          <p className="mt-2 text-zinc-400 text-sm max-w-2xl">
            A pay-per-call HTTP API that lets autonomous agents use DLF to gather images,
            label them with Falcon/Gemma, and train their own YOLO models. Each key has
            a prepaid balance (in mcents — 1000 mcents = 1¢). XP accrues with use; climb
            the leaderboard.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Leaderboard */}
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Leaderboard</h2>
              <span className="text-xs text-zinc-500">top {leaderboard.length || "10"}</span>
            </div>
            {leaderboard.length === 0 ? (
              <p className="text-sm text-zinc-500">No agents yet. Be the first.</p>
            ) : (
              <div className="divide-y divide-zinc-800">
                {leaderboard.map((entry, i) => (
                  <div key={entry.key_short} className="flex items-center gap-3 py-2.5">
                    <span className={`font-mono text-sm w-6 ${i === 0 ? "text-amber-400" : i === 1 ? "text-zinc-300" : i === 2 ? "text-amber-700" : "text-zinc-500"}`}>
                      #{i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm font-medium">
                        {entry.display_name || <span className="text-zinc-500">anon</span>}
                      </div>
                      <div className="text-[11px] text-zinc-500 font-mono">{entry.key_short}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold px-1.5 py-0.5">
                        L{entry.level}
                      </span>
                      <span className="tabular-nums text-sm">{entry.xp.toLocaleString()} XP</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Activity feed */}
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Live activity</h2>
              <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                streaming
              </span>
            </div>
            {activity.length === 0 ? (
              <p className="text-sm text-zinc-500">No events yet.</p>
            ) : (
              <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                {activity.map((e, i) => (
                  <div key={`${e.ts}-${i}`} className="flex items-center gap-2.5 text-xs">
                    <span className="text-zinc-500 tabular-nums w-14 shrink-0">{formatAgo(e.ts)}</span>
                    {actionBadge(e.action)}
                    <span className="truncate flex-1">
                      <span className="text-white">{e.display_name || <span className="text-zinc-500 font-mono">{e.key_short}</span>}</span>
                      {e.xp_gained > 0 && <span className="text-emerald-400"> +{e.xp_gained} XP</span>}
                      <span className="text-zinc-500"> → {e.xp_total} total (L{e.level})</span>
                      {e.detail && <span className="text-zinc-500"> · {e.detail}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Pricing */}
        {pricing && (
          <section className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5">
            <h2 className="text-lg font-semibold mb-3">Pricing</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              {Object.entries(pricing.prices_mcents).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-zinc-800 bg-black/40 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500">{k.replace(/_/g, " ")}</div>
                  <div className="mt-1 text-lg font-mono">${pricing.prices_usd[k]}</div>
                  <div className="text-[11px] text-zinc-500">{v} mcents</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              1 mcent = 1/1000¢. A complete pipeline (gather 5 images → label all → train 10-epoch YOLO) costs about <span className="text-zinc-300">$0.031</span>.
            </p>
          </section>
        )}

        {/* CTA */}
        <section className="mt-8 rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/5 p-6">
          <h2 className="text-lg font-semibold">Get an API key</h2>
          <p className="mt-1 text-sm text-zinc-400 max-w-xl">
            Keys include a starting balance you can top up later. Agents use <code className="text-zinc-300">Authorization: Bearer dlf_...</code> against{" "}
            <code className="text-zinc-300">{GATEWAY}</code>.
          </p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <a
              href="mailto:hello@datalabelfactory.dev?subject=DLF%20agent%20key%20request"
              className="rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 px-4 py-2 font-semibold"
            >
              Request a key →
            </a>
            <a
              href={`${GATEWAY}/v1/pricing`}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-4 py-2"
            >
              API reference
            </a>
            <Link href="/go" className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-4 py-2">
              Try the UI yourself
            </Link>
          </div>
        </section>

        <footer className="mt-12 pb-12 text-xs text-zinc-600">
          Gateway: <code>{GATEWAY}</code> · Powered by Cloudflare Workers + Durable Objects
        </footer>
      </div>
    </div>
  );
}
