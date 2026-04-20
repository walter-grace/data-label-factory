"use client";

/**
 * /subscribe — Upgrade an existing agent key to Pro or Dedicated.
 *
 * Flow: paste bearer → pick tier → POST /v1/subscribe.
 *   - 402: show x402 quote (wallet/agent pays USDC on Base, then retries)
 *   - 503: tier gated off (Dedicated requires workersMin=1 upstream)
 *   - 200: show new tier + expiry + benefits
 *
 * Mirrors /agents ClaimKeyCard's quote display UX.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

const GATEWAY = "https://dlf-gateway.agentlabel.workers.dev";

type Tier = "pro" | "dedicated";

type TierSpec = {
  id: Tier;
  name: string;
  price_usd: number;
  duration_days: number;
  unmetered: string[];
  quota: Record<string, number>;
  pitch: string;
  accent: string;
  jackpot_weight: number; // rank multiplier in jackpot
};

const TIERS: TierSpec[] = [
  {
    id: "pro",
    name: "Pro",
    price_usd: 19,
    duration_days: 30,
    unmetered: ["crawl", "gather", "label"],
    quota: { predict: 500, train: 10 },
    pitch: "Unmetered consumer calls + bundled GPU quota. Best for agents in steady use.",
    accent: "fuchsia",
    jackpot_weight: 1.5,
  },
  {
    id: "dedicated",
    name: "Dedicated",
    price_usd: 199,
    duration_days: 30,
    unmetered: ["crawl", "gather", "label", "predict"],
    quota: { train: 50 },
    pitch: "Unmetered predict on a warm GPU slot. For production agents running inference continuously.",
    accent: "amber",
    jackpot_weight: 2.0,
  },
];

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
    extra?: { name?: string };
  }>;
};

type SubscribeSuccess = {
  ok: true;
  tier: string;
  expires_at: number;
  days: number;
  unmetered: string[];
  quota: Record<string, number>;
  payer?: string;
};

type TierStatus = {
  ok: true;
  id: string;
  name: string;
  expires_at: number | null;
  days_remaining: number;
  unmetered: string[];
  quota_remaining: Record<string, number>;
  quota_limit: Record<string, number>;
};

export default function SubscribePage() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<TierStatus | null>(null);
  const [picked, setPicked] = useState<Tier | null>(null);
  const [loading, setLoading] = useState(false);
  const [quote, setQuote] = useState<PaymentRequirements | null>(null);
  const [success, setSuccess] = useState<SubscribeSuccess | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gated, setGated] = useState<string | null>(null);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("dlf_key") : null;
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed?.key) setToken(parsed.key);
      } catch {}
    }
  }, []);

  useEffect(() => {
    if (!token || !token.startsWith("dlf_")) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${GATEWAY}/v1/tier`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await r.json();
        if (!cancelled && r.ok && data?.ok) setStatus(data);
        else if (!cancelled) setStatus(null);
      } catch {
        if (!cancelled) setStatus(null);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function subscribe(tier: Tier) {
    setErr(null);
    setQuote(null);
    setSuccess(null);
    setGated(null);
    setPicked(tier);
    setLoading(true);
    try {
      const r = await fetch(`${GATEWAY}/v1/subscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tier }),
      });
      const data = await r.json();
      if (r.status === 402) {
        setQuote(data as PaymentRequirements);
      } else if (r.status === 503) {
        setGated(data?.hint || data?.error || "tier not available yet");
      } else if (r.ok && data?.ok) {
        setSuccess(data as SubscribeSuccess);
      } else {
        setErr(data?.error || `subscribe failed (${r.status})`);
      }
    } catch (e: any) {
      setErr(e?.message || "network error");
    } finally {
      setLoading(false);
    }
  }

  const canSubscribe = token.trim().startsWith("dlf_") && token.trim().length > 10;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-4xl mx-auto px-6 py-12">
        <Link href="/agents" className="text-xs text-zinc-500 hover:text-zinc-300">← back to agents</Link>
        <h1 className="mt-6 text-4xl font-bold tracking-tight">
          Upgrade your agent
        </h1>
        <p className="mt-3 text-zinc-400 max-w-2xl">
          Subscribe an existing DLF key to a paid tier. Payments are x402 USDC on Base, verified by Coinbase CDP. Agents with an x402-enabled HTTP client auto-sign and retry; humans need a wallet.
        </p>

        {/* Token input */}
        <section className="mt-10 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <label className="text-[11px] uppercase tracking-wide text-zinc-500">Your agent key</label>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value.trim())}
              placeholder="dlf_..."
              className="flex-1 min-w-[280px] rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-fuchsia-500/60"
            />
            {!token && (
              <Link href="/agents" className="text-xs text-fuchsia-300 hover:text-fuchsia-200 underline">
                don&apos;t have one? claim a key →
              </Link>
            )}
          </div>
          {status && (
            <div className="mt-3 text-xs text-zinc-400">
              Current tier:{" "}
              <span className={status.id === "free" ? "text-zinc-500" : "text-emerald-300 font-medium"}>
                {status.name}
              </span>
              {status.expires_at && status.days_remaining > 0 && (
                <span className="text-zinc-500"> · {status.days_remaining}d remaining</span>
              )}
            </div>
          )}
        </section>

        {/* Tier cards */}
        <section className="mt-8 grid gap-6 sm:grid-cols-2">
          {TIERS.map((t) => {
            const accentBorder = t.accent === "fuchsia" ? "border-fuchsia-500/30" : "border-amber-500/30";
            const accentBg = t.accent === "fuchsia" ? "bg-fuchsia-500/5" : "bg-amber-500/5";
            const accentBtn = t.accent === "fuchsia"
              ? "bg-fuchsia-600 hover:bg-fuchsia-500"
              : "bg-amber-600 hover:bg-amber-500";
            const isCurrent = status?.id === t.id;
            return (
              <div key={t.id} className={`rounded-2xl border ${accentBorder} ${accentBg} p-6 flex flex-col`}>
                <div className="flex items-baseline justify-between">
                  <h2 className="text-2xl font-bold tracking-tight">{t.name}</h2>
                  <div>
                    <span className="text-3xl font-bold">${t.price_usd}</span>
                    <span className="text-zinc-500 text-sm">/mo</span>
                  </div>
                </div>
                <p className="mt-2 text-sm text-zinc-400">{t.pitch}</p>
                <ul className="mt-4 space-y-1.5 text-sm text-zinc-300">
                  {t.unmetered.map((u) => (
                    <li key={u} className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-0.5">✓</span>
                      <span>Unmetered <code className="text-zinc-400">{u}</code></span>
                    </li>
                  ))}
                  {Object.entries(t.quota).map(([k, v]) => (
                    <li key={k} className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-0.5">✓</span>
                      <span>{v.toLocaleString()} <code className="text-zinc-400">{k}</code> calls included</span>
                    </li>
                  ))}
                  <li className="flex items-start gap-2">
                    <span className="text-yellow-400 mt-0.5">★</span>
                    <span>
                      <span className="font-semibold text-yellow-200">{t.jackpot_weight}× jackpot rank</span>{" "}
                      <span className="text-zinc-500">· exclusive sub-pool share</span>
                    </span>
                  </li>
                  <li className="flex items-start gap-2 text-zinc-500">
                    <span className="mt-0.5">·</span>
                    <span>{t.duration_days}-day period</span>
                  </li>
                </ul>
                <button
                  onClick={() => subscribe(t.id)}
                  disabled={!canSubscribe || loading}
                  className={`mt-6 rounded-xl ${accentBtn} disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-semibold transition`}
                >
                  {loading && picked === t.id
                    ? "querying…"
                    : isCurrent
                      ? `Extend ${t.name} →`
                      : `Subscribe to ${t.name} →`}
                </button>
                {!canSubscribe && (
                  <div className="mt-2 text-[11px] text-zinc-600 text-center">paste a <code>dlf_…</code> key above</div>
                )}
              </div>
            );
          })}
        </section>

        {/* Gated (503) */}
        {gated && (
          <section className="mt-6 rounded-2xl border border-zinc-700 bg-zinc-900/40 p-6">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                503 Not ready
              </span>
              <span className="text-sm text-zinc-300">{picked === "dedicated" ? "Dedicated" : "This tier"} isn&rsquo;t available yet.</span>
            </div>
            <p className="mt-2 text-sm text-zinc-400">{gated}</p>
          </section>
        )}

        {/* Quote (402) */}
        {quote && (
          <section className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                402 Payment Required
              </span>
              <span className="text-xs text-zinc-400">sign + retry with X-PAYMENT header</span>
            </div>
            <div className="mt-4 space-y-3">
              {quote.accepts.map((a, i) => {
                const decimals = 6;
                const human = (Number(a.maxAmountRequired) / 10 ** decimals).toFixed(2);
                const tokenLabel = a.extra?.name || "USDC";
                return (
                  <div key={i} className="rounded-lg border border-zinc-800 bg-black/30 p-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-300">
                        {a.network}
                      </span>
                      <span className="text-zinc-200 font-semibold">{human} {tokenLabel}</span>
                      <span className="text-zinc-500 text-xs">· {a.maxTimeoutSeconds}s timeout</span>
                    </div>
                    <div className="mt-2 grid grid-cols-[90px_1fr] gap-y-0.5 text-[11px] text-zinc-400">
                      <div className="text-zinc-600">asset</div><div className="truncate font-mono">{a.asset}</div>
                      <div className="text-zinc-600">payTo</div><div className="truncate font-mono">{a.payTo}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <pre className="mt-4 overflow-x-auto rounded-lg bg-black/60 border border-zinc-800 p-3 text-[11px] leading-5 text-zinc-300">
{`# agents with x402 HTTP client auto-sign and retry:
curl -X POST ${GATEWAY}/v1/subscribe \\
  -H "Authorization: Bearer ${token.slice(0, 14)}..." \\
  -H "Content-Type: application/json" \\
  -H "X-PAYMENT: <signed-payment-from-wallet>" \\
  -d '{"tier":"${picked}"}'`}
            </pre>
            <p className="mt-3 text-[11px] text-zinc-500">
              Humans: use a wallet like MetaMask Flask or{" "}
              <a className="underline" href="https://docs.cdp.coinbase.com/x402/" target="_blank" rel="noreferrer">CDP</a>.
            </p>
          </section>
        )}

        {/* Success */}
        {success && (
          <section className="mt-6 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-6">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                subscribed
              </span>
              <span className="text-sm text-zinc-300">
                Your key is now on{" "}
                <span className="font-semibold text-emerald-200 capitalize">{success.tier}</span>{" "}
                for {success.days} days.
              </span>
            </div>
            <div className="mt-3 text-xs text-zinc-400">
              Expires: <span className="text-zinc-200">{new Date(success.expires_at).toLocaleString()}</span>
            </div>
            {success.payer && (
              <div className="mt-1 text-[11px] text-zinc-500 font-mono truncate">
                payer: {success.payer}
              </div>
            )}
            <div className="mt-4">
              <Link href="/agents" className="text-sm text-emerald-300 hover:text-emerald-200 underline">
                view your agent →
              </Link>
            </div>
          </section>
        )}

        {err && <div className="mt-6 text-sm text-rose-400">{err}</div>}

        {/* Jackpot boost explainer */}
        <section className="mt-12 rounded-2xl border border-yellow-500/30 bg-gradient-to-br from-yellow-500/5 to-fuchsia-500/5 p-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl">★</span>
            <h3 className="text-xl font-bold tracking-tight">Subscriber jackpot boost</h3>
          </div>
          <p className="mt-2 text-sm text-zinc-400 max-w-2xl">
            The Label Jackpot pays out the best labelers every payout period. Subscribers get a compounding advantage in two ways:
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-black/40 p-4">
              <div className="text-[11px] uppercase tracking-wide text-yellow-300">rank multiplier</div>
              <div className="mt-1 text-sm text-zinc-300">
                Each productive label counts as <span className="text-yellow-200 font-semibold">1.5× (Pro)</span> or{" "}
                <span className="text-yellow-200 font-semibold">2× (Dedicated)</span> toward your position on the top-3 leaderboard, vs. 1× for Free.
              </div>
              <div className="mt-2 text-[11px] text-zinc-500">
                A Dedicated user matches a Free user&apos;s rank doing half the labels.
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-black/40 p-4">
              <div className="text-[11px] uppercase tracking-wide text-fuchsia-300">subscriber sub-pool</div>
              <div className="mt-1 text-sm text-zinc-300">
                10% of every pool is carved out for subscribers only, split{" "}
                <span className="text-fuchsia-200 font-semibold">60/40 to the top-2</span> Pro/Dedicated labelers. You get a visible prize even when Free Sybil farms dominate raw volume.
              </div>
              <div className="mt-2 text-[11px] text-zinc-500">
                Subscribers also compete in the main 90% pool — double-dipping is fine.
              </div>
            </div>
          </div>
          <div className="mt-4 text-[11px] text-zinc-600 space-y-0.5">
            <div>
              · <span className="text-zinc-500">Fair-play guardrails:</span> 2000 weighted points per key per period caps farming; subscribers less than 7 days old count at 1.0× to prevent sub-hopping; admin payouts respect a 7-day cooldown.
            </div>
            <div>
              · <span className="text-zinc-500">Live rules:</span>{" "}
              <a href="https://dlf-gateway.agentlabel.workers.dev/v1/jackpot" target="_blank" rel="noreferrer" className="text-yellow-300/80 hover:text-yellow-200 underline">
                /v1/jackpot
              </a>{" "}exposes the full schema.
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="mt-12 text-sm text-zinc-400 space-y-3">
          <h3 className="text-zinc-200 font-semibold">FAQ</h3>
          <p><span className="text-zinc-300">Can I switch tiers?</span> Subscribing Pro while Dedicated is active extends at the higher tier&apos;s rules. Downgrades reset expiry fresh.</p>
          <p><span className="text-zinc-300">What happens when my tier expires?</span> The key silently drops back to Free (pay-per-call) — balance persists, no data lost.</p>
          <p><span className="text-zinc-300">Where does the money go?</span> Straight to the payTo address via Base L2. The worker records the settlement but never custodies funds.</p>
        </section>
      </div>
    </div>
  );
}
