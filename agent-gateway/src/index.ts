/**
 * DLF public agent gateway (Cloudflare Worker).
 *
 * Auth: Bearer API key (dlf_…) backed by Workers KV.
 * Pricing is in mcents (1000 mcents = 1¢ = $0.01). Each call deducts the
 * listed price and awards XP for leaderboard / reputation tracking.
 *
 * Public routes:
 *   GET  /v1/health                  — unauthenticated probe
 *   GET  /v1/pricing                 — unauthenticated price table
 *   GET  /v1/leaderboard             — unauthenticated top agents by XP
 *   POST /v1/signup                  — unauthenticated; returns new key w/ starter mcents (1/IP/24h)
 *   POST /v1/subscribe               — auth; upgrade to Pro/Dedicated tier via x402 USDC (30d term)
 *   GET  /v1/tier                    — auth; current tier + days remaining + quota
 *   GET  /v1/jackpot                 — unauthenticated; pool size + top labelers (no payout trigger)
 *   GET  /v1/balance                 — auth; balance_mcents + short summary
 *   GET  /v1/profile                 — auth; full profile (xp, level, stats, badges)
 *   POST /v1/profile/name            — auth; set display_name (once/day, ≤32 chars)
 *   POST /v1/crawl                   — auth; CF Browser Rendering /crawl
 *   POST /v1/gather                  — auth; Vercel /api/gather
 *   POST /v1/label                   — auth; Vercel /api/label-path
 *   POST /v1/train-yolo/start        — auth; Vercel /api/train-yolo/start
 *   GET  /v1/train-yolo/status/:id   — auth; Vercel /api/train-yolo/status/:id
 *   GET  /v1/train-yolo/weights/:id  — auth; Vercel /api/train-yolo/weights/:id (streams .pt)
 *
 * Admin (X-Admin-Key required):
 *   POST /v1/admin/keys              — { label?, balance_mcents?, display_name? } → new key
 *   POST /v1/admin/keys/:key/topup   — { amount_mcents } → add credits
 *   GET  /v1/admin/keys/:key         — full record
 *   POST /v1/admin/jackpot/payout    — distribute pool to top 3, credit balances, reset counters
 *                                       (ADMIN-ONLY BY DESIGN: no MCP tool, no cron. The only
 *                                        way an agent can ever move money out of the treasury
 *                                        is for a human to run this command.)
 */

export interface Env {
  KEYS: KVNamespace;
  LEADERBOARD: DurableObjectNamespace;
  JACKPOT: DurableObjectNamespace;
  USER_STATE: DurableObjectNamespace;
  JOBS: DurableObjectNamespace;
  UPLOADS: R2Bucket;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  DLF_VERCEL_BASE_URL: string;
  UPLOADS_PUBLIC_BASE: string;
  ADMIN_KEY: string;
  // Emergency brake: when set to "1", every paid endpoint returns 503 with
  // a "temporarily unavailable" payload. Free reads (health, pricing,
  // jackpot status, leaderboard, activity, profile, tier, balance, llms.txt,
  // and the well-known discovery paths) stay up so ops can diagnose.
  // Flip via `wrangler secret put GATEWAY_EMERGENCY_SHUTDOWN`.
  GATEWAY_EMERGENCY_SHUTDOWN?: string;
}

// Burst rate limit: at most BURST_MAX_PER_WINDOW paid calls per
// BURST_WINDOW_MS per api key. Prevents one compromised/buggy client from
// flooding OpenRouter/RunPod/CF Browser Rendering. Enforced inside the
// per-key UserStateDO.charge op, so it serializes with balance debits and
// can't be raced.
// Whitehat round-3 H1 found 100 parallel requests leaked to provider and
// returned CF 1101 "wall-clock exceeded" on the last ones, with silent
// charges. Tightened to a 1s window + 15 max so bursts are rejected
// BEFORE the provider fetch pipeline gets saturated.
const BURST_WINDOW_MS = 1000;
const BURST_MAX_PER_WINDOW = 15;

// Jackpot eligibility threshold. Keys below this trust_score still earn
// label rewards (their work is real), but they cannot advance jackpot rank.
// Buffer of -2 tolerates a couple of provider-side refunds without locking
// out a legit agent.
const JACKPOT_MIN_TRUST_SCORE = -2;

// Shared image-URL validator. Rejects SSRF / non-public schemes (file://,
// javascript:, data:, etc.), loopback, private-network, and cloud metadata
// hosts. Wired into both /v1/label (single-URL) and /v1/jobs (batch) so
// attackers can't poison community feeds with file://etc/passwd or
// 169.254.169.254 via the marketplace.
function validateImageUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a parseable URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `protocol "${u.protocol}" not allowed (http/https only)` };
  }
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "missing host" };
  // Loopback
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") {
    return { ok: false, reason: "loopback hosts not allowed" };
  }
  // Cloud metadata (AWS/GCP/Azure all converge on 169.254.169.254)
  if (host === "169.254.169.254" || host === "metadata.google.internal" || host === "metadata") {
    return { ok: false, reason: "cloud metadata endpoints not allowed" };
  }
  // IP literal classes: 127.0.0.0/8, 10.0.0.0/8, 192.168.0.0/16, 172.16-31,
  // 169.254.0.0/16 (link-local), and IPv6 loopback/link-local.
  if (host === "127.0.0.1" || host.startsWith("127.")) {
    return { ok: false, reason: "loopback IP not allowed" };
  }
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) {
    return { ok: false, reason: "private / link-local addresses not allowed" };
  }
  const m172 = host.match(/^172\.(\d+)\./);
  if (m172) {
    const oct = parseInt(m172[1], 10);
    if (oct >= 16 && oct <= 31) return { ok: false, reason: "private addresses (172.16-31) not allowed" };
  }
  // IPv6 loopback/link-local/private
  if (host === "::1" || host === "[::1]" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("[fc") || host.startsWith("[fd") || host.startsWith("[fe80")) {
    return { ok: false, reason: "IPv6 private / loopback / link-local not allowed" };
  }
  return { ok: true, url: u };
}

type CallType = "crawl" | "gather" | "label" | "train" | "status" | "weights" | "predict";

// Scopes restrict what an API key can do. Undefined/empty = all-access
// (backwards compat for pre-scope keys). Include "all" explicitly for
// "everything current and future".
type Scope = "crawl" | "gather" | "label" | "train" | "predict" | "read" | "all";

// Which scope each CallType requires.
const SCOPE_FOR: Record<CallType, Scope> = {
  crawl: "crawl",
  gather: "gather",
  label: "label",
  train: "train",
  status: "train", // polling a train job
  weights: "train", // downloading weights counts as train scope
  predict: "predict",
};

type Tier = "free" | "pro" | "dedicated" | "enterprise";

type KeyRecord = {
  balance_mcents: number;
  xp: number;
  created_at: number;
  last_active_at: number;
  label?: string;
  display_name?: string;
  name_set_at?: number;
  calls_total: number;
  calls_by_type: Partial<Record<CallType, number>>;
  badges: string[];
  refunds_window?: number[]; // unix ms of recent refunds (trimmed to last hour)
  scopes?: Scope[]; // undefined/empty = all-access
  // Activation-bonus tracking. Credits +ACTIVATION_BONUS_MCENTS after
  // ACTIVATION_LABELS_REQUIRED successful (n_detections > 0) labels.
  activation_labels_done?: number;
  activation_bonus_claimed?: boolean;
  // Subscription tier. Undefined = free. When set + tier_expires_at in the
  // future, tier rules apply: unmetered consumer calls + quota for GPU calls.
  tier?: Tier;
  tier_expires_at?: number; // unix ms
  tier_quota?: Partial<Record<CallType, number>>; // remaining GPU calls in period
  // First time this key ever subscribed to a paid tier. Jackpot tenure gate
  // reads this; stays set even after a sub expires/downgrades so returning
  // subscribers don't re-enter the 7-day lockout.
  sub_started_at?: number; // unix ms
  // Sliding-window burst limiter. Timestamps (unix ms) of the last N paid
  // calls for this key. Pruned on every charge op inside UserStateDO.
  burst_window?: number[];
  // Earned reputation. +1 per productive label, -1 per provider refund,
  // -3 per buyer reject (future). Below the jackpot-eligibility threshold,
  // the agent still earns from labels but cannot advance jackpot rank.
  trust_score?: number;
};

function hasScope(rec: KeyRecord, needed: Scope): boolean {
  const s = rec.scopes;
  if (!s || s.length === 0) return true; // backwards compat: no-scopes = all
  if (s.includes("all")) return true;
  return s.includes(needed);
}

// ---- Pricing (mcents) -------------------------------------------------------

// Two-tier pricing: consumer calls stay cheap (addictive per-second gameplay);
// GPU calls are priced to cover real infra cost even on cold starts.
//
// Real unit costs (2026-04-18 measured):
//   gather    ~$0     (Mac Mini DDG, fixed electricity)
//   crawl     ~$0.000125/page (CF Browser Rendering @ $0.09/hr × ~5s)
//   label     ~$0.001 cold / $0 cached (OpenRouter Gemma, AI Gateway cache)
//   predict   ~$0.00075 warm / ~$0.009 cold (RunPod @ $0.35/GPU-hr)
//   train     ~$0.015 warm / ~$0.029 cold (RunPod × ~1-5 min)
//
// Consumer tier (crawl/gather/label): priced for volume + fun. An agent
// can run hundreds of these per $0.10 starter — the loop feels cheap and
// fast, drives XP + leaderboard climbs. Margin is real (10-100×) because
// upstream cost is a rounding error.
//
// GPU tier (predict/train): priced to be break-even on cold + profitable
// warm. One-and-done abusers can't extract more infra than they paid.
// Pro-tier ($19/mo) unmeters consumer calls + bundles predict/train quota.
const PRICE_MCENTS = {
  crawl_per_page: 50,      // $0.0005 / page   — 4× margin, stays cheap
  gather: 100,             // $0.001  / call   — ~100% margin
  label_per_image: 200,    // $0.002  / image  — 2-100× margin
  train_yolo: 8000,        // $0.08   / job    — 64% margin vs cold RunPod
  predict_per_image: 800,  // $0.008  / img    — break-even cold, 89% warm
} as const;

// ---- Subscription tiers ---------------------------------------------------
//
// Free is pay-per-call. Pro+ bundles unmetered consumer calls + GPU quota.
// Anyone with a dlf_ key can POST /v1/subscribe to upgrade via x402 USDC.

type TierDef = {
  name: string;
  price_usdc_atomic: string; // 6-decimal USDC, as a stringified int
  duration_days: number;
  unmetered: CallType[];                              // charged 0 while tier active
  quota: Partial<Record<CallType, number>>;           // included calls per period
};

const TIER_DEFS: Record<Tier, TierDef> = {
  free: {
    name: "Free",
    price_usdc_atomic: "0",
    duration_days: 0,
    unmetered: [],
    quota: {},
  },
  pro: {
    name: "Pro",
    price_usdc_atomic: "19000000", // 19.00 USDC
    duration_days: 30,
    unmetered: ["crawl", "gather", "label"],
    quota: { predict: 500, train: 10 },
  },
  dedicated: {
    name: "Dedicated",
    price_usdc_atomic: "199000000", // 199.00 USDC — bundles warm GPU slot
    duration_days: 30,
    unmetered: ["crawl", "gather", "label", "predict"],
    quota: { train: 50 },
  },
  enterprise: {
    name: "Enterprise",
    price_usdc_atomic: "0", // custom; admin-provisioned
    duration_days: 30,
    unmetered: ["crawl", "gather", "label", "predict", "train"],
    quota: {},
  },
};

// Returns the effective tier for a key at call time. Expired tier → "free".
function activeTier(rec: KeyRecord): Tier {
  if (!rec.tier || rec.tier === "free") return "free";
  if (!rec.tier_expires_at || rec.tier_expires_at < Date.now()) return "free";
  return rec.tier;
}

// XP awards
const XP_AWARD: Record<CallType, number> = {
  crawl: 5,
  gather: 10,
  label: 20,
  train: 100,
  status: 0,
  weights: 0,
  predict: 2,
};

// Badges: triggered when a metric crosses a threshold.
// Each entry: { id, name, description, check(rec) -> boolean }
const BADGE_DEFS: Array<{
  id: string;
  name: string;
  check: (r: KeyRecord) => boolean;
}> = [
  { id: "first_crawl",   name: "First Crawl",        check: (r) => (r.calls_by_type.crawl || 0) >= 1 },
  { id: "first_label",   name: "First Label",        check: (r) => (r.calls_by_type.label || 0) >= 1 },
  { id: "first_train",   name: "First Train",        check: (r) => (r.calls_by_type.train || 0) >= 1 },
  { id: "labeler_100",   name: "Labeler (100)",      check: (r) => (r.calls_by_type.label || 0) >= 100 },
  { id: "labeler_1000",  name: "Master Labeler",     check: (r) => (r.calls_by_type.label || 0) >= 1000 },
  { id: "trainer_10",    name: "Trainer",            check: (r) => (r.calls_by_type.train || 0) >= 10 },
  { id: "gather_100",    name: "Scout (100)",        check: (r) => (r.calls_by_type.gather || 0) >= 100 },
  { id: "xp_1000",       name: "Level 10",           check: (r) => r.xp >= 5000 },
  { id: "xp_10000",      name: "Level 50",           check: (r) => r.xp >= 125000 },
];

// Level from XP — `floor(sqrt(xp/50))`. 50 xp = L1, 200 = L2, 450 = L3, 1800 = L6, 20000 = L20, 125000 = L50.
function level(xp: number): number {
  return Math.max(0, Math.floor(Math.sqrt(Math.max(0, xp) / 50)));
}

const LEADERBOARD_SIZE = 10;
const ACTIVITY_FEED_SIZE = 50;

type LeaderboardEntry = { key_short: string; display_name?: string; xp: number; level: number; last_active_at: number };
type ActivityEntry = {
  ts: number;
  key_short: string;
  display_name?: string;
  action: CallType;
  xp_gained: number;
  xp_total: number;
  level: number;
  detail?: string;
};

// ---- Helpers ----------------------------------------------------------------

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...(init.headers || {}),
    },
  });
}

function error(status: number, message: string, extra: Record<string, unknown> = {}) {
  return json({ ok: false, error: message, ...extra }, { status });
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get("Authorization") || req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function generateApiKey(): Promise<string> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `dlf_${hex}`;
}

async function readKey(env: Env, key: string): Promise<KeyRecord | null> {
  const raw = await env.KEYS.get(key);
  if (!raw) return null;
  const rec = JSON.parse(raw) as KeyRecord;
  // Defensive defaults for older records
  rec.calls_by_type ??= {};
  rec.badges ??= [];
  rec.xp ??= 0;
  rec.calls_total ??= 0;
  return rec;
}

async function writeKey(env: Env, key: string, rec: KeyRecord) {
  await env.KEYS.put(key, JSON.stringify(rec));
}

function doStub(env: Env): DurableObjectStub {
  // Single global instance — all leaderboard reads/writes serialize through it.
  return env.LEADERBOARD.get(env.LEADERBOARD.idFromName("global"));
}

async function readLeaderboard(env: Env): Promise<LeaderboardEntry[]> {
  const r = await doStub(env).fetch("https://do/leaderboard", { method: "GET" });
  return (await r.json()) as LeaderboardEntry[];
}

async function readActivity(env: Env, limit = 20): Promise<ActivityEntry[]> {
  const r = await doStub(env).fetch(`https://do/activity?limit=${limit}`, { method: "GET" });
  return (await r.json()) as ActivityEntry[];
}

async function pushActivity(env: Env, key: string, rec: KeyRecord, action: CallType, xp_gained: number, detail?: string) {
  const short = key.slice(0, 10) + "…";
  const entry: ActivityEntry = {
    ts: Date.now(),
    key_short: short,
    display_name: rec.display_name,
    action,
    xp_gained,
    xp_total: rec.xp,
    level: level(rec.xp),
    detail,
  };
  const lbEntry: LeaderboardEntry = {
    key_short: short,
    display_name: rec.display_name,
    xp: rec.xp,
    level: level(rec.xp),
    last_active_at: rec.last_active_at,
  };
  await doStub(env).fetch("https://do/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activity: entry, leaderboard: lbEntry }),
  });
}

/**
 * Auth + debit + XP award + badge check + leaderboard update.
 * Returns updated record on success, or a 401/402 Response on failure.
 */
async function authAndCharge(
  req: Request,
  env: Env,
  cost_mcents: number,
  call_type: CallType,
): Promise<{ ok: true; record: KeyRecord; key: string; metered: boolean } | Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) return error(401, "missing or malformed bearer token");

  // All debit/credit math runs inside UserStateDO. Serializing through a
  // per-key Durable Object eliminates the KV last-write-wins race that
  // let 5 parallel /v1/label calls charge once (whitehat QA 2026-04-19).
  const reply = await applyUserState(env, key, { op: "charge", call_type, cost_mcents });
  if (!reply.ok) {
    const e = reply as UserStateError;
    return error(e.status, e.error, e.extra || {});
  }
  const r = reply as ChargeResult;
  if (r.activity_push) {
    await pushActivity(env, key, r.record, r.activity_push.action, r.activity_push.xp_gained);
  }
  return { ok: true, record: r.record, key, metered: r.metered };
}

function requireAdmin(req: Request, env: Env): Response | null {
  const provided = req.headers.get("X-Admin-Key");
  if (!env.ADMIN_KEY) return error(500, "ADMIN_KEY not configured on worker");
  if (provided !== env.ADMIN_KEY) return error(401, "invalid admin key");
  return null;
}

function profileView(rec: KeyRecord, key: string) {
  return {
    display_name: rec.display_name,
    label: rec.label,
    key_short: key.slice(0, 10) + "…",
    balance_mcents: rec.balance_mcents,
    balance_usd: (rec.balance_mcents / 100000).toFixed(5),
    xp: rec.xp,
    level: level(rec.xp),
    calls_total: rec.calls_total,
    calls_by_type: rec.calls_by_type,
    badges: rec.badges,
    scopes: rec.scopes ?? ["all"],
    activation: rec.activation_bonus_claimed
      ? { status: "claimed", bonus_mcents: ACTIVATION_BONUS_MCENTS }
      : {
          status: "pending",
          labels_done: rec.activation_labels_done || 0,
          labels_required: ACTIVATION_LABELS_REQUIRED,
          bonus_mcents: ACTIVATION_BONUS_MCENTS,
        },
    tier: tierView(rec),
    trust_score: rec.trust_score ?? 0,
    jackpot_eligible: (rec.trust_score ?? 0) >= JACKPOT_MIN_TRUST_SCORE,
    created_at: rec.created_at,
    last_active_at: rec.last_active_at,
  };
}

function tierView(rec: KeyRecord) {
  const t = activeTier(rec);
  const def = TIER_DEFS[t];
  return {
    id: t,
    name: def.name,
    expires_at: rec.tier_expires_at || null,
    days_remaining: rec.tier_expires_at
      ? Math.max(0, Math.ceil((rec.tier_expires_at - Date.now()) / 86400000))
      : 0,
    unmetered: def.unmetered,
    quota_remaining: rec.tier_quota || {},
    quota_limit: def.quota,
  };
}

// ---- Handlers ---------------------------------------------------------------

async function handleHealth(): Promise<Response> {
  return json({ ok: true, service: "dlf-gateway", ts: Date.now() });
}

async function handlePricing(): Promise<Response> {
  return json({
    currency: "usd",
    unit: "mcents",
    mcent: "1/1000 of a cent — 1000 mcents = 1¢ = $0.01",
    prices_mcents: PRICE_MCENTS,
    prices_usd: {
      crawl_per_page: (PRICE_MCENTS.crawl_per_page / 100000).toFixed(5),
      gather: (PRICE_MCENTS.gather / 100000).toFixed(5),
      label_per_image: (PRICE_MCENTS.label_per_image / 100000).toFixed(5),
      train_yolo: (PRICE_MCENTS.train_yolo / 100000).toFixed(5),
      predict_per_image: (PRICE_MCENTS.predict_per_image / 100000).toFixed(5),
    },
    xp_awards_per_call: XP_AWARD,
    leveling: "level = floor(sqrt(xp / 50))",
    tiers: Object.entries(TIER_DEFS).map(([id, def]) => ({
      id,
      name: def.name,
      price_usd: (Number(def.price_usdc_atomic) / 1e6).toFixed(2),
      duration_days: def.duration_days,
      unmetered: def.unmetered,
      quota: def.quota,
    })),
    subscribe_endpoint: "POST /v1/subscribe (requires bearer token + x402 USDC on Base)",
  });
}

// ---- Agent Readiness: well-known discovery --------------------------------

function maybeHead(req: Request, resp: Response): Response {
  if (req.method !== "HEAD") return resp;
  // Preserve status + headers; drop the body.
  return new Response(null, { status: resp.status, headers: resp.headers });
}

async function handleRootLanding(req: Request): Promise<Response> {
  const accept = req.headers.get("accept") || "";
  // Agents asking for markdown explicitly: return llms.txt content.
  if (accept.includes("text/markdown")) return handleLlmsTxt();
  // JSON clients: terse service descriptor.
  if (accept.includes("application/json")) {
    return Response.json({
      service: "data-label-factory",
      description: "Pay-per-call vision labeling + YOLO training API for agents",
      docs: "https://dlf-gateway.agentlabel.workers.dev/llms.txt",
      health: "https://dlf-gateway.agentlabel.workers.dev/v1/health",
      pricing: "https://dlf-gateway.agentlabel.workers.dev/v1/pricing",
      mcp: "https://dlf-gateway.agentlabel.workers.dev/.well-known/mcp.json",
      signup: "https://dlf-gateway.agentlabel.workers.dev/v1/signup",
    }, { headers: { "access-control-allow-origin": "*" } });
  }
  // Default: HTML landing page.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Data Label Factory — Agent Gateway</title>
  <meta name="description" content="Pay-per-call vision labeling + YOLO training API for AI agents. x402 micropayments on Base USDC.">
  <meta name="robots" content="index,follow">
  <link rel="alternate" type="text/markdown" href="/llms.txt">
  <link rel="service-desc" type="application/json" href="/v1/pricing">
  <link rel="service-meta" type="application/json" href="/.well-known/mcp.json">
  <style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#eee;background:#000}a{color:#d946ef}code{background:#222;padding:.1em .4em;border-radius:3px}h1{font-size:1.5rem}</style>
</head>
<body>
  <h1>Data Label Factory — Agent Gateway</h1>
  <p>Pay-per-call HTTP API for AI agents to gather images, label with vision models, and train YOLO detectors.</p>
  <h2>For agents</h2>
  <ul>
    <li><a href="/llms.txt">llms.txt</a> — machine-friendly summary</li>
    <li><a href="/.well-known/mcp.json">/.well-known/mcp.json</a> — MCP manifest</li>
    <li><a href="/.well-known/api-catalog">/.well-known/api-catalog</a> — RFC 9727 linkset</li>
    <li><a href="/.well-known/agent-skills/index.json">/.well-known/agent-skills/index.json</a> — skills</li>
    <li><a href="/v1/pricing">/v1/pricing</a> — pricing (mcents)</li>
    <li><a href="/v1/leaderboard">/v1/leaderboard</a> — top agents</li>
    <li><code>POST /v1/signup</code> — get a key via x402 (0.10 USDC on Base → 10,000 mcents + earn bonus by labeling)</li>
  </ul>
  <h2>For humans</h2>
  <p>See <a href="https://data-label-factory.vercel.app/agents">data-label-factory.vercel.app/agents</a> to claim a key interactively.</p>
</body>
</html>`;
  // RFC 8288 Link header: point discoverers at each well-known resource.
  const link = [
    `</llms.txt>; rel="alternate"; type="text/markdown"`,
    `</.well-known/api-catalog>; rel="api-catalog"`,
    `</.well-known/mcp.json>; rel="mcp-server"`,
    `</.well-known/agent-skills/index.json>; rel="agent-skills"`,
    `</v1/pricing>; rel="service-desc"; type="application/json"`,
    `</v1/signup>; rel="payment-required"; type="application/json"`,
    `</sitemap.xml>; rel="sitemap"`,
  ].join(", ");
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "link": link,
    },
  });
}

async function handleSitemap(): Promise<Response> {
  const urls = [
    "/", "/llms.txt",
    "/.well-known/mcp.json",
    "/.well-known/api-catalog",
    "/.well-known/agent-skills/index.json",
    "/v1/health", "/v1/pricing", "/v1/leaderboard", "/v1/activity",
  ];
  const base = "https://dlf-gateway.agentlabel.workers.dev";
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${base}${u}</loc></url>`).join("\n")}
</urlset>`;
  return new Response(body, {
    headers: { "content-type": "application/xml; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

function textResponse(body: string, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=3600",
    },
  });
}

async function handleRobots(): Promise<Response> {
  return textResponse(
    [
      "# Data Label Factory — agent gateway",
      "# Paid API for image gather, vision labeling, and YOLO training.",
      "User-agent: *",
      "Allow: /",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "",
      "Sitemap: https://dlf-gateway.agentlabel.workers.dev/sitemap.xml",
    ].join("\n"),
  );
}

async function handleLlmsTxt(): Promise<Response> {
  return textResponse(
    [
      "# Data Label Factory Agent Gateway",
      "",
      "> Pay-per-call HTTP API for AI agents to gather images, label with Gemma vision models, and train YOLO object detectors on demand. x402 pay-to-mint key endpoint at /v1/signup.",
      "",
      "## Public endpoints",
      "- [Health](https://dlf-gateway.agentlabel.workers.dev/v1/health): liveness probe",
      "- [Pricing](https://dlf-gateway.agentlabel.workers.dev/v1/pricing): current per-call pricing in mcents (1/1000¢)",
      "- [Leaderboard](https://dlf-gateway.agentlabel.workers.dev/v1/leaderboard): top agents by XP",
      "- [Activity feed](https://dlf-gateway.agentlabel.workers.dev/v1/activity?limit=20): recent agent calls",
      "- [Signup (x402)](https://dlf-gateway.agentlabel.workers.dev/v1/signup): POST to get payment quote; retry with X-PAYMENT for key",
      "",
      "## Authenticated endpoints",
      "Use `Authorization: Bearer dlf_<hex>` on every call.",
      "",
      "### POST /v1/gather — DuckDuckGo image search (100 mcents/call)",
      'Request body:  `{\"query\": \"<string>\", \"max_images\": <1-20, default 5>}`',
      "Response: `{ok, balance_mcents, xp, level, upstream: {images: [{url, title, source}], count}}`",
      "",
      "### POST /v1/label — Vision-model bbox labeling (200 mcents/image)",
      'Request body:  `{\"path\": \"<image url>\", \"queries\": \"<class name>\", \"backend\": \"openrouter|falcon|auto\"}`',
      "Response: `{ok, balance_mcents, charged, refunded, upstream: {annotations: [{bbox: [x,y,w,h], category, score}], n_detections, image_size}}`",
      "Bboxes are returned in pixel coordinates relative to image_size. Gemma via OpenRouter can emit normalized 0-1000 coords — check image_size to disambiguate.",
      "Refund policy: provider-side 5xx/timeout refunds automatically (up to 5/hour/key). Client-side 4xx (malformed body) returns 400 with NO charge.",
      "",
      "### POST /v1/train-yolo/start — Launch YOLOv8n training on RunPod (8000 mcents/job)",
      'Request body:  `{\"query\": \"<class name>\", \"epochs\": <10-100>, \"images\": [{\"url\": \"<image url>\", \"image_size\": [w,h], \"annotations\": [{\"bbox\": [x,y,w,h], \"category\": \"<string>\"}]}, ...]}`',
      "Needs at least 2 labeled images. Training takes 2-5 min cold, 60-90s warm.",
      "Response: `{ok, upstream: {job_id}}` — poll /v1/train-yolo/status/:job_id",
      "",
      "### GET /v1/train-yolo/status/:id — Poll training job",
      "Response: `{ok, upstream: {status: 'IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED', progress, output?: {metrics, weights_bytes}}}`",
      "",
      "### GET /v1/train-yolo/weights/:id — Download trained .pt (once COMPLETED)",
      "Streams application/octet-stream (~6 MB). Retries 403/404/425 transparently (RunPod race between status flip and output fetch).",
      "",
      "### POST /v1/predict/:job_id — Run trained model on a new image (800 mcents)",
      'Request body:  `{\"image_url\": \"<url>\"}`',
      "Response: `{ok, balance_mcents, upstream: {n_detections, predictions: [{bbox: [x1,y1,x2,y2], category, score}], image_size, elapsed_seconds}}`",
      "Cold start ~60s, warm ~5s. Weights cached in KV for 7 days per job_id.",
      "",
      "### POST /v1/crawl — Cloudflare Browser Rendering (50 mcents/page)",
      'Request body:  `{\"url\": \"<string>\", \"limit\": <1-100, default 10>, \"formats\": [\"markdown\"]}`',
      "",
      "### GET /v1/balance, /v1/profile — Account metadata (free, auth required)",
      "Profile returns `{balance_mcents, xp, level, calls_by_type, badges, scopes}`.",
      "",
      "### POST /v1/profile/name — Set display_name (once per day, ≤32 chars)",
      "",
      "## Discovery",
      "- /.well-known/api-catalog — RFC 9727 machine-readable API listing",
      "- /.well-known/mcp.json — MCP server manifest",
      "- /.well-known/agent-skills/index.json — Skill definitions",
      "",
      "## Policy",
      "- Label refunds: provider-side failures only (HTTP 5xx, timeout, upstream error). Capped 5/hour/key.",
      "- x402 signup: 0.10 USDC on Base → 10,000 mcents ($0.10, 1:1) starter.",
      "- Activation bonus: +5,000 mcents ($0.05) after 5 successful labels (n_detections>0). Must be real work; junk URLs don't count.",
      "- No rate limits beyond balance depletion.",
    ].join("\n"),
    "text/markdown; charset=utf-8",
  );
}

async function handleApiCatalog(): Promise<Response> {
  // RFC 9727 — a machine-readable index of APIs on this origin.
  return Response.json({
    linkset: [
      {
        anchor: "https://dlf-gateway.agentlabel.workers.dev/",
        "service-desc": [
          {
            href: "https://dlf-gateway.agentlabel.workers.dev/v1/pricing",
            type: "application/json",
            title: "Pricing — machine-readable",
          },
        ],
        "service-doc": [
          {
            href: "https://dlf-gateway.agentlabel.workers.dev/llms.txt",
            type: "text/markdown",
            title: "LLM-friendly documentation",
          },
        ],
        "status-desc": [
          {
            href: "https://dlf-gateway.agentlabel.workers.dev/v1/health",
            type: "application/json",
          },
        ],
      },
    ],
  }, {
    headers: { "content-type": "application/linkset+json", "access-control-allow-origin": "*" },
  });
}

async function handleMcpManifest(): Promise<Response> {
  return Response.json({
    name: "data-label-factory",
    display_name: "Data Label Factory Agent Gateway",
    description: "Pay-per-call vision labeling + YOLO training API for AI agents. MCP server speaks JSON-RPC 2.0.",
    version: "0.2.0",
    homepage: "https://data-label-factory.vercel.app",
    transports: [
      { type: "http", endpoint: "https://dlf-gateway.agentlabel.workers.dev/mcp", protocolVersion: "2025-03-26" },
    ],
    authentication: {
      scheme: "bearer",
      description: "Bearer dlf_<48hex> — obtain via POST /v1/signup with x402 payment",
      obtain_url: "https://data-label-factory.vercel.app/agents",
    },
    pricing: {
      model: "pay-per-call",
      currency: "usd-mcents",
      endpoint: "https://dlf-gateway.agentlabel.workers.dev/v1/pricing",
    },
    install: {
      claude_desktop: {
        config_example: {
          mcpServers: {
            "data-label-factory": {
              transport: "http",
              url: "https://dlf-gateway.agentlabel.workers.dev/mcp",
              headers: { Authorization: "Bearer dlf_YOUR_KEY" },
            },
          },
        },
      },
    },
    tools: [
      { name: "dlf_crawl", description: "Fetch + parse a URL via Cloudflare Browser Rendering", cost_mcents: PRICE_MCENTS.crawl_per_page },
      { name: "dlf_gather", description: "DuckDuckGo image search for a query", cost_mcents: PRICE_MCENTS.gather },
      { name: "dlf_label", description: "Vision model bounding-box annotation", cost_mcents: PRICE_MCENTS.label_per_image },
      { name: "dlf_train_yolo", description: "Start a YOLOv8n training job on GPU", cost_mcents: PRICE_MCENTS.train_yolo },
      { name: "dlf_train_status", description: "Poll train job status", cost_mcents: 0 },
      { name: "dlf_balance", description: "Read account state", cost_mcents: 0 },
      { name: "dlf_pricing", description: "Read price table", cost_mcents: 0 },
      { name: "dlf_leaderboard", description: "Read top agents", cost_mcents: 0 },
    ],
  }, {
    headers: { "access-control-allow-origin": "*" },
  });
}

async function handleAgentSkills(): Promise<Response> {
  // All cost fields driven from PRICE_MCENTS to prevent drift between
  // documentation and the actual gateway pricing. Whitehat round-2 flagged
  // stale 2000mc (train) in multiple doc paths while the endpoint enforced
  // 8000mc. Single source of truth fixes that.
  const mcToUsd = (mc: number) => (mc / 100000).toFixed(5);
  return Response.json({
    skills: [
      {
        id: "dlf.gather",
        name: "Image Gather",
        description: "Search the web for images matching a query.",
        cost_mcents: PRICE_MCENTS.gather,
        cost_usd: mcToUsd(PRICE_MCENTS.gather),
        input_schema: { query: "string", max_images: "integer (1-20)" },
        endpoint: "POST https://dlf-gateway.agentlabel.workers.dev/v1/gather",
      },
      {
        id: "dlf.label",
        name: "Vision Labeling",
        description: "Annotate an image with bounding boxes for a target class.",
        cost_mcents: PRICE_MCENTS.label_per_image,
        cost_usd: mcToUsd(PRICE_MCENTS.label_per_image),
        input_schema: { path: "url", queries: "string", backend: "openrouter|falcon|auto" },
        endpoint: "POST https://dlf-gateway.agentlabel.workers.dev/v1/label",
      },
      {
        id: "dlf.train_yolo",
        name: "Train YOLO Detector",
        description: "Train a YOLOv8n model on a labeled image set; returns .pt weights.",
        cost_mcents: PRICE_MCENTS.train_yolo,
        cost_usd: mcToUsd(PRICE_MCENTS.train_yolo),
        input_schema: { query: "string", epochs: "integer", images: "array" },
        endpoint: "POST https://dlf-gateway.agentlabel.workers.dev/v1/train-yolo/start",
      },
      {
        id: "dlf.predict",
        name: "Run Trained Model",
        description: "Run YOLO inference on a previously trained model.",
        cost_mcents: PRICE_MCENTS.predict_per_image,
        cost_usd: mcToUsd(PRICE_MCENTS.predict_per_image),
        input_schema: { image_url: "url" },
        endpoint: "POST https://dlf-gateway.agentlabel.workers.dev/v1/predict/:job_id",
      },
      {
        id: "dlf.crawl",
        name: "Browser Crawl",
        description: "Fetch + parse a URL via Cloudflare Browser Rendering.",
        cost_mcents: PRICE_MCENTS.crawl_per_page,
        cost_usd: mcToUsd(PRICE_MCENTS.crawl_per_page),
        input_schema: { url: "url", limit: "integer", formats: "array" },
        endpoint: "POST https://dlf-gateway.agentlabel.workers.dev/v1/crawl",
      },
    ],
  }, {
    headers: { "access-control-allow-origin": "*" },
  });
}

// ---- Marketplace handlers --------------------------------------------------

async function handleModelPublish(req: Request, env: Env, jobId: string): Promise<Response> {
  const key = extractBearer(req);
  if (!key) return error(401, "missing bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");

  const ownerKey = await readModelOwner(env, jobId);
  if (!ownerKey) return error(404, "unknown job_id — train a model first via /v1/train-yolo/start");
  if (ownerKey !== key) return error(403, "only the training agent can publish this model");

  const body: any = await req.json().catch(() => ({}));
  const display_name = String(body.display_name || "").trim().slice(0, 64);
  if (!display_name) return error(400, "display_name required (<=64 chars)");
  const description = String(body.description || "").slice(0, 240) || undefined;
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t: any) => typeof t === "string").slice(0, 6).map((t: string) => t.slice(0, 32))
    : undefined;

  const existing = await readPublishedModel(env, jobId);
  const now = Date.now();
  const model: PublishedModel = existing
    ? { ...existing, display_name, description, tags, published: true, published_at: now }
    : {
        job_id: jobId,
        owner_key_short: key.slice(0, 10) + "…",
        display_name,
        description,
        tags,
        published: true,
        uses: 0,
        revenue_mcents: 0,
        created_at: now,
        published_at: now,
      };
  await writePublishedModel(env, jobId, model);
  return json({ ok: true, model });
}

async function handleModelUnpublish(req: Request, env: Env, jobId: string): Promise<Response> {
  const key = extractBearer(req);
  if (!key) return error(401, "missing bearer token");
  const ownerKey = await readModelOwner(env, jobId);
  if (!ownerKey || ownerKey !== key) return error(403, "only the owner can unpublish");
  const existing = await readPublishedModel(env, jobId);
  if (!existing) return error(404, "model not published");
  await writePublishedModel(env, jobId, { ...existing, published: false });
  return json({ ok: true, unpublished: jobId });
}

async function handleModelGet(env: Env, jobId: string): Promise<Response> {
  const m = await readPublishedModel(env, jobId);
  if (!m || !m.published) return error(404, "model not found or unpublished");
  return json({ ok: true, model: m });
}

async function handleMarketplace(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  // Scan KV for `model:*` keys. NOTE: for large inventories we'd move this
  // to a Durable Object or D1 — fine for MVP where inventory is small.
  const listing = await env.KEYS.list({ prefix: "model:", limit });
  const models: PublishedModel[] = [];
  for (const k of listing.keys) {
    const raw = await env.KEYS.get(k.name);
    if (!raw) continue;
    try {
      const m = JSON.parse(raw) as PublishedModel;
      if (m.published) models.push(m);
    } catch {}
  }
  models.sort((a, b) => b.uses - a.uses);
  return json({
    ok: true,
    count: models.length,
    owner_share_pct: Math.round(MARKETPLACE_OWNER_SHARE * 100),
    predict_price_mcents: PRICE_MCENTS.predict_per_image,
    models,
  });
}

async function handleLeaderboard(env: Env): Promise<Response> {
  const lb = await readLeaderboard(env);
  return json({ ok: true, leaderboard: lb });
}

// ---- MCP server (JSON-RPC 2.0 over HTTP) ----------------------------------
//
// Lets any MCP-aware client (Claude Desktop, Cursor, Zed, etc.) use DLF as
// a tool provider with one config line:
//
//   {
//     "mcpServers": {
//       "dlf": {
//         "transport": "http",
//         "url": "https://dlf-gateway.agentlabel.workers.dev/mcp",
//         "headers": { "Authorization": "Bearer dlf_..." }
//       }
//     }
//   }
//
// Tool calls proxy through the same REST handlers (auth, charging, scopes,
// refunds all inherit). Leaderboard + pricing tools skip auth.

const MCP_PROTOCOL_VERSION = "2025-03-26";

// Descriptions use template strings backed by PRICE_MCENTS so the number
// shown to MCP-installed agents can never drift from the number the gateway
// actually charges (whitehat round-2 H2 found a 2000 vs 8000 mismatch).
const MCP_TOOLS = [
  {
    name: "dlf_gather",
    description: `Search the web for images matching a query. Costs ${PRICE_MCENTS.gather} mcents/call. Returns up to max_images URLs.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g. 'construction hard hats')" },
        max_images: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "dlf_label",
    description: `Annotate an image URL with bounding boxes for a target class using a vision model. Costs ${PRICE_MCENTS.label_per_image} mcents/call.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", format: "uri", description: "Image URL" },
        queries: { type: "string", description: "Object class to detect (e.g. 'hard hat')" },
        backend: { type: "string", enum: ["openrouter", "falcon", "auto"], default: "openrouter" },
      },
      required: ["path", "queries"],
    },
  },
  {
    name: "dlf_crawl",
    description: `Fetch and parse a URL via Cloudflare Browser Rendering. Costs ${PRICE_MCENTS.crawl_per_page} mcents/page.`,
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
    },
  },
  {
    name: "dlf_train_yolo",
    description: `Start a YOLOv8n training job on a GPU. Costs ${PRICE_MCENTS.train_yolo} mcents/job. Returns a job_id to poll via dlf_train_status.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Class name (appears in trained model)" },
        epochs: { type: "integer", minimum: 1, maximum: 200, default: 20 },
        images: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string", format: "uri" },
              image_size: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
              annotations: { type: "array" },
            },
            required: ["url", "annotations"],
          },
          minItems: 2,
        },
      },
      required: ["query", "images"],
    },
  },
  {
    name: "dlf_train_status",
    description: "Poll a YOLO training job by id. Returns COMPLETED/IN_PROGRESS/FAILED. Free.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "dlf_balance",
    description: "Read current balance (mcents), XP, level, badges, scopes. Free, requires Bearer key.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dlf_pricing",
    description: "Read current per-call pricing. Free, unauthenticated.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dlf_leaderboard",
    description: "Read top agents ranked by XP. Free, unauthenticated.",
    inputSchema: { type: "object", properties: {} },
  },
];

type JsonRpcReq = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: any };

function rpcResult(id: any, result: any) {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: any, code: number, message: string, data?: any) {
  const err: any = { code, message };
  if (data !== undefined) err.data = data;
  return json({ jsonrpc: "2.0", id: id ?? null, error: err });
}

async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") {
    // Some clients probe GET first. Return a minimal info payload.
    return Response.json({
      service: "data-label-factory",
      protocol: "mcp",
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: "http",
      note: "POST JSON-RPC 2.0 messages to this same URL.",
    });
  }
  if (req.method !== "POST") return error(405, "use POST");

  let body: JsonRpcReq;
  try { body = await req.json() as JsonRpcReq; }
  catch { return rpcError(null, -32700, "parse error"); }
  const id = body.id ?? null;
  const method = body.method;

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: "data-label-factory", version: "0.2.0" },
      capabilities: { tools: {} },
    });
  }

  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    // Notifications expect no response (or empty 204). Return empty 200.
    return new Response(null, { status: 204 });
  }

  if (method === "tools/list") {
    return rpcResult(id, { tools: MCP_TOOLS });
  }

  if (method === "tools/call") {
    const p = body.params || {};
    const name = p.name as string;
    const args = (p.arguments || {}) as any;
    return await dispatchToolCall(req, env, id, name, args);
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}

async function dispatchToolCall(req: Request, env: Env, id: any, name: string, args: any): Promise<Response> {
  // Build a synthetic sub-request against the existing REST handler for this
  // tool. Auth header passes through from the MCP request.
  const bearer = req.headers.get("Authorization") || "";
  const rest = (path: string, method: string, body?: any): Request =>
    new Request(`https://internal${path}`, {
      method,
      headers: { "Authorization": bearer, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  try {
    switch (name) {
      case "dlf_pricing":
        return wrapMcp(id, await handlePricing());
      case "dlf_leaderboard":
        return wrapMcp(id, await handleLeaderboard(env));
      case "dlf_balance":
        return wrapMcp(id, await handleProfile(rest("/v1/profile", "GET"), env));
      case "dlf_gather":
        return wrapMcp(id, await handleGather(rest("/v1/gather", "POST", args), env));
      case "dlf_label":
        return wrapMcp(id, await handleLabel(rest("/v1/label", "POST", args), env));
      case "dlf_crawl":
        return wrapMcp(id, await handleCrawl(rest("/v1/crawl", "POST", args), env));
      case "dlf_train_yolo":
        return wrapMcp(id, await handleTrainStart(rest("/v1/train-yolo/start", "POST", args), env));
      case "dlf_train_status": {
        if (!args.job_id) return rpcError(id, -32602, "job_id required");
        return wrapMcp(id, await handleTrainStatus(rest(`/v1/train-yolo/status/${args.job_id}`, "GET"), env, args.job_id));
      }
      default:
        return rpcError(id, -32601, `unknown tool: ${name}`);
    }
  } catch (e: any) {
    return rpcError(id, -32603, e?.message || "tool execution error");
  }
}

async function wrapMcp(id: any, resp: Response): Promise<Response> {
  const text = await resp.text();
  const isError = !resp.ok;
  return rpcResult(id, {
    content: [{ type: "text", text }],
    isError,
  });
}

async function handleBalance(req: Request, env: Env): Promise<Response> {
  const key = extractBearer(req);
  if (!key) return error(401, "missing bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");
  return json({
    ok: true,
    balance_mcents: rec.balance_mcents,
    balance_usd: (rec.balance_mcents / 100000).toFixed(5),
    xp: rec.xp,
    level: level(rec.xp),
  });
}

async function handleProfile(req: Request, env: Env): Promise<Response> {
  const key = extractBearer(req);
  if (!key) return error(401, "missing bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");
  return json({ ok: true, profile: profileView(rec, key) });
}

async function handleSetName(req: Request, env: Env): Promise<Response> {
  const key = extractBearer(req);
  if (!key) return error(401, "missing bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");

  const body = (await req.json().catch(() => ({}))) as any;
  const name = String(body.display_name || "").trim();
  if (!name) return error(400, "display_name required");
  if (name.length > 32) return error(400, "display_name max 32 chars");

  // Limit name changes to once / 24h to avoid leaderboard spam.
  const DAY = 24 * 3600 * 1000;
  if (rec.name_set_at && Date.now() - rec.name_set_at < DAY) {
    return error(429, "display_name already set in last 24h");
  }
  const updated: KeyRecord = {
    ...rec,
    display_name: name,
    name_set_at: Date.now(),
  };
  await writeKey(env, key, updated);
  await pushActivity(env, key, updated, "gather", 0, `renamed to ${name}`);
  return json({ ok: true, display_name: updated.display_name });
}

async function handleActivity(req: Request, env: Env, url: URL): Promise<Response> {
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));

  // `?mine=1` (or passing a bearer) filters the feed to entries from the
  // requesting key. Whitehat v3 flagged the lack of a per-key filter as a
  // UX-BLOCKER for agent self-service. We match on the 10-char key_short
  // that the activity DO already stores.
  const wantMine = url.searchParams.get("mine") === "1" || url.searchParams.get("key") === "me";
  const bearer = extractBearer(req);

  const activity = await readActivity(env, wantMine ? 200 : limit);

  if (wantMine && bearer) {
    const short = bearer.slice(0, 10) + "…";
    const filtered = activity.filter((a: any) => a.key_short === short).slice(0, limit);
    return json({ ok: true, scope: "mine", activity: filtered });
  }
  return json({ ok: true, scope: "global", activity: activity.slice(0, limit) });
}

async function handleCrawl(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as any;
  if (!body || !body.url) return error(400, "url required");

  // Price by pages requested (capped at 100)
  const pages = Math.min(100, Math.max(1, Number(body.limit) || 10));
  const cost = PRICE_MCENTS.crawl_per_page * pages;

  const auth = await authAndCharge(req, env, cost, "crawl");
  if (auth instanceof Response) return auth;

  const cf = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/crawl`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: body.url,
        limit: pages,
        depth: Math.min(5, body.depth || 2),
        formats: body.formats || ["markdown"],
        render: body.render !== false,
        options: body.options || {},
      }),
    },
  );
  const data: any = await cf.json().catch(() => ({}));

  // Refund on provider-side failure (5xx, auth errors, timeout). CF Browser
  // Rendering returns 200 OK with `{errors:[{code:10000,...}]}` on auth
  // failure — whitehat v3 found agents charged 50mc/page for those. Apply the
  // same refund rule as label/predict.
  const cfProviderError =
    !cf.ok ||
    (Array.isArray(data?.errors) && data.errors.length > 0) ||
    data?.success === false;
  let refunded = false;
  if (cfProviderError) {
    const reply = await applyUserState(env, auth.key, {
      op: "refund",
      amount_mcents: cost,
      now: Date.now(),
      rollback_call_type: "crawl",
    });
    if (reply.ok && (reply as RefundResult).refunded) {
      auth.record = (reply as RefundResult).record;
      refunded = true;
    }
  }
  return json({
    ok: cf.ok && !cfProviderError,
    charged: !refunded,
    refunded,
    balance_mcents: auth.record.balance_mcents,
    xp: auth.record.xp,
    level: level(auth.record.xp),
    cloudflare: data,
  }, { status: cf.ok ? 200 : cf.status });
}

// /v1/upload — authenticated image upload to R2. Free (no mcent charge) —
// we care about who's uploading (scoped per-key) but the storage itself is
// cheap enough to eat for now. Returns a public r2.dev URL that can be
// handed off to /v1/label, /v1/predict, or the jobs marketplace.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_UPLOAD_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
]);

async function handleUpload(req: Request, env: Env): Promise<Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) {
    return error(401, "missing or malformed bearer token");
  }
  const rec = await readKey(env, key);
  if (!rec) return error(401, "unknown api key");

  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) {
    return error(400, 'expected multipart/form-data with "image" field');
  }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return error(400, "malformed multipart body"); }

  const rawFile = form.get("image");
  // In Workers, form.get returns `FormDataEntryValue | null` — narrow on shape
  // rather than `instanceof File` (File isn't in the Workers types lib).
  const file = rawFile && typeof rawFile === "object" && "arrayBuffer" in rawFile
    ? (rawFile as Blob & { name?: string; type: string; size: number; stream: () => ReadableStream })
    : null;
  if (!file) {
    return error(400, 'missing required "image" field (File)');
  }
  if (file.size === 0) return error(400, "empty image");
  if (file.size > MAX_UPLOAD_BYTES) {
    return error(413, `image exceeds ${MAX_UPLOAD_BYTES} byte cap`, {
      got_bytes: file.size,
    });
  }
  const fileType = (file.type || "").toLowerCase();
  if (!ALLOWED_UPLOAD_TYPES.has(fileType)) {
    return error(415, `unsupported content-type ${fileType || "<none>"}`, {
      allowed: [...ALLOWED_UPLOAD_TYPES],
    });
  }

  // Each key gets its own prefix so /v1/my-uploads can list just their files
  // without a separate index. key_short is the first 10 chars of the token —
  // random enough to avoid collisions, never reversible to the full key.
  const keyShort = key.slice(0, 10);
  const ext = fileType.split("/")[1] || "bin";
  const uuid = crypto.randomUUID();
  const objectKey = `${keyShort}/${uuid}.${ext}`;

  const nameField = form.get("name");
  const originalName = (typeof nameField === "string" ? nameField : file.name || "image").slice(0, 200);

  await env.UPLOADS.put(objectKey, file.stream(), {
    httpMetadata: { contentType: fileType },
    customMetadata: {
      dlf_key_short: keyShort,
      original_name: originalName,
      uploaded_at: String(Date.now()),
    },
  });

  const url = `${env.UPLOADS_PUBLIC_BASE.replace(/\/$/, "")}/${objectKey}`;
  return json({
    ok: true,
    url,
    object_key: objectKey,
    size: file.size,
    content_type: fileType,
    display_name: rec.display_name,
  });
}

// /v1/my-models — list trained + published models owned by the caller.
// Returns enriched rows with publish state, uses, revenue when available.
async function handleMyModels(req: Request, env: Env): Promise<Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) {
    return error(401, "missing or malformed bearer token");
  }
  const jobIds = await listUserModels(env, key);
  const rows = await Promise.all(jobIds.map(async (jobId) => {
    const pub = await readPublishedModel(env, jobId);
    return {
      job_id: jobId,
      published: !!pub?.published,
      display_name: pub?.display_name,
      description: pub?.description,
      tags: pub?.tags,
      uses: pub?.uses ?? 0,
      revenue_mcents: pub?.revenue_mcents ?? 0,
      created_at: pub?.created_at,
      published_at: pub?.published_at,
      predict_url: `https://dlf-gateway.agentlabel.workers.dev/v1/predict/${jobId}`,
    };
  }));
  rows.sort((a, b) => (b.published_at || b.created_at || 0) - (a.published_at || a.created_at || 0));
  return json({ ok: true, count: rows.length, models: rows });
}

// /v1/my-uploads — list this key's R2 objects. Uses R2 native list with a
// prefix of the key_short so we don't need a separate index.
async function handleMyUploads(req: Request, env: Env): Promise<Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) {
    return error(401, "missing or malformed bearer token");
  }
  const keyShort = key.slice(0, 10);
  // R2 omits custom/http metadata from list() by default — pass `include`
  // so /v1/my-uploads can surface original_name + content_type without a
  // follow-up HEAD per object. Cast because the current @cloudflare/workers-
  // types build doesn't yet type the `include` field.
  const listed = await env.UPLOADS.list({
    prefix: `${keyShort}/`,
    limit: 200,
    include: ["customMetadata", "httpMetadata"],
  } as any);
  const base = env.UPLOADS_PUBLIC_BASE.replace(/\/$/, "");
  const items = listed.objects.map((o) => ({
    url: `${base}/${o.key}`,
    object_key: o.key,
    size: o.size,
    content_type: o.httpMetadata?.contentType,
    uploaded_at: Number(o.customMetadata?.uploaded_at) || o.uploaded.getTime(),
    original_name: o.customMetadata?.original_name,
  }));
  // newest first
  items.sort((a, b) => b.uploaded_at - a.uploaded_at);
  return json({
    ok: true,
    count: items.length,
    uploads: items,
    truncated: listed.truncated,
  });
}

async function handleGather(req: Request, env: Env): Promise<Response> {
  // Pre-flight validation BEFORE charging — malformed requests shouldn't bill.
  const body: any = await req.json().catch(() => null);
  if (!body || typeof body.query !== "string" || !body.query.trim()) {
    return error(400, 'missing required field "query" (string)', {
      expected: { query: "<search string>", max_images: "<integer 1-20, default 5>" },
      got: body,
      note: "no charge applied",
    });
  }
  // Accept `limit` as alias for `max_images` — blind QA found the MCP schema
  // says max_images but the REST endpoint was silently ignoring `limit`.
  const maxImages = Math.min(20, Math.max(1, Number(body.max_images || body.limit) || 5));

  const auth = await authAndCharge(req, env, PRICE_MCENTS.gather, "gather");
  if (auth instanceof Response) return auth;

  const resp = await fetch(`${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/gather`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: body.query, max_images: maxImages }),
  });
  const data = await resp.json().catch(() => ({}));
  return json({
    ok: resp.ok,
    balance_mcents: auth.record.balance_mcents,
    xp: auth.record.xp,
    level: level(auth.record.xp),
    upstream: data,
  }, { status: resp.status });
}

// Refund policy: only when the upstream provider itself failed (5xx, timeout,
// malformed JSON). Valid 200s with 0 detections are NOT refunded — the model
// did its job, the user's image was just unclear. Rate-limited to 5 refunds
// per key per rolling hour so bad actors can't farm the refund path with
// deliberately-broken inputs.
const REFUND_WINDOW_MS = 60 * 60 * 1000;
const REFUND_MAX_PER_WINDOW = 5;

function shouldRefundLabel(upstreamStatus: number, data: any): boolean {
  // Upstream returned a non-2xx: provider failure.
  if (upstreamStatus >= 500) return true;
  if (upstreamStatus === 408 || upstreamStatus === 429) return true;
  // 200 with an explicit "provider returned error" marker from our Vercel route.
  if (upstreamStatus === 200 && typeof data?.error === "string" && /provider/i.test(data.error)) return true;
  return false;
}

function canIssueRefund(rec: KeyRecord, now: number): boolean {
  const recent = (rec.refunds_window || []).filter((ts) => now - ts < REFUND_WINDOW_MS);
  return recent.length < REFUND_MAX_PER_WINDOW;
}

/**
 * Refund a previously-debited charge on this auth record (same request) and
 * roll back the XP/calls increment that authAndCharge applied. Shared by all
 * paid handlers so error paths don't leak charges to the customer. Caller is
 * responsible for persisting.
 */
function rollbackChargeAndXp(rec: KeyRecord, amount: number, call_type: CallType) {
  rec.balance_mcents += amount;
  rec.xp = Math.max(0, rec.xp - (XP_AWARD[call_type] || 0));
  rec.calls_total = Math.max(0, rec.calls_total - 1);
  const t = rec.calls_by_type[call_type];
  if (typeof t === "number" && t > 0) rec.calls_by_type[call_type] = t - 1;
}

/**
 * Strip deep tracebacks, stack frames, and filesystem paths from an upstream
 * error before returning it to the client. Whitehat review flagged
 * /workspace/handler.py paths + Python module paths leaking in predict errors.
 */
function sanitizeUpstream(data: any): any {
  if (!data || typeof data !== "object") return data;
  const copy: any = Array.isArray(data) ? [...data] : { ...data };
  if ("trace" in copy) delete copy.trace;
  if ("traceback" in copy) delete copy.traceback;
  // Best-effort scrub of filesystem paths / module paths from error strings.
  if (typeof copy.error === "string") {
    copy.error = copy.error
      .replace(/\/[A-Za-z0-9_./-]+\.py(:\d+)?/g, "<file>")
      .replace(/\/workspace\/[A-Za-z0-9_./-]+/g, "<workspace>")
      .replace(/python3?\.\d+(\.\d+)?/gi, "python");
  }
  return copy;
}

async function handleLabel(req: Request, env: Env): Promise<Response> {
  // Pre-flight validation — blind QA burned 400mc on two wrong-field-name
  // calls before discovering `path` + `queries`. Return a 400 with the
  // expected shape instead of charging.
  const parsed: any = await req.json().catch(() => null);
  if (!parsed) {
    return error(400, "invalid JSON body", {
      expected: { path: "<image url>", queries: "<class name>", backend: "openrouter|falcon|auto" },
      note: "no charge applied",
    });
  }
  const imgUrl = parsed.path || parsed.image_url || parsed.url;
  const queries = parsed.queries || parsed.query || parsed.classes;
  if (!imgUrl || typeof imgUrl !== "string") {
    return error(400, 'missing required field "path" (image URL)', {
      expected: { path: "<image url>", queries: "<class name>", backend: "openrouter|falcon|auto" },
      got: Object.keys(parsed),
      note: "no charge applied",
    });
  }
  if (!queries || typeof queries !== "string") {
    return error(400, 'missing required field "queries" (target class)', {
      expected: { path: "<image url>", queries: "<class name>", backend: "openrouter|falcon|auto" },
      got: Object.keys(parsed),
      note: "no charge applied",
    });
  }
  // URL validation BEFORE charge. Rejects SSRF schemes (file://, javascript:,
  // data:), loopback, private networks, cloud metadata. See validateImageUrl.
  const urlCheck = validateImageUrl(imgUrl);
  if (!urlCheck.ok) {
    return error(400, `invalid URL in "path": ${urlCheck.reason}`, {
      expected: "absolute http(s) URL, public host",
      got: imgUrl.slice(0, 120),
      note: "no charge applied",
    });
  }

  const auth = await authAndCharge(req, env, PRICE_MCENTS.label_per_image, "label");
  if (auth instanceof Response) return auth;

  const normalized = {
    path: imgUrl,
    queries,
    backend: parsed.backend || "openrouter",
  };
  const resp = await fetch(`${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/label-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalized),
  });
  const data: any = await resp.json().catch(() => ({}));

  let refunded = false;
  const refundEligible = shouldRefundLabel(resp.status, data);
  if (refundEligible) {
    // Rollback call_type: "label" so XP + calls_by_type also revert. Without
    // this an agent can farm XP by deliberately hitting provider-5xx URLs
    // (whitehat v3 L3). Refund + XP revert together makes attempted-but-
    // failed labels truly neutral.
    const reply = await applyUserState(env, auth.key, {
      op: "refund",
      amount_mcents: PRICE_MCENTS.label_per_image,
      now: Date.now(),
      rollback_call_type: "label",
    });
    if (reply.ok && (reply as RefundResult).refunded) {
      auth.record = (reply as RefundResult).record;
      refunded = true;
      // Provider-side refunds nudge trust score down slightly. Noise
      // tolerance (JACKPOT_MIN_TRUST_SCORE = -2) absorbs 2 bad URLs before
      // the agent loses jackpot eligibility.
      await applyUserState(env, auth.key, { op: "adjust_trust", delta: -1 }).catch(() => {});
    }
  }

  // Reflect upstream provider errors in the top-level `ok` — blind QA noted
  // that getting `ok:true` with `upstream.error:"Provider returned error"`
  // is inconsistent. If we refunded, the call effectively failed.
  const upstreamOk = resp.ok && !(typeof data?.error === "string" && data.error.length > 0);

  // Activation-bonus: count only productive labels (>=1 detection, charged,
  // not refunded). Sybil bots can't farm this by labeling junk URLs — the
  // n_detections guard means they'd pay for worthless work AND still not
  // hit the threshold.
  let activation_bonus_credited = 0;
  const n_det = Number(data?.n_detections) || 0;
  if (
    upstreamOk &&
    !refunded &&
    n_det > 0 &&
    !auth.record.activation_bonus_claimed
  ) {
    const reply = await applyUserState(env, auth.key, {
      op: "activation_credit",
      labels_required: ACTIVATION_LABELS_REQUIRED,
      bonus_mcents: ACTIVATION_BONUS_MCENTS,
    });
    if (reply.ok) {
      const r = reply as ActivationResult;
      auth.record = r.record;
      if (r.credited > 0) activation_bonus_credited = r.credited;
    }
  }

  // Jackpot contribution: every productive label feeds the pool + moves
  // this key's rank. All tiers now participate (prior design penalized
  // subs by excluding unmetered labels — see project_dlf_jackpot memo).
  //
  // - Free labels: 50mc to pool, 1.0× rank weight.
  // - Pro labels: 25mc to pool, 1.5× rank weight.
  // - Dedicated labels: 25mc to pool, 2.0× rank weight.
  // - Subs < 7 days tenured: force weight=1.0 (blocks sub-hopping attacks).
  // - Cap: 2000 weighted points per key per payout period (enforced in DO).
  // Payout is admin-only (no MCP, no cron, 7-day cooldown). Agents can
  // move up the rankings but can never trigger a payout themselves.
  if (upstreamOk && !refunded && n_det > 0) {
    // Productive label → trust +1. Runs fire-and-forget; delays don't block
    // the response.
    await applyUserState(env, auth.key, { op: "adjust_trust", delta: 1 }).catch(() => {});

    const tier = activeTier(auth.record);
    const contrib = tier === "free"
      ? JACKPOT_CONTRIBUTION_MCENTS_FREE
      : JACKPOT_CONTRIBUTION_MCENTS_SUB;
    const baseWeight = JACKPOT_WEIGHT_BY_TIER[tier] ?? 1.0;
    const tenureOk = tier === "free" ||
      (auth.record.sub_started_at &&
        Date.now() - auth.record.sub_started_at >= JACKPOT_SUB_TENURE_MS);
    // Trust gate: below threshold, pool still grows but no rank progress
    // (weight=0). Prevents a low-trust account from climbing jackpot rank
    // while the agent continues earning per-label rewards.
    const trust = auth.record.trust_score ?? 0;
    const rankEligible = trust >= JACKPOT_MIN_TRUST_SCORE;
    const weight = rankEligible ? (tenureOk ? baseWeight : 1.0) : 0;
    try {
      const id = env.JACKPOT.idFromName("global");
      await env.JACKPOT.get(id).fetch("https://jackpot/contribute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: auth.key,
          display_name: auth.record.display_name || "anonymous",
          mcents: contrib,
          weight,
          tier,
        }),
      });
    } catch {
      // Never block a successful label on jackpot bookkeeping.
    }
  }

  return json({
    ok: upstreamOk,
    balance_mcents: auth.record.balance_mcents,
    xp: auth.record.xp,
    level: level(auth.record.xp),
    charged: !refunded,
    refunded,
    activation: auth.record.activation_bonus_claimed
      ? { status: "claimed", bonus_mcents: ACTIVATION_BONUS_MCENTS }
      : {
          status: "pending",
          labels_done: auth.record.activation_labels_done || 0,
          labels_required: ACTIVATION_LABELS_REQUIRED,
          bonus_mcents: ACTIVATION_BONUS_MCENTS,
          ...(activation_bonus_credited ? { just_credited: activation_bonus_credited } : {}),
        },
    upstream: data,
  }, { status: resp.status });
}

// ---- Predict: run a trained model on a new image --------------------------
//
// Caches weights in KV on first call per job_id (to avoid re-fetching the 6MB
// .pt from Vercel on every inference), then forwards {weights_b64, image_url}
// to the dlf-yolo-infer RunPod endpoint.

// ---- Marketplace: published trained models ---------------------------------
//
// When a model is published, anyone with a dlf_ key can call /v1/predict on
// it. The inference fee is split:
//   70% credited to the owner's balance (passive income per trained model)
//   30% retained by the gateway (covers RunPod GPU + CF egress + margin)
//
// Owners claim ownership the moment they successfully call train-yolo/start;
// we stash { owner_key } under `model_owner:<job_id>`. Publishing adds
// { published: true, display_name, description, ... } under `model:<job_id>`.

const MARKETPLACE_OWNER_SHARE = 0.7;

type PublishedModel = {
  job_id: string;
  owner_key_short: string;
  display_name: string;
  description?: string;
  tags?: string[];
  published: boolean;
  uses: number;
  revenue_mcents: number; // cumulative owner revenue in mcents
  created_at: number;
  published_at: number;
};

async function readPublishedModel(env: Env, jobId: string): Promise<PublishedModel | null> {
  const raw = await env.KEYS.get(`model:${jobId}`);
  return raw ? (JSON.parse(raw) as PublishedModel) : null;
}

async function writePublishedModel(env: Env, jobId: string, m: PublishedModel): Promise<void> {
  await env.KEYS.put(`model:${jobId}`, JSON.stringify(m));
}

async function readModelOwner(env: Env, jobId: string): Promise<string | null> {
  return env.KEYS.get(`model_owner:${jobId}`);
}

async function writeModelOwner(env: Env, jobId: string, key: string): Promise<void> {
  // Durable: never overwrite an existing owner.
  const existing = await env.KEYS.get(`model_owner:${jobId}`);
  if (existing) return;
  await env.KEYS.put(`model_owner:${jobId}`, key);
  // Reverse index so /v1/my-models can list a user's models cheaply via
  // a prefix scan instead of walking every model_owner:* key.
  const keyShort = key.slice(0, 10);
  await env.KEYS.put(`user_model:${keyShort}:${jobId}`, String(Date.now()));
}

// Lists trained jobs owned by the caller. Uses the forward reverse-index
// written by writeModelOwner; older models (pre-index) are backfilled
// lazily by scanning model_owner:* once per list call when the prefix is
// empty for this key.
async function listUserModels(env: Env, key: string): Promise<string[]> {
  const keyShort = key.slice(0, 10);
  const prefix = `user_model:${keyShort}:`;
  const list = await env.KEYS.list({ prefix, limit: 200 });
  let jobIds = list.keys.map((k) => k.name.slice(prefix.length));
  if (jobIds.length === 0) {
    // Lazy backfill: scan up to 100 `model_owner:*` entries, find this
    // user's, populate the index, and STAMP the fact that we scanned so
    // subsequent calls skip this work even if the user has no models.
    // Capped at 100 (not 500) so a cold /v1/my-models never starves the
    // parallel /v1/balance / /v1/my-uploads calls on the same request.
    const scanMarker = `user_model_scan:${keyShort}`;
    const alreadyScanned = await env.KEYS.get(scanMarker);
    if (!alreadyScanned) {
      const scan = await env.KEYS.list({ prefix: "model_owner:", limit: 100 });
      for (const k of scan.keys) {
        const ownerKey = await env.KEYS.get(k.name);
        if (ownerKey === key) {
          const jobId = k.name.slice("model_owner:".length);
          jobIds.push(jobId);
          try { await env.KEYS.put(`user_model:${keyShort}:${jobId}`, String(Date.now())); } catch {}
        }
      }
      try { await env.KEYS.put(scanMarker, String(Date.now())); } catch {}
    }
  }
  return jobIds;
}

async function getCachedWeights(env: Env, jobId: string): Promise<string | null> {
  const cacheKey = `weights_b64:${jobId}`;
  const cached = await env.KEYS.get(cacheKey);
  if (cached) return cached;

  // Fetch .pt from Vercel route, base64-encode, cache.
  const resp = await fetch(`${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/train-yolo/weights/${jobId}`);
  if (!resp.ok) return null;
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  // KV value limit is 25 MB; typical yolov8n.pt is ~6 MB as binary, ~8 MB b64.
  await env.KEYS.put(cacheKey, b64, { expirationTtl: 60 * 60 * 24 * 7 });
  return b64;
}

async function handlePredict(req: Request, env: Env, jobId: string): Promise<Response> {
  // Pre-flight 1: infra ready?
  const endpointId = (env as any).RUNPOD_INFER_ENDPOINT_ID;
  const apiKey = (env as any).RUNPOD_API_KEY;
  if (!endpointId || !apiKey) {
    return error(503, "inference endpoint not yet configured; no charge applied");
  }

  // Pre-flight 2: validate body BEFORE charging. Whitehat flagged that
  // bad requests were burning the full 300 mcent price.
  let body: any;
  try { body = await req.json(); }
  catch {
    return error(400, "invalid JSON body", {
      expected: { image_url: "<url to image>" },
      note: "no charge applied",
    });
  }
  const imageUrl = body?.image_url || body?.path;
  if (!imageUrl || typeof imageUrl !== "string") {
    return error(400, 'missing required field "image_url"', {
      expected: { image_url: "<url to image>" },
      got: body ? Object.keys(body) : [],
      note: "no charge applied",
    });
  }

  const auth = await authAndCharge(req, env, PRICE_MCENTS.predict_per_image, "predict");
  if (auth instanceof Response) return auth;

  // Refund + rollback helper for this handler. Adds to refunds_window so
  // abuse is capped at REFUND_MAX_PER_WINDOW/hour.
  const refundAndFail = async (status: number, errMsg: string, extra: any = {}) => {
    const reply = await applyUserState(env, auth.key, {
      op: "refund",
      amount_mcents: PRICE_MCENTS.predict_per_image,
      now: Date.now(),
      rollback_call_type: "predict",
    });
    const refunded = reply.ok && (reply as RefundResult).refunded;
    if (refunded) auth.record = (reply as RefundResult).record;
    return json({
      ok: false, error: errMsg, charged: !refunded, refunded,
      balance_mcents: auth.record.balance_mcents,
      model_job_id: jobId, ...extra,
    }, { status });
  };

  // Marketplace gate: if the model is published, ANY key can use it (after
  // paying). If it's private (default), only the owner can use it.
  const ownerKey = await readModelOwner(env, jobId);
  const pub = await readPublishedModel(env, jobId);
  const isOwner = !!ownerKey && ownerKey === auth.key;
  const isPublic = !!pub?.published;
  if (ownerKey && !isOwner && !isPublic) {
    // No refund window update — we charged up front in authAndCharge and the
    // request never reached the GPU. Roll back cleanly through the DO.
    const reply = await applyUserState(env, auth.key, {
      op: "rollback",
      amount_mcents: PRICE_MCENTS.predict_per_image,
      call_type: "predict",
    });
    if (reply.ok) auth.record = (reply as RollbackResult).record;
    return json({
      ok: false,
      charged: false, refunded: true,
      error: "this model is private; ask the owner to publish it, or use a model you trained",
      balance_mcents: auth.record.balance_mcents,
      model_job_id: jobId,
    }, { status: 403 });
  }

  const weightsB64 = await getCachedWeights(env, jobId);
  if (!weightsB64) {
    return refundAndFail(404, "weights not found for this job_id (check train completed)");
  }

  // Submit job asynchronously then poll. /runsync would be simpler but its
  // wait window (~10-30s) often expires while the worker is still cold —
  // clients would see IN_QUEUE and no output.
  const submit = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { weights_b64: weightsB64, image_url: imageUrl } }),
  });
  const submitData: any = await submit.json().catch(() => ({}));
  const runId = submitData?.id;
  if (!submit.ok || !runId) {
    return refundAndFail(
      submit.status || 502,
      sanitizeUpstream(submitData)?.error || `runpod submit ${submit.status}`,
    );
  }

  const deadline = Date.now() + 90_000; // 90s total budget
  let lastStatus: any = null;
  while (Date.now() < deadline) {
    const poll = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${runId}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    const pollData: any = await poll.json().catch(() => ({}));
    lastStatus = pollData;
    const st = pollData?.status;
    if (st === "COMPLETED") {
      const rawOut = pollData.output;
      const sanitized = sanitizeUpstream(rawOut || {});
      // RunPod occasionally reports COMPLETED with empty/missing output when
      // the worker exited before writing a result. Refund instead of
      // returning ok:true with an empty upstream (QA saw n_detections=None).
      const hasShape =
        rawOut &&
        typeof rawOut === "object" &&
        (typeof rawOut.n_detections === "number" || rawOut.ok === false);
      if (!hasShape) {
        return refundAndFail(
          502,
          "upstream returned COMPLETED without a detections payload",
          { run_id: runId, upstream: sanitized },
        );
      }
      if (sanitized?.ok === false) {
        return refundAndFail(
          502,
          sanitized.error || "upstream predict returned ok:false",
          { run_id: runId, upstream: sanitized },
        );
      }
      // Revenue split: credit 70% to published-model owner; record uses + revenue.
      if (pub?.published && ownerKey && !isOwner) {
        const ownerShare = Math.floor(PRICE_MCENTS.predict_per_image * MARKETPLACE_OWNER_SHARE);
        try {
          await applyUserState(env, ownerKey, { op: "credit", amount_mcents: ownerShare });
          const m = await readPublishedModel(env, jobId);
          if (m) {
            m.uses += 1;
            m.revenue_mcents += ownerShare;
            await writePublishedModel(env, jobId, m);
          }
        } catch {}
      }
      return json({
        ok: true,
        balance_mcents: auth.record.balance_mcents,
        xp: auth.record.xp,
        level: level(auth.record.xp),
        model_job_id: jobId,
        run_id: runId,
        marketplace: pub?.published ? { owner: pub.display_name, share_to_owner_mcents: Math.floor(PRICE_MCENTS.predict_per_image * MARKETPLACE_OWNER_SHARE) } : undefined,
        upstream: sanitized,
      });
    }
    if (st === "FAILED" || st === "CANCELLED") {
      return refundAndFail(
        502,
        `job ${st}`,
        { run_id: runId, upstream: sanitizeUpstream(pollData) },
      );
    }
    // IN_QUEUE / IN_PROGRESS — wait and retry.
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Timed out — agent's worker is cold enough to exceed our budget. Refund
  // since we can't prove the job ran.
  return refundAndFail(
    504,
    "inference timed out after 90s; retry when worker is warm",
    { run_id: runId, upstream: sanitizeUpstream(lastStatus) },
  );
}

async function handleTrainStart(req: Request, env: Env): Promise<Response> {
  // Pre-flight validation BEFORE charging. Whitehat flagged empty/negative
  // jobs were billed at full 2000mc even though RunPod received nothing
  // usable.
  let parsed: any;
  try { parsed = await req.json(); }
  catch {
    return error(400, "invalid JSON body", {
      expected: {
        query: "<class name>",
        epochs: "<integer 1-200>",
        images: "[{url, image_size:[w,h], annotations:[{bbox:[x,y,w,h], category}]}, ...]",
      },
      note: "no charge applied",
    });
  }
  const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
  if (!query) {
    return error(400, 'missing required field "query" (non-empty string)', { note: "no charge applied" });
  }
  const rawImages = Array.isArray(parsed.images) ? parsed.images : [];
  const images = rawImages.filter(
    (it: any) =>
      it && typeof it === "object" &&
      typeof it.url === "string" && it.url.length > 0 &&
      Array.isArray(it.annotations) && it.annotations.length > 0,
  );
  if (images.length < 2) {
    return error(400, `train requires at least 2 images with non-empty annotations (got ${images.length} valid)`, {
      submitted: rawImages.length,
      valid_after_filter: images.length,
      note: "no charge applied",
    });
  }
  const epochs = Math.max(1, Math.min(200, Number(parsed.epochs) || 20));

  const auth = await authAndCharge(req, env, PRICE_MCENTS.train_yolo, "train");
  if (auth instanceof Response) return auth;

  const normalized = { query, epochs, images };
  const resp = await fetch(`${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/train-yolo/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalized),
  });
  const data = sanitizeUpstream(await resp.json().catch(() => ({})));

  // Record ownership: whoever paid to train owns the resulting model. Owners
  // can later publish it to the marketplace and earn the 70% owner share on
  // every predict call by other agents.
  if (data?.job_id && typeof data.job_id === "string") {
    try { await writeModelOwner(env, data.job_id, auth.key); } catch {}
  }

  // RunPod submit failed → refund (we can't be billed by RunPod for a job
  // that never dispatched, but we shouldn't bill the customer either).
  if (!resp.ok || !data?.job_id) {
    const reply = await applyUserState(env, auth.key, {
      op: "refund",
      amount_mcents: PRICE_MCENTS.train_yolo,
      now: Date.now(),
      rollback_call_type: "train",
    });
    if (reply.ok && (reply as RefundResult).refunded) {
      auth.record = (reply as RefundResult).record;
      return json({
        ok: false,
        error: data?.error || `train submit ${resp.status}`,
        charged: false, refunded: true,
        balance_mcents: auth.record.balance_mcents,
        upstream: data,
      }, { status: resp.status || 502 });
    }
  }

  return json({
    ok: resp.ok,
    balance_mcents: auth.record.balance_mcents,
    xp: auth.record.xp,
    level: level(auth.record.xp),
    new_badges: auth.record.badges,
    upstream: data,
  }, { status: resp.status });
}

async function handleTrainStatus(req: Request, env: Env, jobId: string): Promise<Response> {
  const key = extractBearer(req);
  if (!key) return error(401, "missing bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");
  const resp = await fetch(`${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/train-yolo/status/${jobId}`);
  const data: any = await resp.json().catch(() => ({}));

  // Normalize unknown-job responses so agents polling a lost or never-minted
  // job_id get a crisp 404 instead of a 502 HTML blob from upstream. Whitehat
  // v3 found pollers could sit in a 502 loop indefinitely.
  const unknownJob =
    resp.status === 404 ||
    resp.status === 502 ||
    resp.status === 503 ||
    (data && typeof data.error === "string" && /not found|unknown|no such/i.test(data.error));
  if (unknownJob) {
    return json({
      ok: false,
      error: `job_id not found: ${jobId}`,
      balance_mcents: rec.balance_mcents,
      xp: rec.xp,
      level: level(rec.xp),
      upstream: sanitizeUpstream(data),
    }, { status: 404 });
  }
  return json({ ok: resp.ok, balance_mcents: rec.balance_mcents, xp: rec.xp, level: level(rec.xp), upstream: sanitizeUpstream(data) }, { status: resp.status });
}

async function handleTrainWeights(req: Request, env: Env, jobId: string): Promise<Response> {
  const key = extractBearer(req);
  if (!key) return error(401, "missing bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");
  if (!hasScope(rec, "train")) {
    return error(403, "this key is not authorized for train/weights", {
      scopes: rec.scopes,
      required_scope: "train",
    });
  }

  // Ownership gate: only the training key OR a key with "all"/admin scope can
  // download weights. Marketplace callers download via /v1/predict/:id which
  // caches weights internally; humans who want to share should /publish.
  // Whitehat v3 found /weights previously returned raw CF 502 HTML on bogus
  // or unauthorized job_ids — we normalize to 404/403 JSON here.
  const ownerKey = await readModelOwner(env, jobId);
  if (!ownerKey) {
    return error(404, `no training job with id ${jobId}`, { model_job_id: jobId });
  }
  if (ownerKey !== key && !hasScope(rec, "all")) {
    return error(403, "only the training key can download raw weights; use /v1/predict/:id for marketplace inference", {
      model_job_id: jobId,
    });
  }

  // RunPod's output becomes fetchable 1-3s after the status flips to COMPLETED.
  // Agents polling status and immediately hitting /weights race that window and
  // get a transient 403/404/425. Retry with exponential backoff.
  const upstreamUrl = `${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/train-yolo/weights/${jobId}`;
  const transientStatuses = new Set([403, 404, 425, 502, 503]);
  const backoffMs = [0, 1500, 3000, 4500];
  let resp: Response = new Response("exhausted", { status: 500 });
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    }
    resp = await fetch(upstreamUrl);
    if (resp.ok) break;
    if (!transientStatuses.has(resp.status)) break;
  }

  // If upstream still failed after retries, surface JSON, not raw HTML.
  if (!resp.ok) {
    return error(resp.status, `weights fetch failed (${resp.status})`, {
      model_job_id: jobId,
      hint: resp.status === 404 ? "training may not be COMPLETED yet; poll /v1/train-yolo/status/:id" : undefined,
    });
  }

  const headers = new Headers(resp.headers);
  headers.set("X-DLF-Balance-Mcents", String(rec.balance_mcents));
  headers.set("X-DLF-XP", String(rec.xp));
  headers.set("X-DLF-Level", String(level(rec.xp)));
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(resp.body, { status: resp.status, headers });
}

// ---- Admin handlers ---------------------------------------------------------

// ---- x402-gated signup -----------------------------------------------------
//
// Pay-to-mint: agents POST /v1/signup. Without X-PAYMENT header we return
// HTTP 402 with the x402 payment requirements (USDC on Base, $0.10 to
// PAYMENT_RECIPIENT). With a valid X-PAYMENT header (base64-encoded
// signed USDC transferWithAuthorization), we verify via a facilitator and
// mint the key with a starter balance.
//
// Docs: https://www.x402.org | https://docs.cdp.coinbase.com/x402/welcome
//
// Required secrets:
//   PAYMENT_RECIPIENT       — EVM address (0x…) receiving the USDC
//   PAYMENT_FACILITATOR_URL — e.g. https://x402.org/facilitator (default)
//
// Pricing: 100,000 atomic USDC units = $0.10 (USDC is 6 decimals)
// Starter balance: 1:1 with payment. Bonus is EARNED via labeling.

const SIGNUP_PRICE_ATOMIC = "100000"; // 0.10 USDC (6 decimals)
// Starter credit matches the payment 1:1. No walkaway free credit — a sybil
// that pays + leaves breaks even on dollars, doesn't profit.
const SIGNUP_STARTER_MCENTS = 10000; // $0.10

// Activation bonus: credited to the user's balance ONLY after they complete
// ACTIVATION_LABELS_REQUIRED successful labels. Labels with 0 detections don't
// count (must be real work). Prevents sybil bots from farming the bonus via
// junk URLs; rewards actual product usage.
const ACTIVATION_BONUS_MCENTS = 5000; // $0.05
const ACTIVATION_LABELS_REQUIRED = 5;

// ---- Label Jackpot ---------------------------------------------------------
// A portion of every trust-verified label is pooled. Payouts are triggered
// manually by an admin (X-Admin-Key) — NEVER scheduled, NEVER via MCP —
// so no agent-driven prompt-injection path can ever reach the treasury.
//
// Contribution: 50 mcents per qualifying Free-tier label (= 25% of 200mc
// label price). Pro/Dedicated contribute 25mc — half, since they already
// pay a sub and shouldn't 1:1 subsidize Free prizes.
// Margin on a Free label drops from ~75% to ~50% — the missing 25% is
// seeded back to the community as cash prizes.
//
// Payout split on the main pool (90% of total): 50% / 30% / 20% to top 3
// labelers by *weighted* count since the last payout. 10% is carved off
// into a subscriber sub-pool (60/40 to top-2 Pro/Dedicated users) so subs
// get a visible prize even when Free Sybils dominate raw volume.
// Counts reset atomically at payout time.
const JACKPOT_CONTRIBUTION_MCENTS_FREE = 50;
const JACKPOT_CONTRIBUTION_MCENTS_SUB = 25;
const JACKPOT_PAYOUT_SPLITS = [0.5, 0.3, 0.2];
// Rank-weight multipliers per tier. Labels count this much toward label_count.
const JACKPOT_WEIGHT_BY_TIER: Record<Tier, number> = {
  free: 1.0,
  pro: 1.5,
  dedicated: 2.0,
  enterprise: 2.0,
};
// Anti-farm: per-key weighted-count cap per payout period. Above this, the
// label still contributes mcents to the pool but doesn't move rank. Bites
// pre-grinding attackers while leaving headroom for real production use.
const JACKPOT_WEIGHT_CAP_PER_PERIOD = 2000;
// New subscribers count at 1.0× for the first 7 days after subscribing —
// prevents sub-hopping attacks where someone buys Pro 48h before a payout,
// grinds, wins, cancels.
const JACKPOT_SUB_TENURE_MS = 7 * 86400_000;
// Carve 10% of pool into the subscriber sub-pool before the main 50/30/20.
const JACKPOT_SUB_POOL_FRACTION = 0.10;
const JACKPOT_SUB_POOL_SPLITS = [0.6, 0.4];
// Payout cooldown: refuse payouts closer than this to the prior one.
// Blunts admin-timing attacks and forces predictable payout windows.
// Conservative 7d while payouts are manual-only. If we switch on the
// daily scheduled() trigger in wrangler.toml, drop this to 23h so the
// cron clears the gate each day.
const JACKPOT_PAYOUT_COOLDOWN_MS = 7 * 86400_000;

const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACILITATOR_FREE = "https://x402.org/facilitator";
const FACILITATOR_CDP = "https://api.cdp.coinbase.com/platform/v2/x402";
// Tempo networks (chain 4217 / 42431) intentionally NOT advertised in
// accepts[]: the community `tempo-x402-node` uses a bespoke `tempo-tip20`
// scheme incompatible with the standard x402 "exact" EVM signature flow,
// and no public facilitator exists. Re-enable when a standards-compliant
// Tempo facilitator ships.

function signupRequirements(env: Env, resource: string) {
  const payTo = (env as any).PAYMENT_RECIPIENT || "0x0000000000000000000000000000000000000000";
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact" as const,
        network: "base",
        maxAmountRequired: SIGNUP_PRICE_ATOMIC,
        resource,
        description: "DLF agent API key — $0.10 unlocks 10,000 mcents (1:1 starter) + $0.05 activation bonus unlockable by labeling 5 images",
        mimeType: "application/json",
        payTo,
        maxTimeoutSeconds: 60,
        asset: USDC_BASE_MAINNET,
        outputSchema: {
          input: { type: "http", method: "POST" },
          output: { type: "object", properties: { ok: {}, key: {}, balance_mcents: {} } },
        },
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
}

// ---- CDP JWT signing (Ed25519) --------------------------------------------
// CDP's x402 facilitator requires a Bearer JWT signed with the account's
// Ed25519 private key. Tokens are per-request (uri claim pinned to the call)
// and expire in 120s. Spec:
// https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function cdpJwt(env: Env, method: string, host: string, path: string): Promise<string> {
  const keyId = (env as any).CDP_API_KEY_ID;
  const secretB64 = (env as any).CDP_API_KEY_SECRET;
  if (!keyId || !secretB64) throw new Error("CDP creds missing");

  const raw = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
  if (raw.length !== 64) throw new Error(`CDP secret must be 64 bytes, got ${raw.length}`);
  const seed = raw.slice(0, 32);
  const pub = raw.slice(32, 64);

  // CF Workers Ed25519 needs JWK format for private-key import.
  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    d: base64UrlEncode(seed),
    x: base64UrlEncode(pub),
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "Ed25519" } as any,
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: keyId, nonce: randomHex(16) };
  const payload = {
    iss: "cdp",
    sub: keyId,
    nbf: now,
    iat: now,
    exp: now + 120,
    uris: [`${method} ${host}${path}`],
  };
  const segH = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const segP = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${segH}.${segP}`);
  const sig = await crypto.subtle.sign({ name: "Ed25519" } as any, key, signingInput);
  return `${segH}.${segP}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function facilitatorFor(env: Env): { url: string; useCdp: boolean } {
  const override = (env as any).PAYMENT_FACILITATOR_URL;
  if (override) return { url: override, useCdp: false };
  const hasCdp = !!((env as any).CDP_API_KEY_ID && (env as any).CDP_API_KEY_SECRET);
  return hasCdp ? { url: FACILITATOR_CDP, useCdp: true } : { url: FACILITATOR_FREE, useCdp: false };
}

async function cdpCall(env: Env, url: string, body: any): Promise<Response> {
  const u = new URL(url);
  const jwt = await cdpJwt(env, "POST", u.host, u.pathname);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

async function verifyX402Payment(
  env: Env,
  paymentHeader: string,
  requirements: ReturnType<typeof signupRequirements>,
): Promise<{ ok: boolean; payer?: string; error?: string; network?: string; facilitator?: string }> {
  let payload: any;
  try {
    const decoded = atob(paymentHeader);
    payload = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "malformed X-PAYMENT header (must be base64(json))" };
  }

  const network = payload?.network || payload?.payload?.network || "base";
  const matching = requirements.accepts.find((a) => a.network === network) || requirements.accepts[0];
  const { url: facilitator, useCdp } = facilitatorFor(env);
  const body = { x402Version: 1, paymentPayload: payload, paymentRequirements: matching };

  try {
    const verifyUrl = `${facilitator.replace(/\/$/, "")}/verify`;
    const vr = useCdp ? await cdpCall(env, verifyUrl, body) : await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const vd: any = await vr.json().catch(() => ({}));
    if (!vr.ok || vd?.isValid === false) {
      return { ok: false, error: vd?.invalidReason || vd?.error || `verify ${vr.status}`, network, facilitator };
    }

    const settleUrl = `${facilitator.replace(/\/$/, "")}/settle`;
    const sr = useCdp ? await cdpCall(env, settleUrl, body) : await fetch(settleUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sd: any = await sr.json().catch(() => ({}));
    if (!sr.ok || sd?.success === false) {
      return { ok: false, error: sd?.errorReason || sd?.error || `settle ${sr.status}`, network, facilitator };
    }
    return { ok: true, payer: sd?.payer || payload?.payload?.authorization?.from, network, facilitator };
  } catch (e: any) {
    return { ok: false, error: e?.message || "facilitator unreachable", network, facilitator };
  }
}

async function handleSignup(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const resource = `${url.protocol}//${url.host}/v1/signup`;
  const requirements = signupRequirements(env, resource);
  const paymentHeader = req.headers.get("X-PAYMENT");

  if (!paymentHeader) {
    return new Response(
      JSON.stringify({ ...requirements, error: "Payment required" }),
      {
        status: 402,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "X-PAYMENT-RESPONSE",
        },
      },
    );
  }

  const verify = await verifyX402Payment(env, paymentHeader, requirements);
  if (!verify.ok) {
    return new Response(
      JSON.stringify({ ...requirements, error: verify.error || "payment verification failed" }),
      { status: 402, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as any;
  const raw = body?.display_name ? String(body.display_name) : "";
  const clean = raw.replace(/[^\w\- ]/g, "").trim().slice(0, 32);
  const display_name = clean || `Agent-${Math.random().toString(36).slice(2, 7)}`;

  const key = await generateApiKey();
  const rec: KeyRecord = {
    balance_mcents: SIGNUP_STARTER_MCENTS,
    xp: 0,
    created_at: Date.now(),
    last_active_at: Date.now(),
    label: verify.payer ? `x402:${verify.network}:${verify.payer}` : `x402:${verify.network || "base"}`,
    display_name,
    name_set_at: Date.now(),
    calls_total: 0,
    calls_by_type: {},
    badges: [],
  };
  await writeKey(env, key, rec);

  return new Response(
    JSON.stringify({
      ok: true,
      key,
      display_name,
      balance_mcents: SIGNUP_STARTER_MCENTS,
      balance_usd: (SIGNUP_STARTER_MCENTS / 100000).toFixed(5),
      payer: verify.payer,
      note: "save this key — it won't be shown again.",
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "X-PAYMENT-RESPONSE": "settled",
      },
    },
  );
}

// Subscribe an existing key to a paid tier via x402 USDC on Base.
// Flow: client POSTs /v1/subscribe with { tier: "pro" | "dedicated" } (and
// their existing bearer token). No X-PAYMENT → 402 with tier quote. With
// X-PAYMENT → CDP verifies, we set tier + expiry + quota on the key record.
async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) return error(401, "missing or malformed bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");

  const body = (await req.json().catch(() => ({}))) as any;
  const wantedTier = String(body?.tier || "pro") as Tier;
  if (wantedTier !== "pro" && wantedTier !== "dedicated") {
    return error(400, "invalid tier", { expected: ["pro", "dedicated"], got: wantedTier });
  }
  // Dedicated tier requires workersMin=1 on the RunPod predict endpoint —
  // without it, profitability sim flags worst-case-UNSAFE at -$390/mo per
  // adversarial user. Gated off by default; flip DEDICATED_TIER_ENABLED=1
  // only after setting workersMin=1 via RunPod MCP.
  if (wantedTier === "dedicated" && (env as any).DEDICATED_TIER_ENABLED !== "1") {
    return error(503, "Dedicated tier not available yet", {
      hint: "we're still provisioning the warm GPU slot required for this tier; please subscribe to Pro or check back soon",
      available_tiers: ["pro"],
    });
  }
  const def = TIER_DEFS[wantedTier];

  const url = new URL(req.url);
  const resource = `${url.protocol}//${url.host}/v1/subscribe`;
  const requirements = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact" as const,
        network: "base",
        maxAmountRequired: def.price_usdc_atomic,
        resource,
        description: `DLF ${def.name} tier — ${def.duration_days}d of ${def.unmetered.join("/")} unmetered + ${Object.entries(def.quota).map(([k, v]) => `${v} ${k}`).join(" + ") || "no GPU quota"}`,
        mimeType: "application/json",
        payTo: (env as any).PAYMENT_RECIPIENT || "0x0000000000000000000000000000000000000000",
        maxTimeoutSeconds: 60,
        asset: USDC_BASE_MAINNET,
        outputSchema: {
          input: { type: "http", method: "POST" },
          output: { type: "object", properties: { ok: {}, tier: {}, expires_at: {} } },
        },
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };

  const paymentHeader = req.headers.get("X-PAYMENT");
  if (!paymentHeader) {
    return new Response(
      JSON.stringify({ ...requirements, error: "Payment required" }),
      {
        status: 402,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "X-PAYMENT-RESPONSE",
        },
      },
    );
  }

  const verify = await verifyX402Payment(env, paymentHeader, requirements as any);
  if (!verify.ok) {
    return new Response(
      JSON.stringify({ ...requirements, error: verify.error || "payment verification failed" }),
      { status: 402, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } },
    );
  }

  const now = Date.now();
  // Stack renewals: if already on this tier (or higher), extend expiry from
  // the later of now / existing expiry. Downgrades reset expiry fresh.
  const sameOrBetter = rec.tier === wantedTier ||
    (rec.tier === "enterprise") ||
    (rec.tier === "dedicated" && wantedTier === "pro");
  const base = sameOrBetter && rec.tier_expires_at && rec.tier_expires_at > now ? rec.tier_expires_at : now;
  const expiresAt = base + def.duration_days * 86400_000;

  const updated: KeyRecord = {
    ...rec,
    tier: wantedTier,
    tier_expires_at: expiresAt,
    tier_quota: { ...def.quota }, // fresh quota on each renewal
    // First-time subscription timestamp; never overwritten on renewals so
    // returning subscribers keep their jackpot tenure.
    sub_started_at: rec.sub_started_at || now,
  };
  await writeKey(env, key, updated);

  return new Response(
    JSON.stringify({
      ok: true,
      tier: wantedTier,
      tier_name: def.name,
      expires_at: expiresAt,
      days: def.duration_days,
      unmetered: def.unmetered,
      quota: def.quota,
      payer: verify.payer,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "X-PAYMENT-RESPONSE": "settled",
      },
    },
  );
}

async function handleTierStatus(req: Request, env: Env): Promise<Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) return error(401, "missing or malformed bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");
  return json({ ok: true, ...tierView(rec) });
}

// ---- Jackpot: public status + admin-only payout ---------------------------

async function handleJackpotStatus(_req: Request, env: Env): Promise<Response> {
  const id = env.JACKPOT.idFromName("global");
  const resp = await env.JACKPOT.get(id).fetch("https://jackpot/status");
  const data = await resp.json().catch(() => ({}));
  return json({
    ok: true,
    contribution_mcents_per_label: {
      free: JACKPOT_CONTRIBUTION_MCENTS_FREE,
      pro: JACKPOT_CONTRIBUTION_MCENTS_SUB,
      dedicated: JACKPOT_CONTRIBUTION_MCENTS_SUB,
    },
    rank_weight_by_tier: JACKPOT_WEIGHT_BY_TIER,
    weight_cap_per_period: JACKPOT_WEIGHT_CAP_PER_PERIOD,
    sub_tenure_days: JACKPOT_SUB_TENURE_MS / 86400_000,
    payout_split_pct: JACKPOT_PAYOUT_SPLITS.map((s) => Math.round(s * 100)),
    sub_pool_fraction: JACKPOT_SUB_POOL_FRACTION,
    sub_pool_split_pct: JACKPOT_SUB_POOL_SPLITS.map((s) => Math.round(s * 100)),
    payout_cooldown_days: JACKPOT_PAYOUT_COOLDOWN_MS / 86400_000,
    ...data as object,
  });
}

// Admin-only. Not exposed via MCP. Distributes the pool and resets counters.
async function handleAdminJackpotPayout(req: Request, env: Env): Promise<Response> {
  const gate = requireAdmin(req, env);
  if (gate) return gate;

  const id = env.JACKPOT.idFromName("global");
  const resp = await env.JACKPOT.get(id).fetch("https://jackpot/payout", { method: "POST" });
  const data = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    cooldown_ms_remaining?: number;
    pool_paid?: number;
    main_pool?: number;
    sub_pool?: number;
    distributed?: number;
    remainder?: number;
    winners?: {
      key: string;
      display_name: string;
      share_mcents: number;
      label_count: number;
      bucket?: "main" | "sub";
      tier?: Tier;
    }[];
  };

  // Cooldown hit → 429 through to the admin caller with cooldown info so they
  // know when they can try again.
  if (resp.status === 429 || (!data?.ok && data?.cooldown_ms_remaining)) {
    return json(
      {
        ok: false,
        error: data.error || "payout cooldown active",
        cooldown_ms_remaining: data.cooldown_ms_remaining,
      },
      { status: 429 },
    );
  }
  if (!data?.ok) return json({ ok: false, error: "payout failed" }, { status: 500 });

  // Credit each winner's balance. Best-effort; skip winners whose keys are
  // no longer in KV (deleted by admin etc.). A single key may appear twice
  // (main + sub pool) — credit both.
  const credited: { display_name: string; key_short: string; share_mcents: number; new_balance_mcents: number; label_count: number; bucket?: string; tier?: Tier }[] = [];
  const skipped: { display_name: string; key_short: string; reason: string }[] = [];
  for (const w of data.winners || []) {
    const reply = await applyUserState(env, w.key, { op: "credit", amount_mcents: w.share_mcents });
    if (!reply.ok) {
      skipped.push({
        display_name: w.display_name,
        key_short: w.key.slice(0, 10) + "…",
        reason: (reply as UserStateError).error,
      });
      continue;
    }
    const rec = (reply as CreditResult).record;
    credited.push({
      display_name: w.display_name,
      key_short: w.key.slice(0, 10) + "…",
      share_mcents: w.share_mcents,
      new_balance_mcents: rec.balance_mcents,
      label_count: w.label_count,
      bucket: w.bucket,
      tier: w.tier,
    });
  }

  return json({
    ok: true,
    pool_paid_mcents: data.pool_paid || 0,
    pool_paid_usd: ((data.pool_paid || 0) / 100000).toFixed(2),
    main_pool_mcents: data.main_pool || 0,
    sub_pool_mcents: data.sub_pool || 0,
    distributed_mcents: data.distributed || 0,
    remainder_mcents: data.remainder || 0,
    credited,
    skipped,
  });
}

// Admin-only lever to zero a key's weighted count for the current period
// without banning the account. Used for whitehat response — if a bot starts
// farming the pool, admin excludes them immediately; payout still proceeds
// at the next cooldown window with the cheater neutralized.
async function handleAdminJackpotExclude(req: Request, env: Env): Promise<Response> {
  const gate = requireAdmin(req, env);
  if (gate) return gate;
  const body = (await req.json().catch(() => ({}))) as { key?: string };
  if (!body.key || !body.key.startsWith("dlf_")) {
    return error(400, "key (dlf_…) required");
  }
  const id = env.JACKPOT.idFromName("global");
  const resp = await env.JACKPOT.get(id).fetch("https://jackpot/exclude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: body.key }),
  });
  const data = await resp.json().catch(() => ({}));
  return json(data, { status: resp.status });
}

async function handleAdminCreateKey(req: Request, env: Env): Promise<Response> {
  const gate = requireAdmin(req, env);
  if (gate) return gate;
  const body = (await req.json().catch(() => ({}))) as any;
  const balance_mcents = Math.max(0, Number(body.balance_mcents) || 0);
  const validScopes: Scope[] = ["crawl", "gather", "label", "train", "read", "all"];
  const scopes: Scope[] | undefined = Array.isArray(body.scopes)
    ? body.scopes.filter((s: any): s is Scope => validScopes.includes(s))
    : undefined;
  const key = await generateApiKey();
  const rec: KeyRecord = {
    balance_mcents,
    xp: 0,
    created_at: Date.now(),
    last_active_at: Date.now(),
    label: String(body.label || "").slice(0, 80),
    display_name: body.display_name ? String(body.display_name).slice(0, 32) : undefined,
    name_set_at: body.display_name ? Date.now() : undefined,
    calls_total: 0,
    calls_by_type: {},
    badges: [],
    scopes,
  };
  await writeKey(env, key, rec);
  return json({ ok: true, key, ...profileView(rec, key) });
}

async function handleAdminTopup(req: Request, env: Env, key: string): Promise<Response> {
  const gate = requireAdmin(req, env);
  if (gate) return gate;
  const body = (await req.json().catch(() => ({}))) as any;
  const amount = Math.max(0, Number(body.amount_mcents) || 0);
  if (amount <= 0) return error(400, "amount_mcents required (> 0)");
  const rec = await readKey(env, key);
  if (!rec) return error(404, "api key not found");
  const updated: KeyRecord = { ...rec, balance_mcents: rec.balance_mcents + amount };
  await writeKey(env, key, updated);
  return json({ ok: true, key, balance_mcents: updated.balance_mcents });
}

// Admin-only: set tier + optional tier_expires_at / sub_started_at on a key.
// Used to comp customers, reset failed x402 settlements, or mint synthetic
// Pro/Dedicated keys for QA (e.g. testing the jackpot rank multiplier).
// Does NOT go through x402 — bypasses payment by design (admin-only).
async function handleAdminSetTier(req: Request, env: Env, key: string): Promise<Response> {
  const gate = requireAdmin(req, env);
  if (gate) return gate;
  const body = (await req.json().catch(() => ({}))) as any;
  const validTiers: Tier[] = ["free", "pro", "dedicated", "enterprise"];
  const tier = body.tier as Tier;
  if (!validTiers.includes(tier)) {
    return error(400, "tier must be one of free|pro|dedicated|enterprise", { got: body.tier });
  }
  const rec = await readKey(env, key);
  if (!rec) return error(404, "api key not found");

  const now = Date.now();
  const defaultDuration = tier === "free" ? 0 : 30 * 86400_000;
  const expiresAt = body.tier_expires_at != null
    ? Number(body.tier_expires_at)
    : tier === "free" ? undefined : now + defaultDuration;
  const subStartedAt = body.sub_started_at != null
    ? Number(body.sub_started_at)
    : rec.sub_started_at || (tier !== "free" ? now : undefined);

  const updated: KeyRecord = {
    ...rec,
    tier,
    tier_expires_at: expiresAt,
    tier_quota: tier === "free" ? undefined : { ...TIER_DEFS[tier].quota },
    sub_started_at: subStartedAt,
  };
  await writeKey(env, key, updated);
  return json({
    ok: true,
    key,
    tier,
    tier_expires_at: expiresAt,
    sub_started_at: subStartedAt,
    tier_quota: updated.tier_quota,
  });
}

async function handleAdminGetKey(req: Request, env: Env, key: string): Promise<Response> {
  const gate = requireAdmin(req, env);
  if (gate) return gate;
  const rec = await readKey(env, key);
  if (!rec) return error(404, "api key not found");
  return json({ ok: true, key, ...profileView(rec, key) });
}

// ---- Labeling Marketplace (jobs) -----------------------------------------
//
// Two-sided marketplace: buyers post labeling jobs; agents submit labels to
// earn rewards. Buyer pays from their dlf_ balance. Platform takes a fee on
// every labeled image. A slice of the fee carves off into the jackpot pool.
//
// Flow:
//   1. Buyer POST /v1/jobs with {query, image_urls[], community_slug}. Gateway
//      computes total cost = n_images × (reward + fee), deducts from buyer's
//      balance, stores the job.
//   2. Agent GET /v1/jobs?community=X&status=open to find work.
//   3. Agent POST /v1/jobs/:id/submit {image_url, annotations} — per-job DO
//      serializes: first valid submission per image_url wins, credits agent
//      reward, contributes to jackpot with tier-weighted logic.
//   4. Job auto-completes when every image has a label. Buyer can GET the
//      results + export.
//
// See ECONOMIC_MODEL.md for the full spec.

const JOB_REWARD_PER_IMAGE_MCENTS = 100;   // to agent ($0.001/image)
const JOB_FEE_PER_IMAGE_MCENTS = 30;       // to platform ($0.0003/image)
const JOB_JACKPOT_PER_IMAGE_MCENTS = 10;   // carved from fee ($0.0001/image)
const JOB_EXPIRY_MS = 7 * 86400_000;
const JOB_MAX_IMAGES = 50;
const JOB_MIN_IMAGES = 1;

type JobSubmission = {
  agent_key: string;
  agent_key_short: string;
  agent_name?: string;
  annotations: any[];
  n_detections: number;
  image_size?: number[];
  submitted_at: number;
};

type LabelingJob = {
  id: string;
  buyer_key: string;
  buyer_key_short: string;
  buyer_name?: string;
  community_slug: string;
  query: string;
  image_urls: string[];
  total_images: number;
  labels: Record<string, JobSubmission>;
  reward_per_image_mcents: number;
  fee_per_image_mcents: number;
  jackpot_per_image_mcents: number;
  total_paid_mcents: number;
  paid_out_mcents: number;
  fee_collected_mcents: number;
  jackpot_contributed_mcents: number;
  status: "open" | "completed" | "expired" | "rejected";
  created_at: number;
  completed_at?: number;
  expires_at: number;
};

function jobPricing(nImages: number) {
  return {
    reward_per_image_mcents: JOB_REWARD_PER_IMAGE_MCENTS,
    fee_per_image_mcents: JOB_FEE_PER_IMAGE_MCENTS,
    jackpot_per_image_mcents: JOB_JACKPOT_PER_IMAGE_MCENTS,
    total_paid_mcents: nImages * (JOB_REWARD_PER_IMAGE_MCENTS + JOB_FEE_PER_IMAGE_MCENTS),
  };
}

function sanitizeJobForPublic(j: LabelingJob): any {
  // Never return raw buyer or agent bearer tokens — only short prefixes.
  const labels: Record<string, any> = {};
  for (const [url, s] of Object.entries(j.labels)) {
    labels[url] = {
      agent_key_short: s.agent_key_short,
      agent_name: s.agent_name,
      n_detections: s.n_detections,
      image_size: s.image_size,
      submitted_at: s.submitted_at,
      // annotations available but redacted for now (could be large)
      annotations: s.annotations,
    };
  }
  // Whitehat M1: the old `reward / fee / jackpot` triple looked additive
  // but jackpot is a subdivision of fee. Now we emit a structured
  // `price_per_image` that makes the hierarchy explicit, alongside live
  // `accounting` totals for buyer reconciliation.
  const platform_net_per_image_mcents = j.fee_per_image_mcents - j.jackpot_per_image_mcents;
  return {
    id: j.id,
    buyer_key_short: j.buyer_key_short,
    buyer_name: j.buyer_name,
    community_slug: j.community_slug,
    query: j.query,
    image_urls: j.image_urls,
    total_images: j.total_images,
    labels_submitted: Object.keys(j.labels).length,
    labels_remaining: j.total_images - Object.keys(j.labels).length,
    labels,
    price_per_image: {
      buyer_pays_mcents: j.reward_per_image_mcents + j.fee_per_image_mcents,
      agent_reward_mcents: j.reward_per_image_mcents,
      platform_fee_mcents: j.fee_per_image_mcents,
      fee_breakdown: {
        platform_net_mcents: platform_net_per_image_mcents,
        jackpot_contribution_mcents: j.jackpot_per_image_mcents,
      },
      formula: "buyer_pays = agent_reward + platform_fee · jackpot_contribution ⊂ platform_fee",
    },
    // Legacy flat fields preserved for backwards compat with existing UI.
    // DO NOT add them up: buyer pays agent_reward + platform_fee only
    // (jackpot is carved from platform_fee, not added on top).
    reward_per_image_mcents: j.reward_per_image_mcents,
    fee_per_image_mcents: j.fee_per_image_mcents,
    jackpot_per_image_mcents: j.jackpot_per_image_mcents,
    total_paid_mcents: j.total_paid_mcents,
    accounting: {
      paid_out_to_agents_mcents: j.paid_out_mcents,
      fee_collected_mcents: j.fee_collected_mcents,
      jackpot_contributed_mcents: j.jackpot_contributed_mcents,
      platform_net_mcents: j.fee_collected_mcents - j.jackpot_contributed_mcents,
    },
    paid_out_mcents: j.paid_out_mcents, // deprecated alias
    status: j.status,
    created_at: j.created_at,
    completed_at: j.completed_at,
    expires_at: j.expires_at,
  };
}

async function handleJobCreate(req: Request, env: Env): Promise<Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) return error(401, "missing or malformed bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");

  const body = (await req.json().catch(() => null)) as any;
  if (!body) return error(400, "invalid JSON body", { note: "no charge applied" });

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const community_slug = String(body.community_slug || body.community || "").trim() || "wildlife";
  const raw_urls = Array.isArray(body.image_urls) ? body.image_urls : [];

  if (!query) return error(400, 'missing required field "query"', { note: "no charge applied" });
  if (raw_urls.length < JOB_MIN_IMAGES) {
    return error(400, `image_urls must contain at least ${JOB_MIN_IMAGES} URL`, { note: "no charge applied" });
  }
  if (raw_urls.length > JOB_MAX_IMAGES) {
    return error(400, `max ${JOB_MAX_IMAGES} images per job`, { note: "no charge applied" });
  }
  for (const u of raw_urls) {
    if (typeof u !== "string") {
      return error(400, "image_urls must be strings", { offending: u, note: "no charge applied" });
    }
    // Same SSRF-aware validator as /v1/label — whitehat round-3 C1 found
    // job create admitted file://, 169.254.169.254, javascript:, localhost,
    // data:. Batch validate every URL; reject entire job on first bad entry.
    const urlCheck = validateImageUrl(u);
    if (!urlCheck.ok) {
      return error(400, `invalid image_url: ${urlCheck.reason}`, {
        offending: u.slice(0, 120),
        note: "no charge applied",
      });
    }
  }
  // De-dup while preserving order
  const seen = new Set<string>();
  const image_urls = raw_urls.filter((u: string) => (seen.has(u) ? false : (seen.add(u), true)));

  const pricing = jobPricing(image_urls.length);

  // Deduct buyer's balance atomically via UserStateDO. If insufficient,
  // returns 402 with a pointer to top-up.
  const deductReply = await applyUserState(env, key, {
    op: "debit",
    amount_mcents: pricing.total_paid_mcents,
    reason: "job_create",
  } as any);
  if (!deductReply.ok) {
    const e = deductReply as UserStateError;
    return error(e.status, e.error, {
      ...e.extra,
      note: "top up your key to post this job",
      required_mcents: pricing.total_paid_mcents,
    });
  }

  const jobId = "job_" + Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const job: LabelingJob = {
    id: jobId,
    buyer_key: key,
    buyer_key_short: key.slice(0, 10) + "…",
    buyer_name: rec.display_name,
    community_slug,
    query,
    image_urls,
    total_images: image_urls.length,
    labels: {},
    ...pricing,
    paid_out_mcents: 0,
    fee_collected_mcents: 0,
    jackpot_contributed_mcents: 0,
    status: "open",
    created_at: now,
    expires_at: now + JOB_EXPIRY_MS,
  };
  await env.KEYS.put(`job:${jobId}`, JSON.stringify(job));

  return json({
    ok: true,
    job: sanitizeJobForPublic(job),
    balance_mcents: (deductReply as any).record.balance_mcents,
  });
}

async function handleJobsList(req: Request, env: Env, url: URL): Promise<Response> {
  const community = url.searchParams.get("community");
  const status = (url.searchParams.get("status") || "open") as LabelingJob["status"];
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const mine = url.searchParams.get("mine") === "1";
  const bearer = mine ? extractBearer(req) : null;

  const listing = await env.KEYS.list({ prefix: "job:", limit: 500 });
  const jobs: LabelingJob[] = [];
  for (const k of listing.keys) {
    const raw = await env.KEYS.get(k.name);
    if (!raw) continue;
    const j = JSON.parse(raw) as LabelingJob;
    if (status && j.status !== status) continue;
    if (community && j.community_slug !== community) continue;
    if (mine && bearer && j.buyer_key !== bearer) continue;
    jobs.push(j);
  }
  jobs.sort((a, b) => b.created_at - a.created_at);
  return json({
    ok: true,
    scope: mine ? "mine" : "public",
    total: jobs.length,
    jobs: jobs.slice(0, limit).map(sanitizeJobForPublic),
  });
}

async function handleJobGet(env: Env, jobId: string): Promise<Response> {
  const raw = await env.KEYS.get(`job:${jobId}`);
  if (!raw) return error(404, "job not found", { job_id: jobId });
  return json({ ok: true, job: sanitizeJobForPublic(JSON.parse(raw) as LabelingJob) });
}

async function handleJobSubmit(req: Request, env: Env, jobId: string): Promise<Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) return error(401, "missing or malformed bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");

  const body = (await req.json().catch(() => null)) as any;
  if (!body) return error(400, "invalid JSON body");
  const image_url = String(body.image_url || body.path || "");
  if (!image_url) return error(400, 'missing required field "image_url"');
  const urlCheck = validateImageUrl(image_url);
  if (!urlCheck.ok) return error(400, `invalid image_url: ${urlCheck.reason}`);

  if (!Array.isArray(body.annotations) || body.annotations.length === 0) {
    return error(400, "annotations[] required (non-empty)", {
      hint: "label the image using /v1/label first, then submit the returned annotations here",
    });
  }
  // Whitehat round-3 H3: annotations were stored + served verbatim.
  // Stored-XSS via <script>, score overflow (999999), and injected fields
  // (admin:true) were all accepted. Validate strict shape and strip
  // everything outside the known schema.
  const cleanAnnotations: any[] = [];
  for (const a of body.annotations) {
    if (!a || typeof a !== "object") {
      return error(400, "each annotation must be an object");
    }
    const bbox = a.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n: any) => typeof n === "number" && isFinite(n))) {
      return error(400, "annotation.bbox must be an array of 4 finite numbers [x, y, w_or_x2, h_or_y2]");
    }
    let category = a.category;
    if (typeof category !== "string") {
      return error(400, "annotation.category must be a string");
    }
    // Strip HTML-reactive characters from category to neutralize stored-XSS.
    // Buyer UIs that render category as innerText are unaffected; UIs that
    // accidentally render as innerHTML are also safe.
    category = category.replace(/[<>"'`]/g, "").slice(0, 80);
    let score = Number(a.score);
    if (!isFinite(score)) score = 0;
    // Clamp to [0, 1]. whitehat round-3 saw score:999999 pollute downstream.
    score = Math.max(0, Math.min(1, score));
    cleanAnnotations.push({ bbox, category, score });
  }
  const annotations = cleanAnnotations;

  // Atomic accept via per-job DO. JobsDO is keyed by jobId so every write
  // for one job serializes — prevents two agents both winning the same image.
  const doId = env.JOBS.idFromName(jobId);
  const resp = await env.JOBS.get(doId).fetch("https://jobs/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      image_url,
      annotations,
      image_size: body.image_size,
      agent_key: key,
      agent_key_short: key.slice(0, 10) + "…",
      agent_name: rec.display_name,
    }),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!data?.accepted) {
    return json(data, { status: resp.status });
  }

  // Credit the agent's balance for the reward
  const reward = Number(data.reward_mcents) || 0;
  const creditReply = await applyUserState(env, key, {
    op: "credit",
    amount_mcents: reward,
  });
  const newBalance = creditReply.ok
    ? (creditReply as CreditResult).record.balance_mcents
    : rec.balance_mcents + reward;

  // Trust +1 for productive job submission (mirrors /v1/label trust gain).
  await applyUserState(env, key, { op: "adjust_trust", delta: 1 }).catch(() => {});

  // Jackpot contribution on the agent's behalf — same tier-weighted logic as
  // a productive /v1/label call. Uses the job's jackpot_per_image (not the
  // label flat 50/25). Sub tenure gate still applies.
  try {
    const tier = activeTier(rec);
    const baseWeight = JACKPOT_WEIGHT_BY_TIER[tier] ?? 1.0;
    const tenureOk = tier === "free" ||
      (rec.sub_started_at && Date.now() - rec.sub_started_at >= JACKPOT_SUB_TENURE_MS);
    const trust = rec.trust_score ?? 0;
    const rankEligible = trust >= JACKPOT_MIN_TRUST_SCORE;
    const weight = rankEligible ? (tenureOk ? baseWeight : 1.0) : 0;
    const id = env.JACKPOT.idFromName("global");
    await env.JACKPOT.get(id).fetch("https://jackpot/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        display_name: rec.display_name || "anonymous",
        mcents: Number(data.jackpot_mcents) || JOB_JACKPOT_PER_IMAGE_MCENTS,
        weight,
        tier,
      }),
    });
  } catch {
    // Never block a successful submission on jackpot bookkeeping.
  }

  return json({
    ok: true,
    job_id: jobId,
    image_url,
    accepted: true,
    reward_mcents: reward,
    jackpot_contribution_mcents: data.jackpot_mcents,
    balance_mcents: newBalance,
    remaining_images: data.remaining_images,
    job_status: data.job_status,
  });
}

// ---- Router -----------------------------------------------------------------

// ---- Durable Object: UserStateDO ------------------------------------------
//
// Per-key DO (idFromName(key)). Serializes ALL balance / XP / calls_by_type
// mutations for a single API key via blockConcurrencyWhile — eliminating the
// KV last-write-wins race whitehat QA 2026-04-19 caught (5 parallel
// /v1/label calls debited once instead of five).
//
// KV remains the canonical record store; this DO is a per-key write gate.
// Pure reads (balance, profile, leaderboard) still hit KV directly.

type UserStateOp =
  | { op: "charge"; call_type: CallType; cost_mcents: number }
  | { op: "refund"; amount_mcents: number; now: number; rollback_call_type?: CallType }
  | { op: "activation_credit"; labels_required: number; bonus_mcents: number }
  | { op: "credit"; amount_mcents: number }
  | { op: "debit"; amount_mcents: number; reason?: string }
  | { op: "rollback"; amount_mcents: number; call_type: CallType }
  | { op: "adjust_trust"; delta: number };

type ChargeResult = {
  ok: true;
  record: KeyRecord;
  metered: boolean;
  xp_gained: number;
  quota_used: number;
  activity_push?: { action: CallType; xp_gained: number };
};
type RefundResult = { ok: true; record: KeyRecord; refunded: boolean };
type ActivationResult = { ok: true; record: KeyRecord; credited: number; labels_done: number };
type CreditResult = { ok: true; record: KeyRecord };
type RollbackResult = { ok: true; record: KeyRecord };
type UserStateError = { ok: false; status: number; error: string; extra?: Record<string, unknown> };
type UserStateReply = ChargeResult | RefundResult | ActivationResult | CreditResult | RollbackResult | UserStateError;

async function applyUserState(env: Env, key: string, op: UserStateOp): Promise<UserStateReply> {
  const id = env.USER_STATE.idFromName(key);
  const resp = await env.USER_STATE.get(id).fetch("https://user-state/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, op }),
  });
  return (await resp.json()) as UserStateReply;
}

export class UserStateDO {
  state: DurableObjectState;
  env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/apply") {
      return new Response("not found", { status: 404 });
    }
    const body = (await req.json()) as { key: string; op: UserStateOp };
    const key = body.key;
    const op = body.op;

    return await this.state.blockConcurrencyWhile(async () => {
      const raw = await this.env.KEYS.get(key);
      if (!raw) {
        return Response.json({ ok: false, status: 404, error: "invalid api key" } satisfies UserStateReply);
      }
      const rec = JSON.parse(raw) as KeyRecord;
      rec.calls_by_type ??= {};
      rec.badges ??= [];
      rec.xp ??= 0;
      rec.calls_total ??= 0;

      let reply: UserStateReply;
      let persist = true;

      switch (op.op) {
        case "charge": {
          const needed = SCOPE_FOR[op.call_type];
          if (!hasScope(rec, needed)) {
            reply = {
              ok: false, status: 403,
              error: `this key is not authorized for "${needed}"`,
              extra: { scopes: rec.scopes, required_scope: needed },
            };
            persist = false;
            break;
          }

          // Burst limit. State lives in the DO's OWN storage (not KV) for
          // strong consistency — otherwise N parallel charges all read the
          // same stale KV snapshot and the limiter never fires. DO storage
          // reads-your-own-writes within a single instance.
          const nowMs = Date.now();
          const savedBurst = (await this.state.storage.get<number[]>("burst_window")) || [];
          const burst = savedBurst.filter((t) => nowMs - t < BURST_WINDOW_MS);
          if (burst.length >= BURST_MAX_PER_WINDOW) {
            reply = {
              ok: false, status: 429,
              error: "rate limited",
              extra: {
                window_ms: BURST_WINDOW_MS,
                max_per_window: BURST_MAX_PER_WINDOW,
                hint: `max ${BURST_MAX_PER_WINDOW} paid calls per ${BURST_WINDOW_MS / 1000}s per key`,
              },
            };
            persist = false;
            break;
          }
          burst.push(nowMs);
          await this.state.storage.put("burst_window", burst);

          const tier = activeTier(rec);
          const tierDef = TIER_DEFS[tier];
          let effective_cost = op.cost_mcents;
          let quota_used = 0;
          if (tier !== "free") {
            if (tierDef.unmetered.includes(op.call_type)) {
              effective_cost = 0;
            } else if ((rec.tier_quota?.[op.call_type] ?? 0) > 0) {
              effective_cost = 0;
              quota_used = 1;
            }
          }
          if (rec.balance_mcents < effective_cost) {
            reply = {
              ok: false, status: 402, error: "insufficient balance",
              extra: {
                balance_mcents: rec.balance_mcents,
                required_mcents: effective_cost,
                tier,
                hint: tier === "free"
                  ? "ask admin to top up or subscribe"
                  : "quota exhausted this period; top up or upgrade",
              },
            };
            persist = false;
            break;
          }
          const xp_gained = XP_AWARD[op.call_type] || 0;
          const before_badges = new Set(rec.badges);
          if (quota_used && rec.tier_quota) {
            rec.tier_quota = {
              ...rec.tier_quota,
              [op.call_type]: Math.max(0, (rec.tier_quota[op.call_type] || 0) - 1),
            };
          }
          rec.balance_mcents -= effective_cost;
          rec.xp += xp_gained;
          rec.last_active_at = Date.now();
          rec.calls_total += 1;
          rec.calls_by_type = {
            ...rec.calls_by_type,
            [op.call_type]: (rec.calls_by_type[op.call_type] || 0) + 1,
          };
          for (const def of BADGE_DEFS) {
            if (!before_badges.has(def.id) && def.check(rec)) rec.badges.push(def.id);
          }
          reply = {
            ok: true, record: rec,
            metered: effective_cost > 0,
            xp_gained, quota_used,
            activity_push: xp_gained > 0 ? { action: op.call_type, xp_gained } : undefined,
          };
          break;
        }
        case "refund": {
          const recent = (rec.refunds_window || []).filter((t) => op.now - t < REFUND_WINDOW_MS);
          if (recent.length >= REFUND_MAX_PER_WINDOW) {
            reply = { ok: true, record: rec, refunded: false };
            persist = false;
            break;
          }
          recent.push(op.now);
          rec.refunds_window = recent;
          rec.balance_mcents += op.amount_mcents;
          if (op.rollback_call_type) {
            const ct = op.rollback_call_type;
            rec.xp = Math.max(0, rec.xp - (XP_AWARD[ct] || 0));
            rec.calls_total = Math.max(0, rec.calls_total - 1);
            const t = rec.calls_by_type[ct];
            if (typeof t === "number" && t > 0) rec.calls_by_type[ct] = t - 1;
          }
          reply = { ok: true, record: rec, refunded: true };
          break;
        }
        case "activation_credit": {
          if (rec.activation_bonus_claimed) {
            reply = { ok: true, record: rec, credited: 0, labels_done: rec.activation_labels_done || 0 };
            persist = false;
            break;
          }
          const done = (rec.activation_labels_done || 0) + 1;
          rec.activation_labels_done = done;
          let credited = 0;
          if (done >= op.labels_required) {
            rec.balance_mcents += op.bonus_mcents;
            rec.activation_bonus_claimed = true;
            credited = op.bonus_mcents;
          }
          reply = { ok: true, record: rec, credited, labels_done: done };
          break;
        }
        case "credit": {
          rec.balance_mcents += op.amount_mcents;
          reply = { ok: true, record: rec };
          break;
        }
        case "adjust_trust": {
          rec.trust_score = (rec.trust_score ?? 0) + Number(op.delta || 0);
          reply = { ok: true, record: rec };
          break;
        }
        case "debit": {
          const amt = Math.max(0, Number(op.amount_mcents) || 0);
          if (rec.balance_mcents < amt) {
            reply = {
              ok: false, status: 402, error: "insufficient balance",
              extra: {
                balance_mcents: rec.balance_mcents,
                required_mcents: amt,
                hint: "top up via admin or /v1/topup",
              },
            };
            persist = false;
            break;
          }
          rec.balance_mcents -= amt;
          reply = { ok: true, record: rec };
          break;
        }
        case "rollback": {
          rec.balance_mcents += op.amount_mcents;
          rec.xp = Math.max(0, rec.xp - (XP_AWARD[op.call_type] || 0));
          rec.calls_total = Math.max(0, rec.calls_total - 1);
          const t = rec.calls_by_type[op.call_type];
          if (typeof t === "number" && t > 0) rec.calls_by_type[op.call_type] = t - 1;
          reply = { ok: true, record: rec };
          break;
        }
      }

      if (persist && reply.ok) {
        await this.env.KEYS.put(key, JSON.stringify((reply as { record: KeyRecord }).record));
      }
      return Response.json(reply);
    });
  }
}

// ---- Durable Object: leaderboard + activity feed --------------------------
//
// Single global instance. All writes serialize through this DO's fetch
// handler, which gives us a race-free leaderboard + ring-buffer activity log.

export class LeaderboardDO {
  state: DurableObjectState;
  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/leaderboard") {
      const lb = (await this.state.storage.get<LeaderboardEntry[]>("lb")) || [];
      return Response.json(lb);
    }

    if (req.method === "GET" && path === "/activity") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      const feed = (await this.state.storage.get<ActivityEntry[]>("activity")) || [];
      return Response.json(feed.slice(0, limit));
    }

    if (req.method === "POST" && path === "/record") {
      const body = (await req.json()) as { activity: ActivityEntry; leaderboard: LeaderboardEntry };

      // 1) Update leaderboard
      const lb = (await this.state.storage.get<LeaderboardEntry[]>("lb")) || [];
      const idx = lb.findIndex((e) => e.key_short === body.leaderboard.key_short);
      if (idx >= 0) lb[idx] = body.leaderboard;
      else lb.push(body.leaderboard);
      lb.sort((a, b) => b.xp - a.xp);
      await this.state.storage.put("lb", lb.slice(0, LEADERBOARD_SIZE));

      // 2) Push activity entry (newest first, ring-buffered)
      const feed = (await this.state.storage.get<ActivityEntry[]>("activity")) || [];
      feed.unshift(body.activity);
      await this.state.storage.put("activity", feed.slice(0, ACTIVITY_FEED_SIZE));

      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }
}

// ---- Durable Object: Label Jackpot -----------------------------------------
//
// Single global instance (idFromName("global")). Holds:
//   pool             total mcents awaiting payout
//   counts           { key -> { display_name, label_count (weighted), tier } }
//   period_start     unix ms the current period opened
//   last_payout_at   unix ms of last admin payout (for cooldown gate)
//   excluded         Set<key> zeroed by admin this period (whitehat response)
//   history          last N payouts (for /v1/jackpot/history, admin-only view)
//
// Routes (internal only — never exposed directly):
//   POST /contribute  { key, display_name, mcents, weight, tier }  — handleLabel
//   POST /exclude     { key }                                      — admin-gated
//   GET  /status                                                   — public view
//   POST /payout                                                   — admin-gated,
//     distributes main pool 50/30/20 to top-3 by weighted count AND 10% sub-pool
//     60/40 to top-2 subscribers. Refuses if cooldown not elapsed.
//
// Payouts are atomic: this DO serializes all pool + counter writes, so two
// admins racing payout requests won't double-spend.

type JackpotCount = { display_name: string; label_count: number; tier: Tier };
type JackpotCounts = Record<string, JackpotCount>;
type JackpotPayoutWinner = {
  key_short: string;
  display_name: string;
  share_mcents: number;
  label_count: number;
  bucket: "main" | "sub";
  tier?: Tier;
};
type JackpotPayoutRecord = {
  at: number;
  pool_mcents: number;
  main_pool_mcents: number;
  sub_pool_mcents: number;
  winners: JackpotPayoutWinner[];
};

// ---- Durable Object: Jobs (marketplace labeling jobs) --------------------
//
// Per-job instance keyed by jobId (idFromName). Serializes writes on a
// single job so two agents submitting for the same image never both win —
// first valid submission per image_url takes the reward.
//
// Read paths (list, detail) hit KV directly for speed; the DO is write-only.
// The worker (handleJobSubmit) delegates the atomic decision to /submit and
// handles the downstream balance credit + jackpot contribution after the DO
// returns accepted: true.

export class JobsDO {
  state: DurableObjectState;
  env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/submit") {
      return new Response("not found", { status: 404 });
    }
    return await this.state.blockConcurrencyWhile(async () => {
      const body = (await req.json()) as {
        job_id: string;
        image_url: string;
        annotations: any[];
        image_size?: number[];
        agent_key: string;
        agent_key_short: string;
        agent_name?: string;
      };
      const raw = await this.env.KEYS.get(`job:${body.job_id}`);
      if (!raw) {
        return Response.json({ ok: false, accepted: false, error: "job not found" }, { status: 404 });
      }
      const job: LabelingJob = JSON.parse(raw);

      if (job.status !== "open") {
        return Response.json({ ok: false, accepted: false, error: `job is ${job.status}` }, { status: 409 });
      }
      if (job.expires_at && job.expires_at < Date.now()) {
        job.status = "expired";
        await this.env.KEYS.put(`job:${body.job_id}`, JSON.stringify(job));
        return Response.json({ ok: false, accepted: false, error: "job expired" }, { status: 410 });
      }
      if (!job.image_urls.includes(body.image_url)) {
        return Response.json({ ok: false, accepted: false, error: "image_url is not part of this job" }, { status: 400 });
      }
      if (job.labels[body.image_url]) {
        return Response.json({
          ok: false, accepted: false,
          error: "another agent already submitted a label for this image (first-wins)",
          existing_agent: job.labels[body.image_url].agent_key_short,
        }, { status: 409 });
      }
      if (body.agent_key === job.buyer_key) {
        return Response.json({ ok: false, accepted: false, error: "buyer cannot submit labels on their own job" }, { status: 403 });
      }

      // Accept the submission.
      job.labels[body.image_url] = {
        agent_key: body.agent_key,
        agent_key_short: body.agent_key_short,
        agent_name: body.agent_name,
        annotations: body.annotations,
        n_detections: Array.isArray(body.annotations) ? body.annotations.length : 0,
        image_size: body.image_size,
        submitted_at: Date.now(),
      };
      job.paid_out_mcents += job.reward_per_image_mcents;
      job.fee_collected_mcents += job.fee_per_image_mcents;
      job.jackpot_contributed_mcents += job.jackpot_per_image_mcents;

      const completed = Object.keys(job.labels).length;
      const remaining = job.total_images - completed;
      if (remaining === 0) {
        job.status = "completed";
        job.completed_at = Date.now();
      }
      await this.env.KEYS.put(`job:${body.job_id}`, JSON.stringify(job));

      return Response.json({
        ok: true,
        accepted: true,
        reward_mcents: job.reward_per_image_mcents,
        jackpot_mcents: job.jackpot_per_image_mcents,
        remaining_images: remaining,
        job_status: job.status,
      });
    });
  }
}

export class JackpotDO {
  state: DurableObjectState;
  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path === "/contribute") {
      return await this.state.blockConcurrencyWhile(async () => {
        const body = (await req.json()) as {
          key: string;
          display_name?: string;
          mcents: number;
          weight?: number;
          tier?: Tier;
        };
        const weight = Math.max(0, Number(body.weight) || 1.0);
        const tier: Tier = (body.tier as Tier) || "free";
        const mcents = Math.max(0, Number(body.mcents) || 0);

        const counts = (await this.state.storage.get<JackpotCounts>("counts")) || {};
        const excluded = new Set(
          (await this.state.storage.get<string[]>("excluded")) || [],
        );

        // Anti-farm: ONE cap protects both rank AND platform margin. Once a
        // key's weighted label_count hits JACKPOT_WEIGHT_CAP_PER_PERIOD, we
        // stop accepting both rank advancement AND pool contributions from
        // it. This prevents a single Dedicated whale at 200k labels draining
        // $50 from platform margin. Capping at 2000 weighted points means
        // max contribution per key per period ≈ $1 (Free) / $0.33 (Pro) /
        // $0.25 (Dedicated). Real production users never hit this; grinders
        // trying to farm prizes hit it quickly.
        const existing = counts[body.key] || {
          display_name: body.display_name || "anonymous",
          label_count: 0,
          tier,
        };
        const atCap = existing.label_count >= JACKPOT_WEIGHT_CAP_PER_PERIOD;
        const isExcluded = excluded.has(body.key);

        // Pool only grows when the contribution is admitted (not at cap, not
        // excluded). Zero-sum across users; platform margin bounded.
        if (!atCap && !isExcluded) {
          const pool = (await this.state.storage.get<number>("pool")) || 0;
          await this.state.storage.put("pool", pool + mcents);

          counts[body.key] = {
            display_name: body.display_name || existing.display_name,
            // Track the latest tier we saw — if a key upgrades mid-period,
            // sub-pool eligibility at payout time reflects current tier.
            tier: tier !== "free" ? tier : existing.tier,
            label_count: Math.min(
              existing.label_count + weight,
              JACKPOT_WEIGHT_CAP_PER_PERIOD,
            ),
          };
          await this.state.storage.put("counts", counts);
        }

        if (!(await this.state.storage.get<number>("period_start"))) {
          await this.state.storage.put("period_start", Date.now());
        }
        return Response.json({ ok: true, admitted: !atCap && !isExcluded, at_cap: atCap });
      });
    }

    if (req.method === "POST" && path === "/exclude") {
      // Admin-only upstream (gateway router checks X-Admin-Key before calling).
      return await this.state.blockConcurrencyWhile(async () => {
        const body = (await req.json()) as { key: string };
        if (!body.key) return Response.json({ ok: false, error: "key required" }, { status: 400 });
        const counts = (await this.state.storage.get<JackpotCounts>("counts")) || {};
        const excluded = new Set(
          (await this.state.storage.get<string[]>("excluded")) || [],
        );
        excluded.add(body.key);
        if (counts[body.key]) {
          counts[body.key] = { ...counts[body.key], label_count: 0 };
        }
        await this.state.storage.put("counts", counts);
        await this.state.storage.put("excluded", Array.from(excluded));
        return Response.json({ ok: true, key_short: body.key.slice(0, 10) + "…" });
      });
    }

    if (req.method === "GET" && path === "/status") {
      const pool = (await this.state.storage.get<number>("pool")) || 0;
      const counts = (await this.state.storage.get<JackpotCounts>("counts")) || {};
      const period_start = (await this.state.storage.get<number>("period_start")) || 0;
      const last_payout_at = (await this.state.storage.get<number>("last_payout_at")) || 0;
      const history = (await this.state.storage.get<JackpotPayoutRecord[]>("history")) || [];

      // Filter internal test/debug keys from the public leaderboard so QA
      // artifacts don't leak operator patterns or crowd the display.
      // Keys whose display_name matches a reserved prefix are hidden. They
      // still accumulate state (so admin can see them with a debug view),
      // they just don't surface here.
      // Whitehat round-3 H5 + M3:
      //  - H5: Cyrillic "gdrаil" (U+0430) bypassed the ASCII startsWith.
      //    Fix: NFKC-normalize + fold common script confusables (Cyrillic,
      //    Greek, mathematical letters) to ASCII before comparing.
      //  - M3: burst-* prefix wasn't in the list. Add.
      const CONFUSABLES: Record<string, string> = {
        "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
        "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "г": "r",
        "Α": "A", "Β": "B", "Ε": "E", "Η": "H", "Ι": "I", "Κ": "K",
        "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y",
        "Χ": "X", "Ζ": "Z",
      };
      const foldToAscii = (s: string): string => {
        const norm = s.normalize("NFKC");
        let out = "";
        for (const ch of norm) {
          out += CONFUSABLES[ch] ?? ch;
        }
        return out;
      };
      const isInternalName = (n?: string) => {
        if (!n) return false;
        const s = foldToAscii(n).toLowerCase();
        return (
          s.startsWith("gdrail") ||
          s.startsWith("debug") ||
          s.startsWith("repro") ||
          s.startsWith("qa-") ||
          s.startsWith("whitehat-") ||
          s.startsWith("test-") ||
          s.startsWith("job-test-") ||
          s.startsWith("burst-") ||
          s.startsWith("round3-") ||
          s.includes("sink")
        );
      };
      const top = Object.entries(counts)
        .filter(([_, v]) => !isInternalName(v.display_name))
        .map(([key, v]) => ({
          key_short: key.slice(0, 10) + "…",
          display_name: v.display_name,
          label_count: v.label_count,
          tier: v.tier,
        }))
        .sort((a, b) => b.label_count - a.label_count)
        .slice(0, 20);
      const now = Date.now();
      const cooldownMs = Math.max(
        0,
        JACKPOT_PAYOUT_COOLDOWN_MS - (now - (last_payout_at || 0)),
      );

      // Jitter the public cooldown countdown by ±24h so grinders can't time
      // their last-hour pushes exactly. Server-side accounting remains
      // precise (JackpotDO.payout still enforces the real 7-day gate);
      // only the display is fuzzed.
      const JITTER_MS = 24 * 60 * 60 * 1000;
      const jitteredCooldown = cooldownMs > 0
        ? Math.max(0, cooldownMs + Math.floor((Math.random() - 0.5) * 2 * JITTER_MS))
        : 0;

      return Response.json({
        pool_mcents: pool,
        pool_usd: (pool / 100000).toFixed(2),
        period_start,
        // last_payout_at withheld from public response (whitehat M2: exact
        // time enabled timing attacks). Admins can read via DO directly.
        cooldown_ms_remaining: last_payout_at ? jitteredCooldown : 0,
        contributors: top.length,
        top_labelers: top,
        last_payout: history[0] || null,
      });
    }

    if (req.method === "POST" && path === "/payout") {
      return await this.state.blockConcurrencyWhile(async () => {
        const now = Date.now();
        const last_payout_at =
          (await this.state.storage.get<number>("last_payout_at")) || 0;
        if (last_payout_at && now - last_payout_at < JACKPOT_PAYOUT_COOLDOWN_MS) {
          return Response.json(
            {
              ok: false,
              error: "payout cooldown active",
              cooldown_ms_remaining:
                JACKPOT_PAYOUT_COOLDOWN_MS - (now - last_payout_at),
              last_payout_at,
            },
            { status: 429 },
          );
        }

        const pool = (await this.state.storage.get<number>("pool")) || 0;
        const counts = (await this.state.storage.get<JackpotCounts>("counts")) || {};
        const ranked = Object.entries(counts)
          .filter(([_, v]) => v.label_count > 0)
          .sort((a, b) => b[1].label_count - a[1].label_count);

        // Carve sub-pool first. If no subscribers ranked, roll the sub-pool
        // fraction into main_pool instead of losing it.
        // Whitehat round-3 H4: `v.tier !== "free"` treated undefined (pre-
        // tier-tracking Gemma agents) as truthy → Free agents leaked into
        // the subscriber-only 10% carveout. Default undefined to "free".
        const subRanked = ranked.filter(([_, v]) => (v.tier || "free") !== "free");
        const sub_pool_target = Math.floor(pool * JACKPOT_SUB_POOL_FRACTION);
        const sub_pool = subRanked.length > 0 ? sub_pool_target : 0;
        const main_pool = pool - sub_pool;

        const winners: (JackpotPayoutWinner & { key: string })[] = [];
        let distributed = 0;

        // Main pool: existing 50/30/20 on top-3 by weighted count.
        for (let i = 0; i < Math.min(JACKPOT_PAYOUT_SPLITS.length, ranked.length); i++) {
          const [key, info] = ranked[i];
          const share = Math.floor(main_pool * JACKPOT_PAYOUT_SPLITS[i]);
          winners.push({
            key,
            display_name: info.display_name,
            share_mcents: share,
            label_count: info.label_count,
            bucket: "main",
            tier: info.tier,
            key_short: key.slice(0, 10) + "…",
          });
          distributed += share;
        }

        // Sub-pool: 60/40 on top-2 subscribers. Can overlap with main
        // winners — a Pro in top-3 wins from both buckets.
        for (let i = 0; i < Math.min(JACKPOT_SUB_POOL_SPLITS.length, subRanked.length); i++) {
          const [key, info] = subRanked[i];
          const share = Math.floor(sub_pool * JACKPOT_SUB_POOL_SPLITS[i]);
          winners.push({
            key,
            display_name: info.display_name,
            share_mcents: share,
            label_count: info.label_count,
            bucket: "sub",
            tier: info.tier,
            key_short: key.slice(0, 10) + "…",
          });
          distributed += share;
        }

        const remainder = Math.max(0, pool - distributed);
        const history =
          (await this.state.storage.get<JackpotPayoutRecord[]>("history")) || [];
        history.unshift({
          at: now,
          pool_mcents: pool,
          main_pool_mcents: main_pool,
          sub_pool_mcents: sub_pool,
          winners: winners.map((w) => ({
            key_short: w.key_short,
            display_name: w.display_name,
            share_mcents: w.share_mcents,
            label_count: w.label_count,
            bucket: w.bucket,
            tier: w.tier,
          })),
        });
        await this.state.storage.put("history", history.slice(0, 20));
        await this.state.storage.put("pool", remainder);
        await this.state.storage.put("counts", {});
        await this.state.storage.put("excluded", []);
        await this.state.storage.put("period_start", now);
        await this.state.storage.put("last_payout_at", now);

        return Response.json({
          ok: true,
          pool_paid: pool,
          main_pool,
          sub_pool,
          distributed,
          remainder,
          winners,
        });
      });
    }

    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/$/, "") || "/";

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Admin-Key",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Refuse any request that pastes a bearer-looking secret into a query
    // string. Whitehat round-3 H2 found the round-2 filter was ASCII-exact +
    // name-narrow (?KEY=, ?Key=, ?api-key=, ?apikey=, ?bearer= all bypassed).
    // Now: iterate ALL params, case-insensitive match against a broader list.
    const SECRET_PARAM_NAMES = new Set([
      "key", "api_key", "api-key", "apikey",
      "token", "access_token", "accesstoken",
      "auth", "authorization",
      "bearer", "secret",
    ]);
    for (const [k, v] of url.searchParams) {
      if (SECRET_PARAM_NAMES.has(k.toLowerCase()) && v.startsWith("dlf_") && v.length > 20) {
        return json({
          ok: false,
          error: `never pass an API key in the "${k}" query string — use Authorization: Bearer <key> header instead`,
          hint: "query strings land in CDN logs, browser history, and referrer headers. rotate this key now.",
        }, { status: 400 });
      }
    }

    try {
      // Agent Readiness / well-known discovery — advertise that this origin
      // speaks x402 and exposes paid tool calls. Helps bots + rankers find us
      // without burning a gather call. Scanners (like CF's Agent Readiness
      // probe) issue HEAD before GET, so both methods must return the same
      // metadata.
      const isReadOrHead = req.method === "GET" || req.method === "HEAD";
      if (p === "/" && isReadOrHead) return maybeHead(req, await handleRootLanding(req));
      if (p === "/sitemap.xml" && isReadOrHead) return maybeHead(req, await handleSitemap());
      if (p === "/robots.txt" && isReadOrHead) return maybeHead(req, await handleRobots());
      if (p === "/llms.txt" && isReadOrHead) return maybeHead(req, await handleLlmsTxt());
      if (p === "/.well-known/api-catalog" && isReadOrHead) return maybeHead(req, await handleApiCatalog());
      if (p === "/.well-known/mcp.json" && isReadOrHead) return maybeHead(req, await handleMcpManifest());
      if (p === "/.well-known/agent-skills/index.json" && isReadOrHead) return maybeHead(req, await handleAgentSkills());

      if (p === "/mcp") return handleMcp(req, env);

      if (p === "/v1/health" && req.method === "GET") return handleHealth();
      if (p === "/v1/pricing" && req.method === "GET") return handlePricing();
      if (p === "/v1/leaderboard" && req.method === "GET") return handleLeaderboard(env);
      if (p === "/v1/activity" && req.method === "GET") return handleActivity(req, env, url);
      if (p === "/v1/balance" && req.method === "GET") return handleBalance(req, env);
      if (p === "/v1/profile" && req.method === "GET") return handleProfile(req, env);
      if (p === "/v1/profile/name" && req.method === "POST") return handleSetName(req, env);

      // Emergency brake — kills all paid endpoints at once. Free reads
      // (health, pricing, jackpot, leaderboard, activity, profile, tier,
      // balance, llms.txt, discovery) stay up so ops can still diagnose.
      // Set via `wrangler secret put GATEWAY_EMERGENCY_SHUTDOWN` = "1".
      // Trim to tolerate trailing newlines from `echo | wrangler secret put`.
      const shutdownOn = (env.GATEWAY_EMERGENCY_SHUTDOWN ?? "").trim() === "1";
      const isPaidPath =
        (p === "/v1/crawl" && req.method === "POST") ||
        (p === "/v1/gather" && req.method === "POST") ||
        (p === "/v1/label" && req.method === "POST") ||
        (p === "/v1/train-yolo/start" && req.method === "POST") ||
        (p === "/v1/signup" && req.method === "POST") ||
        (p === "/v1/subscribe" && req.method === "POST") ||
        (p === "/v1/jobs" && req.method === "POST") ||
        /^\/v1\/predict\//.test(p) ||
        /^\/v1\/jobs\/job_[a-f0-9]+\/submit$/.test(p);
      if (shutdownOn && isPaidPath) {
        return json({
          ok: false,
          error: "gateway is temporarily paused for maintenance; paid endpoints offline",
          status: "emergency_shutdown",
          retry_after_seconds: 300,
        }, { status: 503, headers: { "Retry-After": "300" } });
      }

      if (p === "/v1/crawl" && req.method === "POST") return handleCrawl(req, env);
      if (p === "/v1/gather" && req.method === "POST") return handleGather(req, env);
      if (p === "/v1/label" && req.method === "POST") return handleLabel(req, env);
      if (p === "/v1/upload" && req.method === "POST") return handleUpload(req, env);
      if (p === "/v1/my-uploads" && req.method === "GET") return handleMyUploads(req, env);
      if (p === "/v1/my-models" && req.method === "GET") return handleMyModels(req, env);

      if (p === "/v1/train-yolo/start" && req.method === "POST") return handleTrainStart(req, env);

      const statusMatch = p.match(/^\/v1\/train-yolo\/status\/([a-zA-Z0-9_\-]+)$/);
      if (statusMatch && req.method === "GET") return handleTrainStatus(req, env, statusMatch[1]);

      const predictMatch = p.match(/^\/v1\/predict\/([a-zA-Z0-9_\-]+)$/);
      if (predictMatch && req.method === "POST") return handlePredict(req, env, predictMatch[1]);

      if (p === "/v1/marketplace" && req.method === "GET") return handleMarketplace(env, url);
      const modelGet = p.match(/^\/v1\/models\/([a-zA-Z0-9_\-]+)$/);
      if (modelGet && req.method === "GET") return handleModelGet(env, modelGet[1]);
      const modelPub = p.match(/^\/v1\/models\/([a-zA-Z0-9_\-]+)\/publish$/);
      if (modelPub && req.method === "POST") return handleModelPublish(req, env, modelPub[1]);
      const modelUnp = p.match(/^\/v1\/models\/([a-zA-Z0-9_\-]+)\/unpublish$/);
      if (modelUnp && req.method === "POST") return handleModelUnpublish(req, env, modelUnp[1]);

      const weightsMatch = p.match(/^\/v1\/train-yolo\/weights\/([a-zA-Z0-9_\-]+)$/);
      if (weightsMatch && req.method === "GET") return handleTrainWeights(req, env, weightsMatch[1]);

      if (p === "/v1/signup" && req.method === "POST") return handleSignup(req, env);

      if (p === "/v1/subscribe" && req.method === "POST") return handleSubscribe(req, env);
      if (p === "/v1/tier" && req.method === "GET") return handleTierStatus(req, env);

      // Public jackpot status. Payout route is admin-only, below.
      if (p === "/v1/jackpot" && req.method === "GET") return handleJackpotStatus(req, env);

      // ---- Labeling-job marketplace ----
      if (p === "/v1/jobs" && req.method === "POST") return handleJobCreate(req, env);
      if (p === "/v1/jobs" && req.method === "GET") return handleJobsList(req, env, url);
      const jobGetMatch = p.match(/^\/v1\/jobs\/(job_[a-f0-9]+)$/);
      if (jobGetMatch && req.method === "GET") return handleJobGet(env, jobGetMatch[1]);
      const jobSubmitMatch = p.match(/^\/v1\/jobs\/(job_[a-f0-9]+)\/submit$/);
      if (jobSubmitMatch && req.method === "POST") return handleJobSubmit(req, env, jobSubmitMatch[1]);

      if (p === "/v1/admin/keys" && req.method === "POST") return handleAdminCreateKey(req, env);
      if (p === "/v1/admin/jackpot/payout" && req.method === "POST") return handleAdminJackpotPayout(req, env);
      if (p === "/v1/admin/jackpot/exclude" && req.method === "POST") return handleAdminJackpotExclude(req, env);

      const topupMatch = p.match(/^\/v1\/admin\/keys\/(dlf_[a-f0-9]+)\/topup$/);
      if (topupMatch && req.method === "POST") return handleAdminTopup(req, env, topupMatch[1]);

      const setTierMatch = p.match(/^\/v1\/admin\/keys\/(dlf_[a-f0-9]+)\/set-tier$/);
      if (setTierMatch && req.method === "POST") return handleAdminSetTier(req, env, setTierMatch[1]);

      const getKeyMatch = p.match(/^\/v1\/admin\/keys\/(dlf_[a-f0-9]+)$/);
      if (getKeyMatch && req.method === "GET") return handleAdminGetKey(req, env, getKeyMatch[1]);

      return error(404, "not found");
    } catch (e: any) {
      return error(500, e?.message || "internal error");
    }
  },

  // Scheduled: jackpot payout handler. Currently DORMANT — no cron
  // trigger is wired in wrangler.toml, so this never fires in prod.
  // Kept here so enabling the daily payout later is a one-line
  // wrangler.toml change (uncomment the `[triggers]` block) plus
  // dropping JACKPOT_PAYOUT_COOLDOWN_MS to 23h.
  //
  // When enabled: invokes the JackpotDO directly via its DO binding —
  // no HTTP surface, no network, no admin token in a URL. The DO's
  // /payout handler enforces its own cooldown gate so a manual admin
  // trigger earlier in the window causes this scheduled run to
  // short-circuit, not double-pay.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const id = env.JACKPOT.idFromName("global");
        const resp = await env.JACKPOT.get(id).fetch("https://jackpot/payout", {
          method: "POST",
        });
        const body: any = await resp.json().catch(() => ({}));
        const summary = body?.ok
          ? `paid=${body.distributed || 0}mc winners=${(body.winners || []).length}`
          : `skip: ${body?.error || `status ${resp.status}`}`;
        console.log(`[scheduled ${event.cron}] jackpot payout: ${summary}`);
      } catch (e: any) {
        console.log(`[scheduled ${event.cron}] jackpot payout threw: ${e?.message || e}`);
      }
    })());
  },
};
