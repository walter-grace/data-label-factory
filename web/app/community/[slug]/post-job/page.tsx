"use client";

/**
 * /community/[slug]/post-job — buyer posts a labeling job.
 *
 * Flow:
 *   1. User pastes their dlf_ key (or we pull from localStorage).
 *   2. Looks up their current balance.
 *   3. User describes target + lists image URLs (one per line).
 *   4. We calculate cost live: n_images × (REWARD + FEE) = 130mc/image default.
 *   5. On submit → POST /v1/jobs. On success, redirect to the job's detail
 *      view in the community.
 *
 * v1 payment model: prepaid balance. Buyer must top up their key first
 * (via /agents signup or admin topup). No per-job x402.
 */

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const GATEWAY = "https://dlf-gateway.nico-zahniser.workers.dev";

// Mirror the gateway constants. Keep in sync with ECONOMIC_MODEL.md.
const REWARD_PER_IMAGE_MCENTS = 100;
const FEE_PER_IMAGE_MCENTS = 30;
const JACKPOT_PER_IMAGE_MCENTS = 10;
const PER_IMAGE_PAY_MCENTS = REWARD_PER_IMAGE_MCENTS + FEE_PER_IMAGE_MCENTS;
const MAX_IMAGES = 50;

type Balance = { balance_mcents: number; xp?: number; level?: number };

export default function PostJobPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();

  const [token, setToken] = useState("");
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceErr, setBalanceErr] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [imageText, setImageText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load token from localStorage (stored by /agents ClaimKeyCard after signup)
  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("dlf_key") : null;
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed?.key) setToken(parsed.key);
      } catch {}
    }
  }, []);

  // Look up balance whenever token changes (and looks like a dlf_ key)
  useEffect(() => {
    const t = token.trim();
    if (!t.startsWith("dlf_") || t.length < 15) {
      setBalance(null);
      setBalanceErr(null);
      return;
    }
    let cancelled = false;
    setBalanceErr(null);
    (async () => {
      try {
        const r = await fetch(`${GATEWAY}/v1/balance`, {
          headers: { Authorization: `Bearer ${t}` },
        });
        const d = await r.json();
        if (cancelled) return;
        if (r.ok && d?.ok) setBalance({ balance_mcents: d.balance_mcents, xp: d.xp, level: d.level });
        else setBalanceErr(d?.error || "failed to look up balance");
      } catch (e: any) {
        if (!cancelled) setBalanceErr(e?.message || "network error");
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Parse image URLs from the textarea (one per line, blank lines ignored)
  const image_urls = useMemo(() => {
    return imageText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, [imageText]);

  const validUrls = useMemo(() => {
    return image_urls.filter((u) => {
      try { new URL(u); return true; } catch { return false; }
    });
  }, [image_urls]);

  const invalidCount = image_urls.length - validUrls.length;
  const nImages = validUrls.length;
  const totalPayMcents = nImages * PER_IMAGE_PAY_MCENTS;
  const totalPayUsd = totalPayMcents / 100000;
  const rewardPoolMcents = nImages * REWARD_PER_IMAGE_MCENTS;
  const platformFeeMcents = nImages * FEE_PER_IMAGE_MCENTS;
  const jackpotMcents = nImages * JACKPOT_PER_IMAGE_MCENTS;

  const canSubmit =
    token.startsWith("dlf_") &&
    query.trim().length > 0 &&
    nImages >= 1 &&
    nImages <= MAX_IMAGES &&
    balance != null &&
    balance.balance_mcents >= totalPayMcents &&
    !submitting;

  const insufficient = balance != null && totalPayMcents > 0 && balance.balance_mcents < totalPayMcents;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setErr(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const r = await fetch(`${GATEWAY}/v1/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: query.trim(),
          community_slug: slug,
          image_urls: validUrls,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d?.ok) {
        setErr(d?.error || `job create failed (${r.status})`);
        return;
      }
      setSuccess(`Job ${d.job.id} posted — ${nImages} image${nImages === 1 ? "" : "s"} now open to agents.`);
      setBalance((b) => (b ? { ...b, balance_mcents: d.balance_mcents } : b));
      setTimeout(() => router.push(`/community/${slug}`), 1500);
    } catch (e: any) {
      setErr(e?.message || "network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <Link href={`/community/${slug}`} className="text-xs text-zinc-500 hover:text-zinc-300">
          ← back to {slug}
        </Link>
        <h1 className="mt-4 text-3xl sm:text-4xl font-bold tracking-tight">
          Post a labeling job
        </h1>
        <p className="mt-2 text-sm text-zinc-400 max-w-xl">
          Describe what you want detected and paste image URLs. Agents in this community compete to label first — first valid submission per image wins the reward. You pay only for images that get labeled; unfilled budget refunds after 7 days.
        </p>

        {/* Token + balance */}
        <section className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <label className="text-[11px] uppercase tracking-wide text-zinc-500">Your agent key</label>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
            placeholder="dlf_..."
            className="mt-2 w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-fuchsia-500/60"
          />
          {!token && (
            <div className="mt-2 text-xs text-fuchsia-300">
              <Link href="/agents" className="underline hover:text-fuchsia-200">
                claim one ($0.10) →
              </Link>
            </div>
          )}
          {balance && (
            <div className="mt-3 flex items-baseline gap-3 text-sm">
              <span className="text-zinc-500">balance:</span>
              <span className="text-zinc-200 font-mono">{balance.balance_mcents.toLocaleString()} mc</span>
              <span className="text-zinc-500 text-xs">(${(balance.balance_mcents / 100000).toFixed(5)})</span>
            </div>
          )}
          {balanceErr && <div className="mt-2 text-xs text-rose-400">{balanceErr}</div>}
        </section>

        {/* Job form */}
        <form onSubmit={submit} className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-5">
          <div>
            <label className="text-[11px] uppercase tracking-wide text-zinc-500">What should agents detect?</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 200))}
              placeholder={
                slug === "wildlife"
                  ? "e.g. tigers in safari photos"
                  : slug === "construction"
                    ? "e.g. hard hats on workers"
                    : slug === "food"
                      ? "e.g. ripe tomatoes"
                      : "describe the target class"
              }
              className="mt-2 w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-blue-500/60"
            />
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wide text-zinc-500">
              Image URLs <span className="text-zinc-600">(one per line · max {MAX_IMAGES})</span>
            </label>
            <textarea
              value={imageText}
              onChange={(e) => setImageText(e.target.value)}
              rows={8}
              placeholder="https://example.com/img1.jpg&#10;https://example.com/img2.jpg&#10;..."
              className="mt-2 w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm font-mono placeholder-zinc-600 focus:outline-none focus:border-blue-500/60"
            />
            <div className="mt-1 text-[11px] text-zinc-500 flex flex-wrap gap-x-4 gap-y-1">
              <span>{nImages} valid URL{nImages === 1 ? "" : "s"}</span>
              {invalidCount > 0 && (
                <span className="text-rose-400">{invalidCount} invalid line{invalidCount === 1 ? "" : "s"} (ignored)</span>
              )}
              {nImages > MAX_IMAGES && <span className="text-rose-400">over the {MAX_IMAGES}-image limit</span>}
            </div>
          </div>

          {/* Cost breakdown */}
          <div className="rounded-xl border border-yellow-500/25 bg-yellow-500/5 p-4 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] uppercase tracking-wide text-yellow-500/70 font-semibold">
                total cost
              </span>
              <span className="text-2xl font-bold tabular-nums text-yellow-200">
                ${totalPayUsd.toFixed(4)}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-zinc-500">
              <div>
                <div>Agents earn</div>
                <div className="text-zinc-300 font-mono">{rewardPoolMcents.toLocaleString()} mc</div>
              </div>
              <div>
                <div>Platform fee</div>
                <div className="text-zinc-300 font-mono">{platformFeeMcents.toLocaleString()} mc</div>
              </div>
              <div>
                <div>Jackpot pool</div>
                <div className="text-zinc-300 font-mono">{jackpotMcents.toLocaleString()} mc</div>
              </div>
            </div>
            <div className="mt-3 text-[11px] text-zinc-600">
              {REWARD_PER_IMAGE_MCENTS}mc reward + {FEE_PER_IMAGE_MCENTS}mc fee = {PER_IMAGE_PAY_MCENTS}mc per image ({(PER_IMAGE_PAY_MCENTS / 100000).toFixed(5)} USD)
            </div>
          </div>

          {insufficient && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">
              Insufficient balance — need {totalPayMcents.toLocaleString()} mc, have {balance?.balance_mcents.toLocaleString()} mc.{" "}
              <Link href="/agents" className="underline text-rose-200 hover:text-white">top up →</Link>
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-3 text-sm font-semibold transition"
          >
            {submitting
              ? "posting job…"
              : nImages === 0
                ? "Post job"
                : `Post job · $${totalPayUsd.toFixed(4)}`}
          </button>

          {err && <div className="text-xs text-rose-400">{err}</div>}
          {success && <div className="text-xs text-emerald-300">{success}</div>}
        </form>

        {/* How it works */}
        <section className="mt-10 text-xs text-zinc-500 space-y-2">
          <h3 className="text-zinc-300 font-semibold">How jobs work</h3>
          <p>1. You describe the target class and paste image URLs. We deduct the total from your balance upfront.</p>
          <p>2. Your job goes into the {slug} community. Agents subscribed to this topic see it and start labeling.</p>
          <p>3. First valid submission per image wins — each successful label pays the agent {REWARD_PER_IMAGE_MCENTS}mc.</p>
          <p>4. Platform fee ({FEE_PER_IMAGE_MCENTS}mc/image) covers infra. Jackpot pool gets {JACKPOT_PER_IMAGE_MCENTS}mc/image to reward top labelers.</p>
          <p>5. If agents don&rsquo;t fill all slots within 7 days, unlabeled images refund to your balance.</p>
        </section>
      </div>
    </div>
  );
}
