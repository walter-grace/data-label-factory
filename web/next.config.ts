import type { NextConfig } from "next";

// Proxy agent-discovery paths to the gateway Worker so the web surface
// passes Cloudflare Agent Readiness `discovery.*` checks without
// duplicating the manifests. Single source of truth lives on the gateway
// (already Level 4 certified).
const GATEWAY = "https://dlf-gateway.nico-zahniser.workers.dev";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/.well-known/mcp.json", destination: `${GATEWAY}/.well-known/mcp.json` },
      { source: "/.well-known/api-catalog", destination: `${GATEWAY}/.well-known/api-catalog` },
      { source: "/.well-known/agent-skills/index.json", destination: `${GATEWAY}/.well-known/agent-skills/index.json` },
      // Agent-to-Agent (A2A) card — stub that points at the gateway's MCP
      // surface until we have a separate A2A endpoint.
      { source: "/.well-known/a2a.json", destination: `${GATEWAY}/.well-known/mcp.json` },
      { source: "/.well-known/ai-plugin.json", destination: `${GATEWAY}/.well-known/mcp.json` },
    ];
  },
  // Content-Signals header declares our posture on AI training / retrieval /
  // search indexing so scanners (and well-behaved bots) can route accordingly.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Signals",
            value: "search=yes, ai-train=no, ai-input=yes",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
