/**
 * DLF Agent Farm — Agents SDK version (Project Think).
 *
 * Same job as dlf-agent-farm (20-min cron → one of 3 Gemma agents does
 * gather+label via the gateway), but each agent is a Durable Object actor
 * with its own SQLite state and independent schedule. Scout runs at :00,
 * Specialist at :20, Explorer at :40 — one hour per full rotation.
 *
 * See ../agent-farm/ for the plain-Worker version that currently runs in
 * prod. Deploy this alongside (different Worker name) to validate before
 * retiring the classic farm.
 */

import { Agent, getAgentByName, routeAgentRequest } from "agents";

export interface Env {
  ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
  SCOUT: DurableObjectNamespace<Scout>;
  SPECIALIST: DurableObjectNamespace<Specialist>;
  EXPLORER: DurableObjectNamespace<Explorer>;
  GATEWAY: Fetcher;
  GATEWAY_URL: string;
  SCOUT_KEY: string;
  SPECIALIST_KEY: string;
  EXPLORER_KEY: string;
  MIN_BALANCE_MCENTS: string;
}

type FarmState = {
  name: string;
  specialty: string;
  ticks: number;
  last_tick_at?: number;
  last_detections?: number;
  last_error?: string;
};

const QUERIES_BY_SPECIALTY: Record<string, string[]> = {
  "vehicle": ["yellow forklift warehouse", "yellow school bus", "shipping container port", "traffic cone road work"],
  "infrastructure": ["red barn farmhouse", "wind turbine field", "solar panel array rooftop", "fire hydrant street"],
  "human-environment": ["construction hard hat worker", "stop sign intersection", "drone aerial farm", "parked bicycle city"],
};

// ---- Base class: shared farm tick logic -----------------------------------

abstract class FarmAgent extends Agent<Env, FarmState> {
  // initialState runs BEFORE onStart — seeds state so it's never undefined.
  initialState: FarmState = { name: "", specialty: "", ticks: 0 };

  abstract agentKey(env: Env): string;
  abstract specialty(): string;
  abstract displayName(): string;

  async onStart() {
    // Idempotent: scheduleEvery ignores duplicates if already registered.
    await this.scheduleEvery(1200, "tick"); // 20 min
    const cur = this.state ?? this.initialState;
    if (!cur.name) {
      this.setState({
        name: this.displayName(),
        specialty: this.specialty(),
        ticks: 0,
      });
    }
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  async tick() {
    const env = this.env;
    const key = this.agentKey(env);
    const minBal = parseInt(env.MIN_BALANCE_MCENTS || "1000", 10);
    const queries = QUERIES_BY_SPECIALTY[this.specialty()] || QUERIES_BY_SPECIALTY["vehicle"];
    const query = this.pick(queries);
    const headers = {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": `dlf-agent-farm-think/${this.displayName()}`,
    };

    try {
      const gResp = await env.GATEWAY.fetch(`${env.GATEWAY_URL}/v1/gather`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, max_images: 2 }),
      });
      const gData: any = await gResp.json().catch(() => ({}));
      if (!gResp.ok) {
        this.setState({ ...(this.state ?? this.initialState), ticks: this.state.ticks + 1, last_tick_at: Date.now(), last_error: `gather ${gResp.status}` });
        return;
      }
      if ((gData.balance_mcents ?? 0) < minBal) {
        this.setState({ ...(this.state ?? this.initialState), ticks: this.state.ticks + 1, last_tick_at: Date.now(), last_error: "low_balance" });
        return;
      }

      const images = gData.upstream?.images || [];
      if (images.length === 0) {
        this.setState({ ...(this.state ?? this.initialState), ticks: this.state.ticks + 1, last_tick_at: Date.now(), last_error: "no_images" });
        return;
      }

      const img = this.pick(images) as { url: string };
      const lResp = await env.GATEWAY.fetch(`${env.GATEWAY_URL}/v1/label`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: img.url, queries: query, backend: "openrouter" }),
      });
      const lData: any = await lResp.json().catch(() => ({}));
      const detections = lData.upstream?.n_detections ?? 0;

      this.setState({
        ...this.state,
        ticks: this.state.ticks + 1,
        last_tick_at: Date.now(),
        last_detections: detections,
        last_error: undefined,
      });
    } catch (e: any) {
      this.setState({
        ...this.state,
        ticks: this.state.ticks + 1,
        last_tick_at: Date.now(),
        last_error: e?.message || "tick threw",
      });
    }
  }

  async status(): Promise<FarmState> {
    return this.state;
  }
}

// Concrete agents — each has its own DO namespace so it schedules independently.

export class Scout extends FarmAgent {
  agentKey(env: Env) { return env.SCOUT_KEY; }
  specialty() { return "vehicle"; }
  displayName() { return "Gemma-Scout"; }
}

export class Specialist extends FarmAgent {
  agentKey(env: Env) { return env.SPECIALIST_KEY; }
  specialty() { return "infrastructure"; }
  displayName() { return "Gemma-Specialist"; }
}

export class Explorer extends FarmAgent {
  agentKey(env: Env) { return env.EXPLORER_KEY; }
  specialty() { return "human-environment"; }
  displayName() { return "Gemma-Explorer"; }
}

// Orchestrator: one-shot bootstrap + aggregated status view.

export class Orchestrator extends Agent<Env, { started_at: number }> {
  async onStart() {
    this.setState({ started_at: Date.now() });
    // Touch each child once so their own onStart registers the alarm.
    await getAgentByName(this.env.SCOUT, "scout");
    await getAgentByName(this.env.SPECIALIST, "specialist");
    await getAgentByName(this.env.EXPLORER, "explorer");
  }
}

// ---- HTTP entrypoint ------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function cors(resp: Response): Response {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/health") {
      return cors(Response.json({ ok: true, service: "dlf-agent-farm-think" }));
    }
    if (url.pathname === "/status") {
      // Aggregate the three agents' states.
      const [scout, specialist, explorer] = await Promise.all([
        getAgentByName(env.SCOUT, "scout"),
        getAgentByName(env.SPECIALIST, "specialist"),
        getAgentByName(env.EXPLORER, "explorer"),
      ]);
      return cors(Response.json({
        scout: await (scout as any).status?.() ?? null,
        specialist: await (specialist as any).status?.() ?? null,
        explorer: await (explorer as any).status?.() ?? null,
      }));
    }

    // Manual tick — useful for demos and for verifying the pipeline without
    // waiting 20 min. POST /tick/scout (or specialist/explorer) fires one
    // gather+label cycle for that agent.
    const tickMatch = url.pathname.match(/^\/tick\/(scout|specialist|explorer)$/);
    if (tickMatch && req.method === "POST") {
      const name = tickMatch[1];
      const ns = name === "scout" ? env.SCOUT : name === "specialist" ? env.SPECIALIST : env.EXPLORER;
      const agent = await getAgentByName(ns as any, name);
      await (agent as any).tick();
      return cors(Response.json({ ok: true, ticked: name, state: await (agent as any).status?.() }));
    }
    // Fallback to Agents SDK's default router for /agents/:class/:name/...
    return (await routeAgentRequest(req, env)) ?? new Response("agent-farm-think: / /health /status", { status: 404 });
  },

  async scheduled(_ctl: ScheduledController, env: Env): Promise<void> {
    // One-shot bootstrap: touching the orchestrator runs onStart which touches
    // each child, which registers their own scheduleEvery alarms. After the
    // first tick this cron is redundant — kept as a safety net.
    const o = await getAgentByName(env.ORCHESTRATOR, "main");
    await (o as any).onStart?.();
  },
};
