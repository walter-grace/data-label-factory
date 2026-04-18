# create-agent-gateway

A reusable Cloudflare Worker template for pay-per-call agent gateways — the pattern behind [Data Label Factory](https://data-label-factory.vercel.app)'s `dlf-gateway`.

## What you get out of the box

- **Bearer-token auth** with keys stored in Workers KV
- **mcent pricing** (1 mcent = 1/1000 of a cent) — cheap enough for true pay-per-call agent economies
- **x402-gated signup** — strangers pay USDC on Base via Coinbase CDP facilitator to mint their own key, no Stripe, no email
- **Scoped keys** (`crawl`, `gather`, `label`, `read`, `all` — extendable) for tiered access
- **XP + leaderboard + badges** via a single global Durable Object (serializes writes, race-free under concurrent traffic)
- **Refund policy** — auto-refund provider-side failures (5xx, timeout, "provider error"), capped N/hour/key to block farming
- **Cloudflare Agent Readiness Level 4** discovery: `robots.txt` with Content Signals, `llms.txt`, `/.well-known/{api-catalog,mcp.json,agent-skills/index.json}`, RFC 8288 `Link` header, sitemap
- **MCP server** at `/mcp` — Claude Desktop / Cursor / Zed install with one config block; tools proxy to your REST handlers
- **Public leaderboard** endpoint + activity feed for the showcase page

## Why this pattern

Agents need:
1. A way to authenticate (bearer keys — simpler than OAuth)
2. A balance to draw down (mcents so $0.01 covers 100 calls)
3. A self-serve onramp (x402 so strangers can mint keys programmatically)
4. Reputation primitives (XP, level, badges so the market rewards quality)
5. Discoverability (Agent Readiness + MCP so they find you)

Stripe, OAuth, and dashboards add friction agents can't traverse. This stack skips all of that.

## Quickstart

```bash
npx create-agent-gateway my-api
cd my-api
npm install
wrangler kv:namespace create KEYS                 # grab the id
# Update wrangler.toml with your KV id, CF account, and wallet address
wrangler secret put ADMIN_KEY                     # random 32-hex
wrangler secret put PAYMENT_RECIPIENT             # 0x... Base wallet
wrangler secret put CDP_API_KEY_ID                # optional; free x402.org fallback otherwise
wrangler secret put CDP_API_KEY_SECRET
wrangler deploy
```

## Structure

- `src/index.ts` — single-file Worker with all primitives. Replace `/v1/example` handler with your own paid endpoint(s).
- `wrangler.toml` — KV + Durable Object bindings.
- `package.json` — minimal; just wrangler + TS types.

## Extending

Add your paid endpoint:

```ts
async function handleMyTool(req, env) {
  const auth = await authAndCharge(req, env, PRICE_MCENTS.my_tool, "my_tool");
  if (auth instanceof Response) return auth;
  // ... your logic ...
  return json({ ok: true, balance_mcents: auth.record.balance_mcents });
}
```

Register it:

```ts
if (p === "/v1/mytool" && req.method === "POST") return handleMyTool(req, env);
```

Add it to the MCP manifest + Agent Skills index + add a scope constant if you want per-key access control.

## Reference implementation

See the full production code at [data-label-factory/agent-gateway](https://github.com/YOURORG/data-label-factory/tree/main/agent-gateway) — same skeleton, plus DLF-specific handlers for vision labeling, YOLO training, and image gather.

## License

MIT. Fork, remix, commercialize — just credit the pattern.
