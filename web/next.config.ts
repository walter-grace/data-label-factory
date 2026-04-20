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
  // Also force application/json on the OAuth discovery endpoints — they have
  // no file extension so Vercel defaults them to application/octet-stream.
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
      {
        source: "/.well-known/oauth-authorization-server",
        headers: [{ key: "Content-Type", value: "application/json; charset=utf-8" }],
      },
      {
        source: "/.well-known/oauth-protected-resource",
        headers: [{ key: "Content-Type", value: "application/json; charset=utf-8" }],
      },
    ];
  },
};

export default nextConfig;
