"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SiteNav from "@/components/SiteNav";

const GATEWAY = "https://dlf-gateway.agentlabel.workers.dev";

type Balance = {
  ok: boolean;
  balance_mcents: number;
  xp: number;
  level: number;
  display_name?: string;
  tier?: string;
  calls_by_type?: Record<string, number>;
};

type UploadRow = {
  url: string;
  object_key: string;
  size: number;
  content_type?: string;
  uploaded_at?: number;
  original_name?: string;
};

type ModelRow = {
  job_id: string;
  published: boolean;
  display_name?: string;
  description?: string;
  uses: number;
  revenue_mcents: number;
  created_at?: number;
  published_at?: number;
  predict_url: string;
};

function formatUSD(mcents: number): string {
  return `$${(mcents / 100000).toFixed(3)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function DashboardPage() {
  const [token, setToken] = useState("");
  const [balance, setBalance] = useState<Balance | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("dlf_key");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.key?.startsWith("dlf_")) setToken(parsed.key);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const hdrs = { Authorization: `Bearer ${token}` };
        const [b, u, m] = await Promise.all([
          fetch(`${GATEWAY}/v1/balance`, { headers: hdrs }).then((r) => r.json()),
          fetch(`${GATEWAY}/v1/my-uploads`, { headers: hdrs }).then((r) => r.json()),
          fetch(`${GATEWAY}/v1/my-models`, { headers: hdrs }).then((r) => r.json()),
        ]);
        if (cancelled) return;
        if (b?.ok) setBalance(b);
        else setErr(b?.error || "failed to load balance");
        setUploads(u?.uploads || []);
        setModels(m?.models || []);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteNav />

      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Your account</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Balance, trained models, and image uploads — tied to your
            <code className="mx-1 rounded bg-zinc-900 px-1.5 py-0.5 text-xs">dlf_</code>
            key.
          </p>
        </div>

        {!token && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
            <div className="text-lg font-semibold text-zinc-200">No agent key in this browser</div>
            <p className="mt-2 text-sm text-zinc-400">
              Claim a free agent key (0.10 USDC via x402) to see your dashboard.
            </p>
            <Link
              href="/agents"
              className="mt-4 inline-block rounded-lg bg-blue-600 px-6 py-2 text-sm font-semibold hover:bg-blue-500"
            >
              Claim a key →
            </Link>
          </div>
        )}

        {token && loading && (
          <div className="text-sm text-zinc-500">Loading your account…</div>
        )}

        {token && err && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            {err}
          </div>
        )}

        {token && balance && (
          <>
            {/* Balance + XP summary */}
            <div className="grid gap-4 sm:grid-cols-4 mb-8">
              <StatCard label="Agent" value={balance.display_name || "—"} hint={balance.tier || ""} />
              <StatCard label="Balance" value={formatUSD(balance.balance_mcents)} hint={`${balance.balance_mcents} mcents`} />
              <StatCard label="XP" value={String(balance.xp)} hint={`level ${balance.level}`} />
              <StatCard label="Models" value={String(models.length)} hint={`${uploads.length} uploads`} />
            </div>

            {/* Models */}
            <section className="mb-10">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xl font-semibold">Your trained models</h2>
                <Link href="/build" className="text-xs text-blue-400 hover:text-blue-300">Train another →</Link>
              </div>
              {models.length === 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-500">
                  No models yet. Drop images on <Link href="/build" className="text-blue-400 hover:text-blue-300">/build</Link> and run training.
                </div>
              ) : (
                <div className="space-y-2">
                  {models.map((m) => (
                    <div
                      key={m.job_id}
                      className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 flex items-center gap-4"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-200 truncate">
                            {m.display_name || m.job_id.slice(0, 24) + "…"}
                          </span>
                          {m.published ? (
                            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                              PUBLISHED
                            </span>
                          ) : (
                            <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-bold text-zinc-400">
                              PRIVATE
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-zinc-500">
                          <span className="font-mono">{m.job_id}</span>
                          <span>·</span>
                          <span>{m.uses} uses</span>
                          <span>·</span>
                          <span>{formatUSD(m.revenue_mcents)} earned</span>
                          {m.published_at && (
                            <>
                              <span>·</span>
                              <span>{timeAgo(m.published_at)}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <a
                        href={m.predict_url}
                        className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium hover:border-blue-500"
                      >
                        Predict URL
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Uploads */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xl font-semibold">Your uploads</h2>
                <Link href="/build" className="text-xs text-blue-400 hover:text-blue-300">Upload more →</Link>
              </div>
              {uploads.length === 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-500">
                  No uploads yet. Drop images on <Link href="/build" className="text-blue-400 hover:text-blue-300">/build</Link> and click "Push to Agent Swarm".
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {uploads.map((u) => (
                    <a
                      key={u.object_key}
                      href={u.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden hover:border-blue-500"
                      title={u.original_name}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={u.url}
                        alt={u.original_name || ""}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="aspect-square w-full object-cover bg-zinc-950"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                      <div className="p-2 text-[10px] text-zinc-500 flex items-center justify-between">
                        <span className="truncate">{u.original_name || u.object_key.split("/").pop()}</span>
                        <span className="shrink-0 ml-2">{formatBytes(u.size)}</span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-bold text-zinc-100 truncate">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-zinc-500">{hint}</div>}
    </div>
  );
}
