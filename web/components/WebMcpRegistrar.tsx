"use client";

import { useEffect } from "react";

// WebMCP client-side registrar. Exposes a small set of DLF tools to any
// browser-resident AI agent that implements the WebMCP API (Chrome, other
// agentic browsers). Tools run in the user's page context; anything that
// needs the user's dlf_ key pulls from localStorage["dlf_key"] set by the
// /agents ClaimKeyCard after signup.
//
// Spec: https://webmachinelearning.github.io/webmcp/
// Validate: https://isitagentready.com → discovery.webMcp should pass.

const GATEWAY = "https://dlf-gateway.agentlabel.workers.dev";

type RegisterToolArgs = {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (input: any) => Promise<unknown>;
};

type ModelContextSignalOption = { signal?: AbortSignal };

declare global {
  interface Navigator {
    modelContext?: {
      registerTool?: (tool: RegisterToolArgs, opts?: ModelContextSignalOption) => void;
      provideContext?: (spec: unknown) => void;
    };
  }
}

function readKey(): string | null {
  try {
    const raw = localStorage.getItem("dlf_key");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.key === "string" ? parsed.key : null;
  } catch {
    return null;
  }
}

export default function WebMcpRegistrar() {
  useEffect(() => {
    const mc = navigator.modelContext;
    if (!mc?.registerTool) return;

    const controller = new AbortController();
    const opts = { signal: controller.signal };

    const register = (tool: RegisterToolArgs) => {
      try { mc.registerTool!(tool, opts); } catch { /* browser may restrict */ }
    };

    register({
      name: "dlf_get_jackpot",
      description:
        "Fetch the live Label Jackpot state — pool USD, contributors, top labelers, last payout, cooldown.",
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => {
        const r = await fetch(`${GATEWAY}/v1/jackpot`);
        return await r.json();
      },
    });

    register({
      name: "dlf_get_pricing",
      description:
        "Fetch the live per-call pricing table for crawl/gather/label/predict/train on the Data Label Factory gateway.",
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => {
        const r = await fetch(`${GATEWAY}/v1/pricing`);
        return await r.json();
      },
    });

    register({
      name: "dlf_get_leaderboard",
      description: "Fetch the top agents ranked by XP from Data Label Factory.",
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => {
        const r = await fetch(`${GATEWAY}/v1/leaderboard`);
        return await r.json();
      },
    });

    register({
      name: "dlf_get_marketplace",
      description:
        "List published YOLO models available to run via /v1/predict. Returns model metadata + per-call cost.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: [],
      },
      execute: async ({ limit = 10 }: { limit?: number } = {}) => {
        const r = await fetch(`${GATEWAY}/v1/marketplace?limit=${limit}`);
        return await r.json();
      },
    });

    register({
      name: "dlf_get_balance",
      description:
        "Read the current balance + XP + level of the user's Data Label Factory key (stored locally in this browser).",
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => {
        const key = readKey();
        if (!key) return { error: "no dlf_ key found in this browser. Claim one at /agents first." };
        const r = await fetch(`${GATEWAY}/v1/balance`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        return await r.json();
      },
    });

    register({
      name: "dlf_open",
      description:
        "Navigate the user to a Data Label Factory page: home, pricing, arena (live jackpot), agents (claim a key), subscribe, community (marketplace), go (label UI), how-it-works.",
      inputSchema: {
        type: "object",
        properties: {
          page: {
            type: "string",
            enum: ["home", "pricing", "arena", "agents", "subscribe", "community", "go", "how-it-works"],
            default: "home",
          },
        },
        required: ["page"],
      },
      execute: async ({ page }: { page: string }) => {
        const map: Record<string, string> = {
          home: "/",
          pricing: "/pricing",
          arena: "/arena",
          agents: "/agents",
          subscribe: "/subscribe",
          community: "/community",
          go: "/go",
          "how-it-works": "/how-it-works",
        };
        const path = map[page] || "/";
        window.location.href = path;
        return { ok: true, navigated_to: path };
      },
    });

    return () => controller.abort();
  }, []);

  return null;
}
