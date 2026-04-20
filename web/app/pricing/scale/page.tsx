"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

type Tier = {
  mrr: number;
  label: string;
  fixedCost: number;
  notes: string;
  team: string;
};

// Revenue tiers: $100k → $1B MRR.
const TIERS: Tier[] = [
  { mrr: 100_000, label: "$100k MRR", fixedCost: 15_000, notes: "3-5 warm GPUs, D1 DB, status page, on-call rotation.", team: "1-3 people" },
  { mrr: 1_000_000, label: "$1M MRR", fixedCost: 200_000, notes: "Multi-region, GPU reservation contract, SOC2, EU data residency.", team: "8-12 eng + 2 sales" },
  { mrr: 10_000_000, label: "$10M MRR", fixedCost: 3_500_000, notes: "Global inference fleet, enterprise tier, procurement motion, dedicated SRE.", team: "30-50 eng, 5 sales, 3 support" },
  { mrr: 100_000_000, label: "$100M MRR", fixedCost: 30_000_000, notes: "Multi-cloud, platform BU, on-prem option, acquisitions.", team: "150-250 eng, full sales/marketing/legal" },
  { mrr: 1_000_000_000, label: "$1B MRR", fixedCost: 250_000_000, notes: "Category leader / IPO-ready. Infra + R&D as % of revenue.", team: "500+ eng, full platform org" },
];

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtUsers(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

export default function ScalePage() {
  const [arpu, setArpu] = useState(1.42);
  const [mauPct, setMauPct] = useState(20);
  const [varCostPct, setVarCostPct] = useState(45);

  const rows = useMemo(() => {
    return TIERS.map((t) => {
      const mau = Math.round(t.mrr / arpu);
      const users = Math.round(mau / (mauPct / 100));
      const variable = t.mrr * (varCostPct / 100);
      const net = t.mrr - variable - t.fixedCost;
      const margin = (net / t.mrr) * 100;
      return { ...t, mau, users, variable, net, margin };
    });
  }, [arpu, mauPct, varCostPct]);

  const max = useMemo(() => {
    const m = Math.max(...rows.map((r) => Math.max(r.mrr, r.variable + r.fixedCost, Math.abs(r.net))));
    return Math.max(m, 1);
  }, [rows]);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <nav className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-6xl mx-auto flex items-center gap-6 px-4 h-14 text-sm">
          <Link href="/" className="font-bold text-blue-400 tracking-tight">DLF</Link>
          <Link href="/agents" className="text-zinc-400 hover:text-white">Agents</Link>
          <Link href="/how-it-works" className="text-zinc-400 hover:text-white">How it works</Link>
          <Link href="/pricing" className="text-zinc-400 hover:text-white">Pricing</Link>
          <span className="text-white font-medium">Scale</span>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Revenue tiers: what each one costs</h1>
          <p className="text-zinc-400">
            $100k → $1B MRR. For each tier: users needed, variable + fixed costs, team, and net margin. Adjust ARPU and active% to stress-test.
          </p>
        </header>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Knob
            label="ARPU ($/MAU/mo)"
            value={arpu}
            min={0.1}
            max={50}
            step={0.01}
            onChange={setArpu}
            hint="$1.42 = two-tier mix (cheap consumer + GPU-priced predict/train). $19 = Pro. $199 = Dedicated. $1500 = Enterprise."
          />
          <Knob
            label="Monthly active %"
            value={mauPct}
            min={1}
            max={100}
            step={1}
            onChange={setMauPct}
            unit="%"
            hint="Share of registered users active in a given month."
          />
          <Knob
            label="Variable cost %"
            value={varCostPct}
            min={10}
            max={95}
            step={1}
            onChange={setVarCostPct}
            unit="%"
            hint="Upstream infra (Gemma, RunPod, CF) as a share of revenue. 45% is today's ratio."
          />
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">P&amp;L by revenue tier</h2>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-950/50 text-zinc-400">
                <tr>
                  <th className="text-left px-4 py-3">Tier</th>
                  <th className="text-right px-4 py-3">Users</th>
                  <th className="text-right px-4 py-3">MAU</th>
                  <th className="text-right px-4 py-3">MRR</th>
                  <th className="text-right px-4 py-3">Variable</th>
                  <th className="text-right px-4 py-3">Fixed</th>
                  <th className="text-right px-4 py-3">Net</th>
                  <th className="text-right px-4 py-3">Margin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.mrr} className="border-t border-zinc-800">
                    <td className="px-4 py-3 font-mono">{r.label}</td>
                    <td className="px-4 py-3 text-right font-mono text-zinc-300">{fmtUsers(r.users)}</td>
                    <td className="px-4 py-3 text-right font-mono text-zinc-400">{fmtUsers(r.mau)}</td>
                    <td className="px-4 py-3 text-right font-mono text-green-400">{fmtMoney(r.mrr)}</td>
                    <td className="px-4 py-3 text-right font-mono text-red-300">{fmtMoney(r.variable)}</td>
                    <td className="px-4 py-3 text-right font-mono text-red-300">{fmtMoney(r.fixedCost)}</td>
                    <td className={`px-4 py-3 text-right font-mono font-semibold ${r.net >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {r.net >= 0 ? "+" : ""}{fmtMoney(r.net)}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono ${r.margin >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {r.margin.toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">What each tier needs</h2>
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.mrr} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <div className="flex items-baseline justify-between gap-4 flex-wrap mb-1">
                  <h3 className="font-mono text-lg text-blue-400">{r.label}</h3>
                  <div className="text-xs text-zinc-400">
                    <span className="font-mono text-zinc-300">{fmtUsers(r.users)}</span> users ·{" "}
                    <span className="font-mono text-zinc-300">{fmtUsers(r.mau)}</span> MAU ·{" "}
                    <span className="font-mono text-zinc-300">{r.team}</span>
                  </div>
                </div>
                <p className="text-sm text-zinc-400">{r.notes}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Revenue vs cost across tiers (log-scale)</h2>
          <Chart rows={rows} max={max} />
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Critical levers</h2>
          <ul className="space-y-3 text-sm text-zinc-300">
            <li>
              <span className="font-semibold text-white">ARPU is the primary lever.</span>{" "}
              At today&apos;s <span className="font-mono">${arpu.toFixed(2)}</span>, reaching $100M MRR needs{" "}
              <span className="font-mono">{fmtUsers(Math.round((100_000_000 / arpu) / (mauPct / 100)))}</span> registered agents.
              Raising ARPU to $5 (enterprise tier) drops that to{" "}
              <span className="font-mono">{fmtUsers(Math.round((100_000_000 / 5) / (mauPct / 100)))}</span>.
            </li>
            <li>
              <span className="font-semibold text-white">Variable cost % should fall with scale,</span>{" "}
              not stay flat. GPU reservations beat serverless above ~$100k MRR.
              Drop the slider to 35% to see the impact.
            </li>
            <li>
              <span className="font-semibold text-white">Fixed cost escalates non-linearly.</span>{" "}
              $100k MRR = ~$15k fixed (15%). $1B MRR = ~$250M fixed (25%). At
              hyperscale you pay for R&amp;D and compliance as much as for infra.
            </li>
          </ul>
        </section>

        <section className="mb-16 text-xs text-zinc-500 leading-relaxed">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Assumptions</h3>
          <p className="mb-2">
            Users and MAU are back-computed from the target MRR at the given
            ARPU and active%. Variable cost is a flat share (it actually
            improves with scale, which is why the slider exists). Fixed cost
            bundles infra, team, and platform investment.
          </p>
          <p>
            Team sizes are rough industry benchmarks for B2B infra companies
            at each MRR tier. The $1B row assumes public-company-grade R&amp;D
            spend (~25% of revenue) — below that level, revenue stalls.
          </p>
        </section>
      </main>
    </div>
  );
}

function Knob({
  label, value, min, max, step, onChange, hint, unit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  hint?: string;
  unit?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-2">
        <label className="text-sm text-zinc-300">{label}</label>
        <span className="font-mono text-blue-400 text-sm">
          {value.toFixed(step < 1 ? 2 : 0)}{unit || ""}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-500"
      />
      {hint && <p className="text-xs text-zinc-500 mt-2">{hint}</p>}
    </div>
  );
}

function Chart({
  rows,
  max,
}: {
  rows: { mrr: number; label: string; variable: number; fixedCost: number; net: number }[];
  max: number;
}) {
  const W = 900;
  const H = 300;
  const PAD_L = 60;
  const PAD_R = 20;
  const PAD_T = 20;
  const PAD_B = 40;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const logMax = Math.log10(max + 1);

  const xFor = (i: number) => PAD_L + (i / (rows.length - 1)) * innerW;
  const yFor = (v: number) => {
    const sign = v < 0 ? -1 : 1;
    const l = Math.log10(Math.abs(v) + 1) / logMax;
    return PAD_T + innerH / 2 - sign * l * (innerH / 2);
  };

  const mrrPath = rows.map((r, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(r.mrr)}`).join(" ");
  const costPath = rows.map((r, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(r.variable + r.fixedCost)}`).join(" ");
  const netPath = rows.map((r, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(r.net)}`).join(" ");

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        <line x1={PAD_L} y1={PAD_T + innerH / 2} x2={W - PAD_R} y2={PAD_T + innerH / 2} stroke="#3f3f46" strokeWidth={1} />
        {rows.map((r, i) => (
          <g key={r.mrr}>
            <line x1={xFor(i)} y1={PAD_T} x2={xFor(i)} y2={PAD_T + innerH} stroke="#27272a" strokeWidth={1} strokeDasharray="2 4" />
            <text x={xFor(i)} y={H - 12} textAnchor="middle" fill="#71717a" fontSize="11" fontFamily="monospace">
              {r.label}
            </text>
          </g>
        ))}
        <path d={costPath} stroke="#fb7185" strokeWidth={2} fill="none" />
        <path d={mrrPath} stroke="#34d399" strokeWidth={2} fill="none" />
        <path d={netPath} stroke="#60a5fa" strokeWidth={2.5} fill="none" />
        {rows.map((r, i) => (
          <g key={`pts_${r.mrr}`}>
            <circle cx={xFor(i)} cy={yFor(r.mrr)} r={3} fill="#34d399" />
            <circle cx={xFor(i)} cy={yFor(r.variable + r.fixedCost)} r={3} fill="#fb7185" />
            <circle cx={xFor(i)} cy={yFor(r.net)} r={4} fill="#60a5fa" />
          </g>
        ))}
      </svg>
      <div className="flex gap-6 text-xs text-zinc-400 mt-2 justify-center">
        <span className="flex items-center gap-2"><span className="w-3 h-0.5 bg-emerald-400" />MRR</span>
        <span className="flex items-center gap-2"><span className="w-3 h-0.5 bg-rose-400" />Total cost</span>
        <span className="flex items-center gap-2"><span className="w-3 h-0.5 bg-blue-400" />Net profit</span>
      </div>
    </div>
  );
}
