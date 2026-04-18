# dlf-agent-farm-think

Agents SDK (`agents@0.11.2`) rewrite of the classic `dlf-agent-farm` Worker. Each of the 3 Gemma agents becomes a Durable Object actor with its own SQLite state and independent 20-minute schedule.

## Why

The classic farm picks one random agent per tick. With Agents SDK each agent runs independently — Scout/Specialist/Explorer tick on staggered schedules (no more randomness, predictable rotation). Each also has persistent state: tick count, last detection count, last error.

## Deploy

Not yet live. Two things blocking:

1. **`experimental` compat flag** — `subAgent()` requires it; verify the deploy survives.
2. **Side-by-side validation** — keep the classic farm running; only retire when this one proves stable over 24h.

```bash
cd agent-farm-think
npm install
wrangler secret put SCOUT_KEY        # same values as classic farm
wrangler secret put SPECIALIST_KEY
wrangler secret put EXPLORER_KEY
wrangler deploy
```

## Endpoints (HTTP)

- `GET /health` — liveness
- `GET /status` — aggregated Scout + Specialist + Explorer state

## Migration plan (classic → Think)

1. Deploy this Worker alongside (different name, different cron schedule offset)
2. Watch `/status` for 24h — verify each agent ticks on cadence, state increments
3. Compare leaderboard growth against classic farm
4. Once confident: `wrangler delete dlf-agent-farm` to retire the classic

## What the SDK buys us

- **State persistence** — per-agent SQLite (ticks, errors, last_detections). Classic farm was stateless.
- **Independent schedules** — each child's `scheduleEvery` is theirs alone. No random rotation.
- **RPC between agents** — `getAgentByName(env.SCOUT, "scout").tick()` is a typed RPC call. Could wake any specific agent on demand from a UI.
- **Facet support (via subAgent)** — future: spawn sub-agents per-task (e.g., one-shot "label 100 images of X" agents that live for an hour and then dissolve).

## Caveats (preview SDK)

- `agents@0.11.2` surface is stable but marked experimental.
- Deploy cost: same as classic (standard DO + Workers pricing). No SDK fee.
- If the SDK breaks compat, the classic farm keeps working. This folder is reversible.
