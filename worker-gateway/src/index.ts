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
 */

export interface Env {
  KEYS: KVNamespace;
  LEADERBOARD: DurableObjectNamespace;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  DLF_VERCEL_BASE_URL: string;
  ADMIN_KEY: string;
}

type CallType = "crawl" | "gather" | "label" | "train" | "status" | "weights";

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
};

// ---- Pricing (mcents) -------------------------------------------------------

const PRICE_MCENTS = {
  crawl_per_page: 50,     // $0.0005 / page
  gather: 100,            // $0.001 / call
  label_per_image: 200,   // $0.002 / image
  train_yolo: 2000,       // $0.02 / job
} as const;

// XP awards
const XP_AWARD: Record<CallType, number> = {
  crawl: 5,
  gather: 10,
  label: 20,
  train: 100,
  status: 0,
  weights: 0,
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
): Promise<{ ok: true; record: KeyRecord; key: string } | Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) return error(401, "missing or malformed bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");

  if (rec.balance_mcents < cost_mcents) {
    return error(402, "insufficient balance", {
      balance_mcents: rec.balance_mcents,
      required_mcents: cost_mcents,
      hint: "ask admin to top up",
    });
  }

  // Update record
  const xp_gained = XP_AWARD[call_type] || 0;
  const before_badges = new Set(rec.badges);
  const updated: KeyRecord = {
    ...rec,
    balance_mcents: rec.balance_mcents - cost_mcents,
    xp: rec.xp + xp_gained,
    last_active_at: Date.now(),
    calls_total: rec.calls_total + 1,
    calls_by_type: {
      ...rec.calls_by_type,
      [call_type]: (rec.calls_by_type[call_type] || 0) + 1,
    },
    badges: rec.badges,
  };
  // Badge check
  for (const def of BADGE_DEFS) {
    if (!before_badges.has(def.id) && def.check(updated)) {
      updated.badges.push(def.id);
    }
  }

  await writeKey(env, key, updated);
  if (xp_gained > 0) {
    // Serializes through the Durable Object — no race with other agents.
    await pushActivity(env, key, updated, call_type, xp_gained);
  }
  return { ok: true, record: updated, key };
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
    created_at: rec.created_at,
    last_active_at: rec.last_active_at,
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
    },
    xp_awards_per_call: XP_AWARD,
    leveling: "level = floor(sqrt(xp / 50))",
  });
}

async function handleLeaderboard(env: Env): Promise<Response> {
  const lb = await readLeaderboard(env);
  return json({ ok: true, leaderboard: lb });
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

async function handleActivity(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const activity = await readActivity(env, limit);
  return json({ ok: true, activity });
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
  const data = await cf.json();
  return json({
    ok: cf.ok,
    balance_mcents: auth.record.balance_mcents,
    xp: auth.record.xp,
    level: level(auth.record.xp),
    cloudflare: data,
  }, { status: cf.ok ? 200 : cf.status });
}

async function handleGather(req: Request, env: Env): Promise<Response> {
  const auth = await authAndCharge(req, env, PRICE_MCENTS.gather, "gather");
  if (auth instanceof Response) return auth;

  const body = await req.text();
  const resp = await fetch(`${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/gather`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
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

async function handleLabel(req: Request, env: Env): Promise<Response> {
  const auth = await authAndCharge(req, env, PRICE_MCENTS.label_per_image, "label");
  if (auth instanceof Response) return auth;

  const body = await req.text();
  const resp = await fetch(`${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/label-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
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

async function handleTrainStart(req: Request, env: Env): Promise<Response> {
  const auth = await authAndCharge(req, env, PRICE_MCENTS.train_yolo, "train");
  if (auth instanceof Response) return auth;

  const body = await req.text();
  const resp = await fetch(`${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/train-yolo/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = await resp.json().catch(() => ({}));
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
  const data = await resp.json().catch(() => ({}));
  return json({ ok: resp.ok, balance_mcents: rec.balance_mcents, xp: rec.xp, level: level(rec.xp), upstream: data }, { status: resp.status });
}

async function handleTrainWeights(req: Request, env: Env, jobId: string): Promise<Response> {
  const key = extractBearer(req);
  if (!key) return error(401, "missing bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");
  const resp = await fetch(`${env.DLF_VERCEL_BASE_URL.replace(/\/$/, "")}/api/train-yolo/weights/${jobId}`);
  const headers = new Headers(resp.headers);
  headers.set("X-DLF-Balance-Mcents", String(rec.balance_mcents));
  headers.set("X-DLF-XP", String(rec.xp));
  headers.set("X-DLF-Level", String(level(rec.xp)));
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(resp.body, { status: resp.status, headers });
}

// ---- Admin handlers ---------------------------------------------------------

async function handleAdminCreateKey(req: Request, env: Env): Promise<Response> {
  const gate = requireAdmin(req, env);
  if (gate) return gate;
  const body = (await req.json().catch(() => ({}))) as any;
  const balance_mcents = Math.max(0, Number(body.balance_mcents) || 0);
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

async function handleAdminGetKey(req: Request, env: Env, key: string): Promise<Response> {
  const gate = requireAdmin(req, env);
  if (gate) return gate;
  const rec = await readKey(env, key);
  if (!rec) return error(404, "api key not found");
  return json({ ok: true, key, ...profileView(rec, key) });
}

// ---- Router -----------------------------------------------------------------

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

    try {
      if (p === "/v1/health" && req.method === "GET") return handleHealth();
      if (p === "/v1/pricing" && req.method === "GET") return handlePricing();
      if (p === "/v1/leaderboard" && req.method === "GET") return handleLeaderboard(env);
      if (p === "/v1/activity" && req.method === "GET") return handleActivity(env, url);
      if (p === "/v1/balance" && req.method === "GET") return handleBalance(req, env);
      if (p === "/v1/profile" && req.method === "GET") return handleProfile(req, env);
      if (p === "/v1/profile/name" && req.method === "POST") return handleSetName(req, env);

      if (p === "/v1/crawl" && req.method === "POST") return handleCrawl(req, env);
      if (p === "/v1/gather" && req.method === "POST") return handleGather(req, env);
      if (p === "/v1/label" && req.method === "POST") return handleLabel(req, env);

      if (p === "/v1/train-yolo/start" && req.method === "POST") return handleTrainStart(req, env);

      const statusMatch = p.match(/^\/v1\/train-yolo\/status\/([a-zA-Z0-9_\-]+)$/);
      if (statusMatch && req.method === "GET") return handleTrainStatus(req, env, statusMatch[1]);

      const weightsMatch = p.match(/^\/v1\/train-yolo\/weights\/([a-zA-Z0-9_\-]+)$/);
      if (weightsMatch && req.method === "GET") return handleTrainWeights(req, env, weightsMatch[1]);

      if (p === "/v1/admin/keys" && req.method === "POST") return handleAdminCreateKey(req, env);

      const topupMatch = p.match(/^\/v1\/admin\/keys\/(dlf_[a-f0-9]+)\/topup$/);
      if (topupMatch && req.method === "POST") return handleAdminTopup(req, env, topupMatch[1]);

      const getKeyMatch = p.match(/^\/v1\/admin\/keys\/(dlf_[a-f0-9]+)$/);
      if (getKeyMatch && req.method === "GET") return handleAdminGetKey(req, env, getKeyMatch[1]);

      return error(404, `route not found: ${req.method} ${p}`);
    } catch (e: any) {
      return error(500, e?.message || "internal error");
    }
  },
};
