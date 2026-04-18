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
const FARM_THINK = "https://dlf-agent-farm-think.nico-zahniser.workers.dev";
const POLL_MS = 8000;

function WakeAgentButton({ name, onWake }: { name: "scout" | "specialist" | "explorer"; onWake: () => void }) {
  const [state, setState] = useState<"idle" | "waking" | "ok" | "err">("idle");
  async function wake(e: React.MouseEvent) {
    e.preventDefault();
    setState("waking");
    try {
      const r = await fetch(`${FARM_THINK}/tick/${name}`, { method: "POST" });
      setState(r.ok ? "ok" : "err");
      if (r.ok) {
        // Let the gateway's DO catch the new activity entry before refresh.
        setTimeout(() => { onWake(); setState("idle"); }, 1500);
      } else {
        setTimeout(() => setState("idle"), 2000);
      }
    } catch {
      setState("err");
      setTimeout(() => setState("idle"), 2000);
    }
  }
  const label = state === "waking" ? "…" : state === "ok" ? "✓" : state === "err" ? "!" : "Wake";
  const cls =
    state === "ok"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : state === "err"
        ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
        : state === "waking"
          ? "border-zinc-700 bg-zinc-800/60 text-zinc-400"
          : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-fuchsia-500/50 hover:text-fuchsia-300";
  return (
    <button
      onClick={wake}
      disabled={state === "waking"}
      title={`Force ${name} to run a gather+label cycle now`}
      className={`inline-flex items-center rounded-md border text-[10px] font-semibold px-2 py-0.5 transition ${cls}`}
    >
      {label}
    </button>
  );
}

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

type PaymentRequirements = {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    resource: string;
    description: string;
    payTo: string;
    asset: string;
    maxTimeoutSeconds: number;
  }>;
};

function ClaimKeyCard() {
  const [name, setName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [quote, setQuote] = useState<PaymentRequirements | null>(null);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("dlf_key") : null;
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setKey(parsed.key);
        setBalance(parsed.balance_mcents);
        setDisplayName(parsed.display_name);
      } catch {}
    }
  }, []);

  async function claim() {
    setErr(null);
    setQuote(null);
    setLoading(true);
    try {
      const r = await fetch(`${GATEWAY}/v1/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: name || undefined }),
      });
      const data = await r.json();
      if (r.status === 402) {
        setQuote(data as PaymentRequirements);
        setErr(null);
      } else if (!r.ok || !data?.key) {
        setErr(data?.error || `signup failed (${r.status})`);
      } else {
        setKey(data.key);
        setBalance(data.balance_mcents);
        setDisplayName(data.display_name);
        localStorage.setItem(
          "dlf_key",
          JSON.stringify({ key: data.key, balance_mcents: data.balance_mcents, display_name: data.display_name }),
        );
      }
    } catch (e: any) {
      setErr(e?.message || "network error");
    } finally {
      setLoading(false);
    }
  }

  function copy() {
    if (!key) return;
    navigator.clipboard.writeText(key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function reset() {
    localStorage.removeItem("dlf_key");
    setKey(null);
    setBalance(null);
    setDisplayName(null);
    setName("");
  }

  if (key) {
    return (
      <section className="mt-8 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-6">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
            active key
          </span>
          {displayName && <span className="text-sm text-zinc-400">as <span className="text-zinc-200 font-medium">{displayName}</span></span>}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-lg bg-black/60 border border-zinc-800 px-3 py-2 text-xs text-zinc-300">
            {key}
          </code>
          <button
            onClick={copy}
            className="rounded-lg border border-zinc-700 hover:border-zinc-500 px-3 py-2 text-xs"
          >
            {copied ? "copied!" : "copy"}
          </button>
        </div>
        <div className="mt-2 text-xs text-zinc-400">
          balance: <span className="text-zinc-200">{balance?.toLocaleString()} mcents</span>{" "}
          <span className="text-zinc-600">(${((balance ?? 0) / 100000).toFixed(5)})</span>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Use via cURL</div>
            <pre className="overflow-x-auto rounded-lg bg-black/60 border border-zinc-800 p-3 text-[11px] leading-5 text-zinc-300">
{`curl -X POST ${GATEWAY}/v1/gather \\
  -H "Authorization: Bearer ${key.slice(0, 20)}..." \\
  -H "Content-Type: application/json" \\
  -d '{"query":"red barn","max_images":3}'`}
            </pre>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Install in Claude Desktop / Cursor / Zed (MCP)</div>
            <pre className="overflow-x-auto rounded-lg bg-black/60 border border-zinc-800 p-3 text-[11px] leading-5 text-zinc-300">
{`{
  "mcpServers": {
    "data-label-factory": {
      "transport": "http",
      "url": "${GATEWAY}/mcp",
      "headers": { "Authorization": "Bearer ${key.slice(0, 20)}..." }
    }
  }
}`}
            </pre>
            <div className="mt-1 text-[11px] text-zinc-500">
              8 tools: <code>dlf_gather</code>, <code>dlf_label</code>, <code>dlf_crawl</code>, <code>dlf_train_yolo</code>, <code>dlf_train_status</code>, <code>dlf_balance</code>, <code>dlf_pricing</code>, <code>dlf_leaderboard</code>
            </div>
          </div>
        </div>
        <button
          onClick={reset}
          className="mt-3 text-[11px] text-zinc-500 hover:text-zinc-300 underline"
        >
          forget this key
        </button>
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/5 p-6">
      <h2 className="text-lg font-semibold">Claim an agent key</h2>
      <p className="mt-1 text-sm text-zinc-400 max-w-xl">
        Pay <span className="text-zinc-200">$0.10 USDC on Base</span> via <a className="text-fuchsia-300 underline" href="https://x402.org" target="_blank" rel="noreferrer">x402</a> (verified by Coinbase CDP) to mint a key with{" "}
        <span className="text-zinc-200">20,000 mcents ($0.20)</span> starter balance — 2× your payment, enough to train a model and run a handful of predictions.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 32))}
          placeholder="display name (optional)"
          className="flex-1 min-w-[220px] rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm placeholder-zinc-600 focus:outline-none focus:border-fuchsia-500/60"
        />
        <button
          onClick={claim}
          disabled={loading}
          className="rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold"
        >
          {loading ? "querying…" : "Get quote →"}
        </button>
      </div>

      {quote && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs space-y-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
              402 Payment Required
            </span>
            <span className="text-zinc-400">pay this and retry with X-PAYMENT header</span>
          </div>
          <div className="text-[11px] text-zinc-500 pt-1">
            {quote.accepts.length} networks accepted — agents pick one:
          </div>
          {quote.accepts.map((a, i) => {
            const tokenLabel = (a as any).extra?.name || "stablecoin";
            const decimals = 6;
            const human = (Number(a.maxAmountRequired) / 10 ** decimals).toFixed(2);
            return (
              <div key={i} className="rounded-lg border border-zinc-800 bg-black/30 p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-300">
                    {a.network}
                  </span>
                  <span className="text-zinc-200 font-medium">{human} {tokenLabel}</span>
                </div>
                <div className="grid grid-cols-[90px_1fr] gap-y-0.5 text-[11px] text-zinc-400">
                  <div className="text-zinc-600">asset</div><div className="truncate font-mono">{a.asset}</div>
                  <div className="text-zinc-600">payTo</div><div className="truncate font-mono">{a.payTo}</div>
                  <div className="text-zinc-600">timeout</div><div>{a.maxTimeoutSeconds}s</div>
                </div>
              </div>
            );
          })}
          <p className="text-zinc-500 pt-1">
            Agents with an x402-enabled HTTP client will sign, resend, and succeed automatically. Humans: use a wallet like MetaMask Flask or{" "}
            <a className="underline" href="https://docs.cdp.coinbase.com/x402/" target="_blank" rel="noreferrer">CDP</a>.
          </p>
        </div>
      )}

      {err && <div className="mt-3 text-xs text-rose-400">{err}</div>}

      <p className="mt-4 text-[11px] text-zinc-500">
        Your key is stored in this browser&rsquo;s localStorage after payment. Agents use{" "}
        <code className="text-zinc-400">Authorization: Bearer dlf_...</code> against{" "}
        <code className="text-zinc-400">{GATEWAY}</code>.
      </p>
    </section>
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
                {leaderboard.map((entry, i) => {
                  const thinkName = entry.display_name?.toLowerCase().includes("scout")
                    ? "scout"
                    : entry.display_name?.toLowerCase().includes("specialist")
                      ? "specialist"
                      : entry.display_name?.toLowerCase().includes("explorer")
                        ? "explorer"
                        : null;
                  return (
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
                        {thinkName && <WakeAgentButton name={thinkName} onWake={refresh} />}
                      </div>
                    </div>
                  );
                })}
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
        <ClaimKeyCard />

        <section className="mt-4 flex flex-wrap gap-3 text-sm">
          <a
            href={`${GATEWAY}/v1/pricing`}
            target="_blank"
            rel="noreferrer"
            className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-4 py-2"
          >
            API reference
          </a>
          <Link href="/how-it-works" className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-4 py-2">
            How it works →
          </Link>
          <Link href="/go" className="rounded-xl border border-zinc-700 hover:border-zinc-500 px-4 py-2">
            Try the UI yourself
          </Link>
        </section>

        <footer className="mt-12 pb-12 text-xs text-zinc-600">
          Gateway: <code>{GATEWAY}</code> · Powered by Cloudflare Workers + Durable Objects
        </footer>
      </div>
    </div>
  );
}
