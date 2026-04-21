/**
 * DLF Agent Farm — keeps the /agents leaderboard alive.
 *
 * Every ~20 minutes, one of the Gemma agents gathers + labels a random query.
 * Stateless, idempotent, skips low-balance agents.
 */

export interface Env {
  GATEWAY: Fetcher;
  GATEWAY_URL: string;
  SCOUT_KEY: string;
  SPECIALIST_KEY: string;
  EXPLORER_KEY: string;
  MIN_BALANCE_MCENTS: string;
  // Vercel host for the /api/community/auto-post sink. Optional — if
  // unset the farm just skips the showcase post and only produces
  // gateway activity.
  VERCEL_BASE_URL?: string;
}

const QUERIES = [
  "red barn farmhouse",
  "solar panel array rooftop",
  "construction hard hat worker",
  "yellow forklift warehouse",
  "wind turbine field",
  "shipping container port",
  "stop sign intersection",
  "drone aerial farm",
  "yellow school bus",
  "fire hydrant street",
  "traffic cone road work",
  "parked bicycle city",
];

const AGENTS: Array<[string, keyof Env]> = [
  ["Gemma-Scout", "SCOUT_KEY"],
  ["Gemma-Specialist", "SPECIALIST_KEY"],
  ["Gemma-Explorer", "EXPLORER_KEY"],
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function runTick(env: Env): Promise<object> {
  const minBal = parseInt(env.MIN_BALANCE_MCENTS || "1000", 10);
  const [name, keyField] = pick(AGENTS);
  const key = env[keyField] as string;
  if (!key) return { ok: false, error: `missing secret ${keyField}` };
  const query = pick(QUERIES);
  const started = Date.now();

  const headers = {
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    "User-Agent": "dlf-agent-farm/0.1",
  };

  const gatherUrl = `${env.GATEWAY_URL}/v1/gather`;
  const gResp = await env.GATEWAY.fetch(gatherUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, max_images: 2 }),
  });
  const gText = await gResp.text();
  let gData: any = {};
  try { gData = JSON.parse(gText); } catch {}
  if (!gResp.ok) {
    return { ok: false, stage: "gather", status: gResp.status, url: gatherUrl, body: gText.slice(0, 300), agent: name, query };
  }

  const balance = gData.balance_mcents ?? 0;
  if (balance < minBal) {
    return { ok: false, skip: "low_balance", agent: name, balance };
  }

  const images: Array<{ url: string }> = gData.upstream?.images || [];
  if (images.length === 0) {
    return { ok: false, stage: "gather", note: "no images", agent: name, query };
  }

  const img = pick(images);
  const lResp = await env.GATEWAY.fetch(`${env.GATEWAY_URL}/v1/label`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: img.url, queries: query, backend: "openrouter" }),
  });
  const lData: any = await lResp.json().catch(() => ({}));
  const detections = lData.upstream?.n_detections;

  // Post a community showcase so the /community page gets fresh pictures.
  // Best-effort — gateway-side activity is already recorded above; this is
  // only to surface thumbnails in the Vercel UI.
  let showcased: any = null;
  if (env.VERCEL_BASE_URL && lResp.ok) {
    try {
      const showcaseUrls = images.slice(0, 3).map((i) => i.url);
      const r = await fetch(`${env.VERCEL_BASE_URL.replace(/\/$/, "")}/api/community/auto-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          agent_id: name,
          image_urls: showcaseUrls,
          image_count: images.length,
          detections,
          post_type: "showcase",
        }),
      });
      showcased = { status: r.status };
    } catch (e: any) {
      showcased = { error: String(e).slice(0, 120) };
    }
  }

  return {
    ok: lResp.ok,
    agent: name,
    query,
    elapsed_ms: Date.now() - started,
    detections,
    balance_mcents: lData.balance_mcents,
    xp: lData.xp,
    level: lData.level,
    new_badges: lData.new_badges,
    showcased,
  };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runTick(env).then((r) => console.log("tick:", JSON.stringify(r)))
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "dlf-agent-farm" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      const out = await runTick(env);
      return new Response(JSON.stringify(out, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("agent-farm: POST /run to trigger, GET /health for status", {
      status: 404,
    });
  },
};
