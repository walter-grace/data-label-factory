---
license: apache-2.0
language:
  - en
library_name: data-label-factory
tags:
  - vision
  - dataset-labeling
  - object-detection
  - apple-silicon
  - mlx
  - gemma
  - falcon-perception
  - openrouter
  - yolo
pipeline_tag: image-feature-extraction
---

# data-label-factory

**Anyone asks for a vision model, we build it.** Give us a description and
optionally some sample images — the factory gathers data, labels it, verifies
quality, and exports a ready-to-train YOLO dataset.

```
"I need a stop sign detector"
    ↓
gather → filter → label → verify → export
 (DDG)   (VLM)   (Falcon) (VLM)   (YOLO)
    ↓
best.pt  ← custom YOLO model
```

## Two ways to use this

This repo ships **two product surfaces** on top of the same factory:

### 1. Pay-per-call agent API — for AI agents and developers

A Cloudflare-hosted gateway where strangers mint their own API keys with a crypto micropayment and call `/v1/{gather,label,train-yolo,predict}` directly. Every call debits `mcents` (1/1000¢). Designed for Claude Desktop / Cursor / cron-driven agents.

- **Live at**: https://data-label-factory.vercel.app/agents — claim a key
- **Walkthrough**: https://data-label-factory.vercel.app/how-it-works
- **Machine-readable**: https://dlf-gateway.nico-zahniser.workers.dev/llms.txt
- **MCP install manifest**: https://dlf-gateway.nico-zahniser.workers.dev/.well-known/mcp.json

**Onboarding flow:**
```
Agent → /v1/signup → HTTP 402 (x402) → pay 0.10 USDC on Base
      → Coinbase CDP verifies → mint dlf_<hex> key ($0.50 starter balance)
```

**Per-call pricing (live: `GET /v1/pricing`):**

| Tool | mcents | USD |
|------|--------|-----|
| `crawl` (per page) | 50 | $0.00050 |
| `gather` | 100 | $0.00100 |
| `label` (per image) | 200 | $0.00200 |
| `predict` (per image) | 20 | $0.00020 |
| `train-yolo` (per job) | 2000 | $0.02000 |

**MCP server** at `https://dlf-gateway.nico-zahniser.workers.dev/mcp` — drop into any MCP client with:
```json
{
  "mcpServers": {
    "data-label-factory": {
      "transport": "http",
      "url": "https://dlf-gateway.nico-zahniser.workers.dev/mcp",
      "headers": { "Authorization": "Bearer dlf_YOUR_KEY" }
    }
  }
}
```

8 tools available: `dlf_gather`, `dlf_label`, `dlf_crawl`, `dlf_train_yolo`, `dlf_train_status`, `dlf_balance`, `dlf_pricing`, `dlf_leaderboard`.

**Subfolders:**
- [`agent-gateway/`](./agent-gateway) — the Cloudflare Worker (KV-backed keys, Durable Object leaderboard, x402 signup with Coinbase CDP facilitator, scoped keys, refund policy, MCP server, Agent Readiness Level 4)
- [`agent-farm/`](./agent-farm) — cron Worker that runs 3 Gemma agents every 20 min so the public leaderboard stays alive
- [`agent-farm-think/`](./agent-farm-think) — same idea but rewritten on Cloudflare's Agents SDK (`agents@0.11`); each agent is a Durable Object with its own 20-min schedule and SQLite state
- [`create-agent-gateway/`](./create-agent-gateway) — in-tree mirror of the [create-mcpay](https://github.com/walter-grace/create-mcpay) scaffolder (standalone repo + HF Space at [waltgrace/create-mcpay](https://huggingface.co/spaces/waltgrace/create-mcpay))

### 2. Local CLI + Python package — for your own dataset

The original factory: run the pipeline on your own laptop or Mac Mini, mix-and-match backends, produce a YOLO dataset you train wherever you want. **No account, no keys, no gateway.**

Read on for the CLI flow ↓

---

## Quick Start (3 commands)

```bash
# 1. Install
git clone https://github.com/walter-grace/data-label-factory.git
cd data-label-factory
pip install .

# 2. Set your OpenRouter API key (free tier works)
export OPENROUTER_API_KEY=sk-or-...   # get one at https://openrouter.ai/keys

# 3. Run the full pipeline
data_label_factory pipeline \
  --project projects/stop-signs.yaml \
  --backend openrouter \
  --label-backend openrouter \
  --skip-gather \
  --limit 50
```

Output: a YOLO dataset in `experiments/latest/yolo_dataset/` with `data.yaml`, ready for:
```bash
yolo detect train model=yolo11n.pt data=experiments/latest/yolo_dataset/data.yaml epochs=50
```

---

## How it works

The pipeline runs 5 stages automatically:

| Stage | What it does | Default backend |
|-------|-------------|-----------------|
| **Gather** | Search DDG/Wikimedia/YouTube for images matching your queries | DuckDuckGo |
| **Filter** | VLM looks at each image: "Is this a {target}?" YES/NO | OpenRouter Gemma 4 |
| **Label** | Detection model draws bounding boxes on YES images | Falcon Perception / OpenRouter |
| **Verify** | VLM checks each bbox crop: "Is this actually a {target}?" | OpenRouter Gemma 4 |
| **Export** | Convert COCO annotations to YOLO format with train/val split | Built-in |

## Provider Registry (7 backends)

Mix and match per stage — swap any backend without changing your project:

| Backend | Filter | Label | Verify | Runs on |
|---------|--------|-------|--------|---------|
| `openrouter` | Y | Y | Y | Cloud (Gemma 4, Claude, GPT-4V, Llama, etc.) |
| `qwen` | Y | - | Y | Local Mac (Qwen 2.5-VL-3B, 2.5 GB) |
| `gemma` | Y | - | Y | Local Mac via Expert Sniper (Gemma 4 26B, 2.8 GB) |
| `falcon` | - | Y | - | Local Mac via mlx-vlm (Falcon Perception, 2.4 GB) |
| `chandra` | Y | Y | Y | Local/GPU (Chandra OCR 2 — documents, text, tables) |
| `wilddet3d` | - | Y | - | CUDA GPU (WildDet3D — 13K+ categories, 3D) |
| `flywheel` | Y | Y | - | Local (synthetic data with perfect ground truth) |

**Best combo for Mac Mini 16 GB:**
```bash
data_label_factory pipeline --project P \
  --backend gemma --label-backend falcon --verify-backend gemma
# Gemma 4 E4B (2 GB, 2.3s/img) + Falcon (2.4 GB, 11s/img) = ~4.5 GB total
```

**Best combo for speed (cloud):**
```bash
data_label_factory pipeline --project P \
  --backend openrouter --label-backend openrouter
# ~1-2s per image, pay-per-token via OpenRouter
```

---

## Create your own project

### Option A: Auto-generate from samples
```bash
data_label_factory auto --samples ~/my-images/ --description "fire hydrants"
# Creates projects/fire-hydrants.yaml automatically
```

### Option B: Write a YAML
```yaml
project_name: fire-hydrants
target_object: "fire hydrant"
data_root: ~/data-label-factory/fire-hydrants

buckets:
  positive/clear_view:
    queries: ["red fire hydrant", "yellow fire hydrant"]
  negative/other_objects:
    queries: ["mailbox", "parking meter"]
  background/empty:
    queries: ["empty city street"]

falcon_queries:
  - "fire hydrant"
  - "red metal post"

backends:
  filter: openrouter
  label: openrouter
  verify: openrouter
```

---

## CLI Commands

```bash
# Full pipeline (gather + filter + label + verify + YOLO export)
data_label_factory pipeline --project P --backend openrouter --label-backend openrouter

# Individual stages
data_label_factory gather   --project P --max-per-query 30
data_label_factory filter   --project P --backend openrouter --limit 20
data_label_factory label-v2 --project P --backend openrouter
data_label_factory verify   --project P --backend openrouter
data_label_factory export   --experiment latest --output yolo_dataset/

# Auto-create project from samples
data_label_factory auto --samples ~/imgs/ --description "fire hydrants"

# Benchmark backends or models
data_label_factory benchmark --run --project P --backends falcon,openrouter --limit 30
data_label_factory benchmark --models --project P --model-list "qwen,google/gemma-4-26b-a4b-it"
data_label_factory benchmark --score experiments/latest/

# Check what's available
data_label_factory providers
data_label_factory status

# Generate synthetic training data
data_label_factory generate --refs ~/card-pngs/ --output synth_data --scenes 500

# MCP server for AI agents
data_label_factory serve-mcp
```

---

## Web UI

```bash
# Start the Python API server
python3 -m data_label_factory.serve --port 8400

# Start the web UI
cd web && npm install && PORT=3030 npm run dev
```

| Route | What |
|-------|------|
| `/label` | Upload images, filter + label + ask AI with any backend |
| `/pipeline` | Auto-research: crawl websites → screenshot → label UI elements → train YOLO |
| `/canvas` | Review COCO-labeled datasets with bbox overlay |
| `/canvas/live` | Live video/webcam tracker with Falcon Perception |

---

## Optional: Local backends (Mac Mini)

### Falcon Perception (bbox labeling)
```bash
pip install mlx mlx-vlm
python3 falcon_server.py --model ~/models/falcon-perception-mlx --port 8501
# Set GEMMA_URL=http://localhost:8501 when running pipeline
```

### Gemma 4 E4B (filter/verify)
```bash
# Download: huggingface-cli download mlx-community/gemma-4-e4b-it-4bit --local-dir ~/models/gemma4-e4b-4bit
# Serve via Expert Sniper or mlx_vlm
```

### Qwen 2.5-VL (filter/verify)
```bash
pip install mlx-vlm
python3 -m mlx_vlm.server --model mlx-community/Qwen2.5-VL-3B-Instruct-4bit --port 8291
```

---

## Optional: GPU path via RunPod

For large runs (10K+ images):
```bash
pip install -e ".[runpod]"
export RUNPOD_API_KEY=rpa_xxxxxxxxxx
python3 -m data_label_factory.runpod pipeline \
    --project projects/drones.yaml --gpu L40S \
    --publish-to <you>/<dataset>
```

See [`data_label_factory/runpod/README.md`](data_label_factory/runpod/README.md).

---

## Optional: Open-set identification

For "which of N known items am I holding?" (1 image per class, no training):
```bash
pip install -e ".[identify]"
python3 -m data_label_factory.identify index --refs ~/my-cards/ --out my.npz
python3 -m data_label_factory.identify serve --index my.npz --refs ~/my-cards/
```

See [`data_label_factory/identify/README.md`](data_label_factory/identify/README.md).

---

## Proven results

| Dataset | Images | Bboxes | Verify rate | Quality |
|---------|--------|--------|-------------|---------|
| Stop signs (OpenRouter) | 11 | 43 | 100% | 98% pass |
| Stop signs (Falcon) | 11 | 64 | 72% | 56% pass |
| Drones (Falcon + RunPod) | 1,421 | 15,355 | 78% | — |

---

## Credits

- **Falcon Perception** by TII (Apache 2.0)
- **Gemma 4** by Google DeepMind (Apache 2.0)
- **Qwen 2.5-VL** by Alibaba (Apache 2.0)
- **MLX** by Apple ML Research (MIT)
- **mlx-vlm** by Prince Canuma (MIT)
- **OpenRouter** for cloud model access
- **Cloudflare** (Workers, Durable Objects, KV, AI Gateway, Browser Rendering) for the agent API
- **Coinbase CDP** for x402 payment facilitation
- **RunPod** for GPU serverless training + inference

---

## Agent API architecture

```
                                     ┌──────────────────────────────┐
 Agent (Claude / Cursor / cron)      │ 1. Onboarding — x402 signup  │
   │                                 │                              │
   │ 1. GET /agents (Vercel)         │ Agent → HTTP 402 w/ quote    │
   │ 2. POST /v1/signup              │ → pay 0.10 USDC on Base      │
   │ 3. HTTP 402 + payment quote     │ → Coinbase CDP verify+settle │
   │ 4. Sign USDC transfer           │ → mint dlf_<hex> key         │
   │ 5. Retry w/ X-PAYMENT header    │   + 50,000 mcents ($0.50)    │
   │ 6. Get dlf_<key> back           └──────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ 2. Cloudflare Worker — dlf-gateway.nico-zahniser.workers.dev     │
│ ┌────────────┬────────────┬────────────┬────────────┐            │
│ │ authAndChg │ scope check│ refund     │ MCP server │            │
│ │ debit mc   │ crawl/label│ 5xx→refund │ /mcp       │            │
│ │ award XP   │ train/pred │ cap 5/hr   │ JSON-RPC   │            │
│ └────────────┴────────────┴────────────┴────────────┘            │
│     ▲                                              ▲             │
│     │                                              │             │
│ ┌───┴─────────┐                       ┌────────────┴─────────┐   │
│ │ Workers KV  │                       │ Leaderboard DO       │   │
│ │ api keys    │                       │ race-free XP +       │   │
│ │ refunds_win │                       │ activity feed        │   │
│ │ weights(7d) │                       │ badges               │   │
│ └─────────────┘                       └──────────────────────┘   │
└──────┬──────────────┬───────────────┬──────────────┬─────────────┘
       │              │               │              │
       ▼              ▼               ▼              ▼
 ┌──────────┐  ┌──────────────┐  ┌─────────────┐  ┌────────────┐
 │ gather   │  │ label        │  │ train-yolo  │  │ predict    │
 │ Mac Mini │  │ AI Gateway → │  │ RunPod      │  │ RunPod     │
 │ DDG proxy│  │ OpenRouter   │  │ YOLOv8n GPU │  │ infer GPU  │
 │ (tunnel) │  │ Gemma vision │  │ serverless  │  │ weights=KV │
 └──────────┘  └──────────────┘  └─────────────┘  └────────────┘

 Background: dlf-agent-farm + dlf-agent-farm-think run 3 Gemma agents
 every 20 min against the same gateway, so the /v1/leaderboard and
 /v1/activity endpoints stay populated for the public /agents page.
```

### Key concepts

- **mcents** = 1/1000 of a cent. All pricing is in mcents so sub-cent calls are cheap and legible (a full label run = 200 mcents = $0.002). Balances stored as integers in KV.
- **x402** = the [x402 protocol](https://www.x402.org) — HTTP 402 Payment Required with a JSON quote; agent signs a USDC `transferWithAuthorization` and retries. No Stripe, no human in the loop. Coinbase CDP facilitator handles verify+settle on Base.
- **Scoped keys** — every API key has a `scopes: Scope[]` array. Undefined = all-access (backwards compat). Set `["label","read"]` to mint a labeling-only key. Enforced in `authAndCharge` before any charge happens.
- **Refund policy** — if OpenRouter 5xx's or the Vercel route returns `error: "Provider returned error"`, the gateway refunds the 200 mcents. Rate-capped at 5 refunds per key per hour so bad actors can't farm refunds with deliberately-broken URLs.
- **Race-free leaderboard** — Durable Object serializes all XP/activity writes. KV's eventual-consistency reads would cause double-counting under burst traffic; DO is the one source of truth.
- **Weights cache** — after train completes, the gateway fetches the 6 MB `.pt`, base64-encodes it, and stashes in KV under `weights_b64:<job_id>` with a 7-day TTL. Subsequent `predict` calls skip the 6 MB Vercel fetch.
- **Agent Readiness Level 4** — the gateway serves `/robots.txt` with Content Signals, `/llms.txt`, `/sitemap.xml`, `/.well-known/{api-catalog,mcp.json,agent-skills/index.json}`, and RFC 8288 `Link` headers so crawlers like `isitagentready.com` can auto-discover the API.

### Want to deploy your own?

```bash
cd agent-gateway
npm install
wrangler kv:namespace create KEYS                 # paste id into wrangler.toml
wrangler secret put ADMIN_KEY                     # random 32-hex
wrangler secret put PAYMENT_RECIPIENT             # 0x... Base wallet
wrangler secret put CDP_API_KEY_ID                # optional; x402.org used otherwise
wrangler secret put CDP_API_KEY_SECRET
wrangler deploy
```

Full setup + architectural decisions documented in [`agent-gateway/README.md`](./agent-gateway/README.md). The same skeleton, stripped of DLF-specific routes, is packaged as [create-mcpay](https://github.com/walter-grace/create-mcpay) — a reusable template for any pay-per-call agent API (`npx create-mcpay my-api`).
