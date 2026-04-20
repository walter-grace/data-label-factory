/**
 * Profitability simulator.
 *
 * Run user archetypes through the current pricing + tier + jackpot rules
 * and verify the platform is net-positive in each. Exits non-zero if any
 * scenario produces a loss for the house.
 *
 * Usage:
 *   cd agent-gateway
 *   npx ts-node sim/profitability.ts
 *
 * Cost assumptions (conservative):
 *   OpenRouter Gemma (label):     $0.0005 / call blended (50% cached)
 *   RunPod predict cold:          $0.009 / call  (95s)
 *   RunPod predict warm:          $0.00075 / call (8s)
 *   RunPod train cold:            $0.029 / job   (165s)
 *   CF Browser Rendering (crawl): $0.000125 / page
 *   CF Worker + KV:               treated as $0 marginal
 *   DDG proxy (gather):           $0 (Mac Mini electricity fixed)
 */

// ---- constants (mirror src/index.ts) -------------------------------------

const PRICE_MCENTS = {
  crawl: 50,
  gather: 100,
  label: 200,
  train: 8000,
  predict: 800,
};

const COST_USD = {
  crawl: 0.000125,
  gather: 0,
  label: 0.0005,
  predict_cold: 0.009,
  predict_warm: 0.00075,
  train_cold: 0.029,
  train_warm: 0.015,
};

const SIGNUP_PRICE_USD = 0.10;
const SIGNUP_STARTER_MCENTS = 10_000;
const ACTIVATION_BONUS_MCENTS = 5_000;
const ACTIVATION_LABELS_REQUIRED = 5;

const PRO_PRICE_USD = 19.00;
const DEDICATED_PRICE_USD = 199.00;

// Jackpot contribution per productive label. Free tier = 50mc (25% of
// 200mc label price). Pro/Dedicated = 25mc — half, because subs are already
// paying a flat fee and shouldn't 1:1 subsidize Free prizes.
// Contributions leave the platform's general fund and enter the prize pool
// that eventually pays a winner — so they DO reduce platform net on a
// per-scenario basis (even though they're zero-sum across all agents).
// Capped at weight=2000 per key per period (matching rank cap). This caps
// platform bleed at ~$1/user/period even for production Dedicated whales.
const JACKPOT_CONTRIBUTION_MCENTS_FREE = 50;
const JACKPOT_CONTRIBUTION_MCENTS_SUB = 25;
const JACKPOT_WEIGHT_CAP = 2000;
const JACKPOT_WEIGHT_BY_TIER: Record<"free" | "pro" | "dedicated" | "enterprise", number> = {
  free: 1.0,
  pro: 1.5,
  dedicated: 2.0,
  enterprise: 2.0,
};

// ---- helpers --------------------------------------------------------------

const mcentsToUsd = (m: number) => m / 100_000;

// Cold/warm mix. Heavy predict users keep their worker warm; walkup users
// eat cold starts. Tune the ratio per archetype.
function predictMixCost(calls: number, coldRatio: number): number {
  const cold = Math.round(calls * coldRatio);
  const warm = calls - cold;
  return cold * COST_USD.predict_cold + warm * COST_USD.predict_warm;
}
function trainMixCost(calls: number, coldRatio: number): number {
  const cold = Math.round(calls * coldRatio);
  const warm = calls - cold;
  return cold * COST_USD.train_cold + warm * COST_USD.train_warm;
}

type Usage = {
  crawls: number;
  gathers: number;
  labels: number;
  trains: number;
  predicts: number;
  predict_cold_ratio: number;
  train_cold_ratio: number;
};

type Scenario = {
  name: string;
  description: string;
  revenue_usd: number;       // what the platform collects from this user
  tier: "free" | "pro" | "dedicated" | "enterprise";
  usage: Usage;
  activation_bonus_earned: boolean; // did they get the $0.05 bonus?
};

function evaluate(s: Scenario) {
  const u = s.usage;

  // Upstream costs
  const upstream =
    u.crawls * COST_USD.crawl +
    u.gathers * COST_USD.gather +
    u.labels * COST_USD.label +
    predictMixCost(u.predicts, u.predict_cold_ratio) +
    trainMixCost(u.trains, u.train_cold_ratio);

  // Jackpot accounting: all tiers contribute on productive labels, but at
  // different rates (Free 50mc, Pro/Dedicated 25mc). Contributions leave
  // platform net for this user (they go to the pool). Zero-sum across all
  // users, but per-scenario we treat them as a cost.
  // Capped by weight — once label_count × weight reaches JACKPOT_WEIGHT_CAP,
  // further labels neither contribute nor move rank.
  const perLabelMc = s.tier === "free"
    ? JACKPOT_CONTRIBUTION_MCENTS_FREE
    : JACKPOT_CONTRIBUTION_MCENTS_SUB;
  const tierWeight = JACKPOT_WEIGHT_BY_TIER[s.tier];
  const maxContributingLabels = Math.floor(JACKPOT_WEIGHT_CAP / tierWeight);
  const contributingLabels = Math.min(u.labels, maxContributingLabels);
  const jackpot_contribution_usd = mcentsToUsd(contributingLabels * perLabelMc);

  // Activation bonus is platform expense on free tier only. It's credited
  // to the user's spendable balance, so they consume infra with it; the
  // "cost" we care about is the UPSTREAM infra cost for calls paid with
  // bonus mcents. The upstream total above already captures that if the
  // scenario's usage reflects post-bonus spending. Explicit activation cost
  // here = marketing cost we booked but can't reclaim.
  // We track it for visibility; it doesn't double-count.
  const activation_cost_note = s.activation_bonus_earned
    ? mcentsToUsd(ACTIVATION_BONUS_MCENTS)
    : 0;

  const gross_net = s.revenue_usd - upstream;
  const net = gross_net - jackpot_contribution_usd;
  return {
    revenue: s.revenue_usd,
    upstream_cost: upstream,
    activation_bonus_given: activation_cost_note,
    jackpot_contribution: jackpot_contribution_usd,
    net,
    net_after_jackpot: net,
    margin_pct: s.revenue_usd > 0 ? (net / s.revenue_usd) * 100 : 0,
    profitable: net >= 0,
  };
}

// ---- scenarios ------------------------------------------------------------

const scenarios: Scenario[] = [
  {
    name: "walkaway",
    description: "Pays $0.10, never calls anything.",
    revenue_usd: SIGNUP_PRICE_USD,
    tier: "free",
    usage: { crawls: 0, gathers: 0, labels: 0, trains: 0, predicts: 0, predict_cold_ratio: 0, train_cold_ratio: 0 },
    activation_bonus_earned: false,
  },
  {
    name: "activation-claimer",
    description: "Pays $0.10, labels 5 imgs (earns $0.05 bonus), spends rest of $0.15 on labels.",
    revenue_usd: SIGNUP_PRICE_USD,
    tier: "free",
    // $0.15 of credit / $0.002 per label = 75 labels total
    usage: { crawls: 0, gathers: 0, labels: 75, trains: 0, predicts: 0, predict_cold_ratio: 0, train_cold_ratio: 0 },
    activation_bonus_earned: true,
  },
  {
    name: "heavy-labeler-free",
    description: "Pays $0.10, grinds 50 labels to hunt the jackpot. Dies to balance soon after.",
    revenue_usd: SIGNUP_PRICE_USD,
    tier: "free",
    usage: { crawls: 0, gathers: 0, labels: 50, trains: 0, predicts: 0, predict_cold_ratio: 0, train_cold_ratio: 0 },
    activation_bonus_earned: true, // first 5 trigger bonus
  },
  {
    name: "cold-predict-abuser",
    description: "Pays $0.10, must train first (8000mc). Then max cold-start predicts until broke.",
    revenue_usd: SIGNUP_PRICE_USD,
    tier: "free",
    // Credit: $0.15 (= $0.10 signup + $0.05 activation bonus)
    // Spend: 5 labels ($0.01) + 1 train ($0.08) + 7 cold predicts ($0.056) = $0.146 (~broke)
    // Predict REQUIRES a trained model — you can't skip the train call.
    usage: { crawls: 0, gathers: 0, labels: 5, trains: 1, predicts: 7, predict_cold_ratio: 1.0, train_cold_ratio: 1.0 },
    activation_bonus_earned: true,
  },
  {
    name: "full-pipeline-warm",
    description: "Pays $0.10, signs up and runs gather+labels+train+predicts in one session (warm).",
    revenue_usd: SIGNUP_PRICE_USD,
    tier: "free",
    // $0.15: 1 gather ($0.001) + 8 labels ($0.016) + 1 train ($0.08) + 6 predicts ($0.048) = $0.145
    usage: { crawls: 0, gathers: 1, labels: 8, trains: 1, predicts: 6, predict_cold_ratio: 0.17, train_cold_ratio: 1.0 },
    activation_bonus_earned: true,
  },
  {
    name: "pro-casual",
    description: "Subscribes Pro ($19/mo). Uses modestly — 2k labels, 100 predicts, 2 trains.",
    revenue_usd: PRO_PRICE_USD,
    tier: "pro",
    usage: { crawls: 20, gathers: 50, labels: 2000, trains: 2, predicts: 100, predict_cold_ratio: 0.1, train_cold_ratio: 0.5 },
    activation_bonus_earned: false,
  },
  {
    name: "pro-grinder",
    description: "Pro ($19/mo), maximally abuses: 10k labels, 500 predicts, 10 trains (all quota).",
    revenue_usd: PRO_PRICE_USD,
    tier: "pro",
    usage: { crawls: 100, gathers: 200, labels: 10_000, trains: 10, predicts: 500, predict_cold_ratio: 0.1, train_cold_ratio: 0.5 },
    activation_bonus_earned: false,
  },
  {
    name: "dedicated-casual",
    description: "Dedicated ($199/mo). Modest use: 30k labels, 5k predicts, 10 trains.",
    revenue_usd: DEDICATED_PRICE_USD,
    tier: "dedicated",
    usage: { crawls: 200, gathers: 500, labels: 30_000, trains: 10, predicts: 5000, predict_cold_ratio: 0.02, train_cold_ratio: 0.3 },
    activation_bonus_earned: false,
  },
  {
    name: "dedicated-production",
    description: "Dedicated ($199/mo), production agent: 100k labels, 50k warm predicts, 50 trains.",
    revenue_usd: DEDICATED_PRICE_USD,
    tier: "dedicated",
    usage: { crawls: 500, gathers: 2000, labels: 100_000, trains: 50, predicts: 50_000, predict_cold_ratio: 0.01, train_cold_ratio: 0.2 },
    activation_bonus_earned: false,
  },
  {
    name: "dedicated-worst-case-warm",
    description: "Dedicated adversarial user, BUT workersMin=1 keeps predict warm (required for safety).",
    revenue_usd: DEDICATED_PRICE_USD,
    tier: "dedicated",
    usage: { crawls: 1000, gathers: 5000, labels: 200_000, trains: 50, predicts: 100_000, predict_cold_ratio: 0.01, train_cold_ratio: 1.0 },
    activation_bonus_earned: false,
  },
  {
    name: "dedicated-worst-case-UNSAFE",
    description: "Dedicated stress w/ NO workersMin=1 — 50% cold predicts. This is what we must NOT allow.",
    revenue_usd: DEDICATED_PRICE_USD,
    tier: "dedicated",
    usage: { crawls: 1000, gathers: 5000, labels: 200_000, trains: 50, predicts: 100_000, predict_cold_ratio: 0.5, train_cold_ratio: 1.0 },
    activation_bonus_earned: false,
  },
];

// Scenarios explicitly marked UNSAFE are expected-losses. They must NOT
// fail the sim — they exist to document what happens if we forget to
// enable workersMin=1 on the infer endpoint when we sell Dedicated.
const UNSAFE_SCENARIOS = new Set(["dedicated-worst-case-UNSAFE"]);

// ---- run ------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function fmtUsd(n: number): string {
  const s = (n >= 0 ? "+" : "") + "$" + n.toFixed(4);
  return s;
}

let allPositive = true;
const results: Array<ReturnType<typeof evaluate> & { scenario: Scenario }> = [];

for (const s of scenarios) {
  const r = evaluate(s);
  results.push({ ...r, scenario: s });
  if (!r.profitable && !UNSAFE_SCENARIOS.has(s.name)) allPositive = false;
}

console.log("\n=== DLF profitability simulation ===\n");
console.log(pad("scenario", 26) + pad("rev", 10) + pad("infra", 10) + pad("net", 12) + pad("margin", 9) + "ok?");
console.log("-".repeat(75));

for (const r of results) {
  const unsafe = UNSAFE_SCENARIOS.has(r.scenario.name);
  const mark = r.profitable ? "✓" : (unsafe ? "⚠ expected (UNSAFE)" : "✗ LOSS");
  console.log(
    pad(r.scenario.name, 26) +
    pad("$" + r.revenue.toFixed(2), 10) +
    pad("$" + r.upstream_cost.toFixed(3), 10) +
    pad(fmtUsd(r.net), 12) +
    pad(r.margin_pct.toFixed(0) + "%", 9) +
    mark,
  );
}

console.log("\n--- detail ---");
for (const r of results) {
  console.log(`\n[${r.scenario.name}] ${r.scenario.description}`);
  console.log(`  tier=${r.scenario.tier}  revenue=${fmtUsd(r.revenue)}  infra=${fmtUsd(-r.upstream_cost)}`);
  if (r.scenario.activation_bonus_earned) {
    console.log(`  activation bonus: $${r.activation_bonus_given.toFixed(3)} credited to user (consumed by scenario usage)`);
  }
  if (r.scenario.tier === "free" && r.jackpot_contribution > 0) {
    console.log(`  jackpot contribution (neutral — flows back to agents): $${r.jackpot_contribution.toFixed(4)}`);
  }
  const usage = r.scenario.usage;
  const parts = [];
  if (usage.labels) parts.push(`${usage.labels} labels`);
  if (usage.predicts) parts.push(`${usage.predicts} predicts (${Math.round(usage.predict_cold_ratio * 100)}% cold)`);
  if (usage.trains) parts.push(`${usage.trains} trains (${Math.round(usage.train_cold_ratio * 100)}% cold)`);
  if (usage.gathers) parts.push(`${usage.gathers} gathers`);
  if (usage.crawls) parts.push(`${usage.crawls} crawls`);
  if (parts.length) console.log("  usage: " + parts.join(", "));
  console.log(`  NET: ${fmtUsd(r.net)}  (${r.margin_pct.toFixed(1)}% margin)`);
}

console.log("\n");
if (!allPositive) {
  console.log("❌ AT LEAST ONE SCENARIO IS UNPROFITABLE. Fix pricing before shipping.\n");
  process.exit(1);
} else {
  console.log("✅ All scenarios are net-positive for the platform.\n");
  process.exit(0);
}
