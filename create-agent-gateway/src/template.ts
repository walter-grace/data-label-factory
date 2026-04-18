/**
 * Agent Gateway template — single-file Cloudflare Worker.
 *
 * Reusable primitives for pay-per-call agent APIs. Replace the
 * `/v1/example` handler with your own paid tools.
 *
 * See the companion README.md for setup + deploy.
 */

export interface Env {
  KEYS: KVNamespace;
  LEADERBOARD: DurableObjectNamespace;
  ADMIN_KEY: string;
  PAYMENT_RECIPIENT: string; // 0x... Base wallet receiving USDC
  CDP_API_KEY_ID?: string;   // optional; free x402.org used if missing
  CDP_API_KEY_SECRET?: string;
}

// ---- Types -----------------------------------------------------------------

type CallType = "example" | "read";
type Scope = "example" | "read" | "all";

const SCOPE_FOR: Record<CallType, Scope> = {
  example: "example",
  read: "read",
};

// Pricing in mcents (1 mcent = 1/1000¢ = $0.00001).
export const PRICE_MCENTS = {
  example: 100, // $0.001 per call — customize per handler
} as const;

export const XP_AWARD: Record<CallType, number> = {
  example: 10,
  read: 0,
};

type KeyRecord = {
  balance_mcents: number;
  xp: number;
  created_at: number;
  last_active_at: number;
  display_name?: string;
  calls_total: number;
  calls_by_type: Partial<Record<CallType, number>>;
  badges: string[];
  scopes?: Scope[];
};

// ---- Primitives: auth + scope + charge ------------------------------------

function hasScope(rec: KeyRecord, needed: Scope): boolean {
  const s = rec.scopes;
  if (!s || s.length === 0) return true;
  if (s.includes("all")) return true;
  return s.includes(needed);
}

async function readKey(env: Env, key: string): Promise<KeyRecord | null> {
  const raw = await env.KEYS.get(key);
  return raw ? JSON.parse(raw) as KeyRecord : null;
}

async function writeKey(env: Env, key: string, rec: KeyRecord) {
  await env.KEYS.put(key, JSON.stringify(rec));
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get("Authorization");
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function level(xp: number): number {
  return Math.floor(Math.sqrt(xp / 50));
}

function json(body: any, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...(init.headers || {}),
    },
  });
}

function error(status: number, message: string, extra?: any): Response {
  return json({ ok: false, error: message, ...(extra || {}) }, { status });
}

async function authAndCharge(
  req: Request,
  env: Env,
  cost_mcents: number,
  call_type: CallType,
): Promise<{ ok: true; record: KeyRecord; key: string } | Response> {
  const key = extractBearer(req);
  if (!key?.startsWith("k_")) return error(401, "missing or malformed bearer token");
  const rec = await readKey(env, key);
  if (!rec) return error(401, "invalid api key");

  const needed = SCOPE_FOR[call_type];
  if (!hasScope(rec, needed)) {
    return error(403, `not authorized for "${needed}"`, { scopes: rec.scopes });
  }

  if (rec.balance_mcents < cost_mcents) {
    return error(402, "insufficient balance", {
      balance_mcents: rec.balance_mcents,
      required_mcents: cost_mcents,
    });
  }

  const updated: KeyRecord = {
    ...rec,
    balance_mcents: rec.balance_mcents - cost_mcents,
    xp: rec.xp + (XP_AWARD[call_type] || 0),
    last_active_at: Date.now(),
    calls_total: rec.calls_total + 1,
    calls_by_type: {
      ...rec.calls_by_type,
      [call_type]: (rec.calls_by_type[call_type] || 0) + 1,
    },
  };
  await writeKey(env, key, updated);
  return { ok: true, record: updated, key };
}

// ---- Example handler (replace with your own) ------------------------------

async function handleExample(req: Request, env: Env): Promise<Response> {
  const auth = await authAndCharge(req, env, PRICE_MCENTS.example, "example");
  if (auth instanceof Response) return auth;
  return json({
    ok: true,
    message: "Hello from your agent gateway. Replace this handler with real work.",
    balance_mcents: auth.record.balance_mcents,
    xp: auth.record.xp,
    level: level(auth.record.xp),
  });
}

// ---- Router ---------------------------------------------------------------

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
        },
      });
    }

    if (p === "/v1/health") return json({ ok: true, ts: Date.now() });
    if (p === "/v1/pricing") return json({ prices_mcents: PRICE_MCENTS });
    if (p === "/v1/example" && req.method === "POST") return handleExample(req, env);

    return error(404, `route not found: ${req.method} ${p}`);
  },
};

// Durable Object stub (expand with leaderboard + activity in the real repo).
export class LeaderboardDO {
  state: DurableObjectState;
  constructor(state: DurableObjectState) { this.state = state; }
  async fetch(req: Request): Promise<Response> {
    return new Response("stub");
  }
}
