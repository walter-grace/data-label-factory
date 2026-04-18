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
};

function hasScope(rec: KeyRecord, needed: Scope): boolean {
  const s = rec.scopes;
  if (!s || s.length === 0) return true; // backwards compat: no-scopes = all
  if (s.includes("all")) return true;
  return s.includes(needed);
}

// ---- Pricing (mcents) -------------------------------------------------------

const PRICE_MCENTS = {
  crawl_per_page: 50,     // $0.0005 / page
  gather: 100,            // $0.001 / call
  label_per_image: 200,   // $0.002 / image
  train_yolo: 2000,       // $0.02 / job
  predict_per_image: 20,  // $0.0002 / inference — trained models run cheap
} as const;

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
): Promise<{ ok: true; record: KeyRecord; key: string } | Response> {
  const key = extractBearer(req);
  if (!key || !key.startsWith("dlf_")) return error(401, "missing or malformed bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");

  const needed = SCOPE_FOR[call_type];
  if (!hasScope(rec, needed)) {
    return error(403, `this key is not authorized for "${needed}"`, {
      scopes: rec.scopes,
      required_scope: needed,
    });
  }

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
    scopes: rec.scopes ?? ["all"],
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
      predict_per_image: (PRICE_MCENTS.predict_per_image / 100000).toFixed(5),
    },
    xp_awards_per_call: XP_AWARD,
    leveling: "level = floor(sqrt(xp / 50))",
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
      docs: "https://dlf-gateway.nico-zahniser.workers.dev/llms.txt",
      health: "https://dlf-gateway.nico-zahniser.workers.dev/v1/health",
      pricing: "https://dlf-gateway.nico-zahniser.workers.dev/v1/pricing",
      mcp: "https://dlf-gateway.nico-zahniser.workers.dev/.well-known/mcp.json",
      signup: "https://dlf-gateway.nico-zahniser.workers.dev/v1/signup",
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
    <li><code>POST /v1/signup</code> — get a key via x402 (0.10 USDC on Base → 50,000 mcents)</li>
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
  const base = "https://dlf-gateway.nico-zahniser.workers.dev";
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
      "Sitemap: https://dlf-gateway.nico-zahniser.workers.dev/sitemap.xml",
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
      "- [Health](https://dlf-gateway.nico-zahniser.workers.dev/v1/health): liveness probe",
      "- [Pricing](https://dlf-gateway.nico-zahniser.workers.dev/v1/pricing): current per-call pricing in mcents (1/1000¢)",
      "- [Leaderboard](https://dlf-gateway.nico-zahniser.workers.dev/v1/leaderboard): top agents by XP",
      "- [Activity feed](https://dlf-gateway.nico-zahniser.workers.dev/v1/activity?limit=20): recent agent calls",
      "- [Signup (x402)](https://dlf-gateway.nico-zahniser.workers.dev/v1/signup): POST to get payment quote; retry with X-PAYMENT for key",
      "",
      "## Authenticated endpoints",
      "Use `Authorization: Bearer dlf_<hex>` on every call.",
      "- POST /v1/crawl — Cloudflare Browser Rendering crawl (50 mcents/page)",
      "- POST /v1/gather — DuckDuckGo image gather (100 mcents/call)",
      "- POST /v1/label — Vision model bbox labeling (200 mcents/image)",
      "- POST /v1/train-yolo/start — Launch YOLO training on RunPod (2000 mcents/job)",
      "- GET /v1/train-yolo/status/:id — Poll job state",
      "- GET /v1/train-yolo/weights/:id — Download .pt (streamed)",
      "- GET /v1/balance, /v1/profile — Account metadata",
      "",
      "## Discovery",
      "- /.well-known/api-catalog — RFC 9727 machine-readable API listing",
      "- /.well-known/mcp.json — MCP server manifest",
      "- /.well-known/agent-skills/index.json — Skill definitions",
      "",
      "## Policy",
      "- Label refunds: provider-side failures only (HTTP 5xx, timeout, upstream error). Capped 5/hour/key.",
      "- x402 signup: 0.10 USDC on Base → 50,000 mcents starter balance.",
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
        anchor: "https://dlf-gateway.nico-zahniser.workers.dev/",
        "service-desc": [
          {
            href: "https://dlf-gateway.nico-zahniser.workers.dev/v1/pricing",
            type: "application/json",
            title: "Pricing — machine-readable",
          },
        ],
        "service-doc": [
          {
            href: "https://dlf-gateway.nico-zahniser.workers.dev/llms.txt",
            type: "text/markdown",
            title: "LLM-friendly documentation",
          },
        ],
        "status-desc": [
          {
            href: "https://dlf-gateway.nico-zahniser.workers.dev/v1/health",
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
      { type: "http", endpoint: "https://dlf-gateway.nico-zahniser.workers.dev/mcp", protocolVersion: "2025-03-26" },
    ],
    authentication: {
      scheme: "bearer",
      description: "Bearer dlf_<48hex> — obtain via POST /v1/signup with x402 payment",
      obtain_url: "https://data-label-factory.vercel.app/agents",
    },
    pricing: {
      model: "pay-per-call",
      currency: "usd-mcents",
      endpoint: "https://dlf-gateway.nico-zahniser.workers.dev/v1/pricing",
    },
    install: {
      claude_desktop: {
        config_example: {
          mcpServers: {
            "data-label-factory": {
              transport: "http",
              url: "https://dlf-gateway.nico-zahniser.workers.dev/mcp",
              headers: { Authorization: "Bearer dlf_YOUR_KEY" },
            },
          },
        },
      },
    },
    tools: [
      { name: "dlf_crawl", description: "Fetch + parse a URL via Cloudflare Browser Rendering", cost_mcents: 50 },
      { name: "dlf_gather", description: "DuckDuckGo image search for a query", cost_mcents: 100 },
      { name: "dlf_label", description: "Vision model bounding-box annotation", cost_mcents: 200 },
      { name: "dlf_train_yolo", description: "Start a YOLOv8n training job on GPU", cost_mcents: 2000 },
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
  return Response.json({
    skills: [
      {
        id: "dlf.gather",
        name: "Image Gather",
        description: "Search the web for images matching a query.",
        cost_usd: "0.00100",
        input_schema: { query: "string", max_images: "integer (1-50)" },
        endpoint: "POST https://dlf-gateway.nico-zahniser.workers.dev/v1/gather",
      },
      {
        id: "dlf.label",
        name: "Vision Labeling",
        description: "Annotate an image with bounding boxes for a target class.",
        cost_usd: "0.00200",
        input_schema: { path: "url", queries: "string", backend: "openrouter|falcon|auto" },
        endpoint: "POST https://dlf-gateway.nico-zahniser.workers.dev/v1/label",
      },
      {
        id: "dlf.train_yolo",
        name: "Train YOLO Detector",
        description: "Train a YOLOv8n model on a labeled image set; returns .pt weights.",
        cost_usd: "0.02000",
        input_schema: { query: "string", epochs: "integer", images: "array" },
        endpoint: "POST https://dlf-gateway.nico-zahniser.workers.dev/v1/train-yolo/start",
      },
    ],
  }, {
    headers: { "access-control-allow-origin": "*" },
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
//         "url": "https://dlf-gateway.nico-zahniser.workers.dev/mcp",
//         "headers": { "Authorization": "Bearer dlf_..." }
//       }
//     }
//   }
//
// Tool calls proxy through the same REST handlers (auth, charging, scopes,
// refunds all inherit). Leaderboard + pricing tools skip auth.

const MCP_PROTOCOL_VERSION = "2025-03-26";

const MCP_TOOLS = [
  {
    name: "dlf_gather",
    description: "Search the web for images matching a query. Costs 100 mcents/call. Returns up to max_images URLs.",
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
    description: "Annotate an image URL with bounding boxes for a target class using a vision model. Costs 200 mcents/call.",
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
    description: "Fetch and parse a URL via Cloudflare Browser Rendering. Costs 50 mcents/page.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
    },
  },
  {
    name: "dlf_train_yolo",
    description: "Start a YOLOv8n training job on a GPU. Costs 2000 mcents/job. Returns a job_id to poll via dlf_train_status.",
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

  let refunded = false;
  const refundEligible = shouldRefundLabel(resp.status, data);
  if (refundEligible) {
    const now = Date.now();
    // Operate on the in-memory record written by authAndCharge. Re-reading
    // KV hits an eventually-consistent read replica that often returns a
    // stale snapshot, which would miscount the refund window under rapid-
    // fire requests.
    if (canIssueRefund(auth.record, now)) {
      const window = (auth.record.refunds_window || []).filter((ts) => now - ts < REFUND_WINDOW_MS);
      window.push(now);
      auth.record.balance_mcents += PRICE_MCENTS.label_per_image;
      auth.record.refunds_window = window;
      await writeKey(env, auth.key, auth.record);
      refunded = true;
    }
  }

  return json({
    ok: resp.ok,
    balance_mcents: auth.record.balance_mcents,
    xp: auth.record.xp,
    level: level(auth.record.xp),
    charged: !refunded,
    refunded,
    upstream: data,
  }, { status: resp.status });
}

// ---- Predict: run a trained model on a new image --------------------------
//
// Caches weights in KV on first call per job_id (to avoid re-fetching the 6MB
// .pt from Vercel on every inference), then forwards {weights_b64, image_url}
// to the dlf-yolo-infer RunPod endpoint.

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
  // Pre-flight: fail cheap before charging if infra isn't ready.
  const endpointId = (env as any).RUNPOD_INFER_ENDPOINT_ID;
  const apiKey = (env as any).RUNPOD_API_KEY;
  if (!endpointId || !apiKey) {
    return error(503, "inference endpoint not yet configured; no charge applied");
  }

  const auth = await authAndCharge(req, env, PRICE_MCENTS.predict_per_image, "predict");
  if (auth instanceof Response) return auth;

  let body: any;
  try { body = await req.json(); }
  catch { return error(400, "json body required with {image_url}"); }
  const imageUrl = body?.image_url || body?.path;
  if (!imageUrl) return error(400, "image_url required");

  const weightsB64 = await getCachedWeights(env, jobId);
  if (!weightsB64) {
    return json({
      ok: false,
      error: "weights not found for this job_id (check train completed)",
      balance_mcents: auth.record.balance_mcents,
    }, { status: 404 });
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
    return json({
      ok: false,
      error: submitData?.error || `submit ${submit.status}`,
      balance_mcents: auth.record.balance_mcents,
      model_job_id: jobId,
    }, { status: submit.status || 502 });
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
      return json({
        ok: pollData?.output?.ok !== false,
        balance_mcents: auth.record.balance_mcents,
        xp: auth.record.xp,
        level: level(auth.record.xp),
        model_job_id: jobId,
        run_id: runId,
        upstream: pollData.output || {},
      });
    }
    if (st === "FAILED" || st === "CANCELLED") {
      return json({
        ok: false,
        error: pollData?.error || `job ${st}`,
        balance_mcents: auth.record.balance_mcents,
        model_job_id: jobId,
        run_id: runId,
        upstream: pollData,
      }, { status: 502 });
    }
    // IN_QUEUE / IN_PROGRESS — wait and retry.
    await new Promise((r) => setTimeout(r, 2000));
  }

  return json({
    ok: false,
    error: "inference timed out after 90s",
    balance_mcents: auth.record.balance_mcents,
    model_job_id: jobId,
    run_id: runId,
    upstream: lastStatus,
  }, { status: 504 });
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
  if (!hasScope(rec, "train")) {
    return error(403, "this key is not authorized for train/weights", {
      scopes: rec.scopes,
      required_scope: "train",
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
// Starter balance: 50,000 mcents ($0.50) — 5x what they paid. XP head start = 0.

const SIGNUP_PRICE_ATOMIC = "100000"; // 0.10 USDC (6 decimals)
const SIGNUP_STARTER_MCENTS = 50000; // $0.50
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
        description: "DLF agent API key — $0.10 unlocks 50,000 mcents ($0.50 starter balance)",
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

      const predictMatch = p.match(/^\/v1\/predict\/([a-zA-Z0-9_\-]+)$/);
      if (predictMatch && req.method === "POST") return handlePredict(req, env, predictMatch[1]);

      const weightsMatch = p.match(/^\/v1\/train-yolo\/weights\/([a-zA-Z0-9_\-]+)$/);
      if (weightsMatch && req.method === "GET") return handleTrainWeights(req, env, weightsMatch[1]);

      if (p === "/v1/signup" && req.method === "POST") return handleSignup(req, env);

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
