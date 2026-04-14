# CLAUDE.md — instructions for Claude Code

## What this repo is

`data-label-factory` is a **vision model factory**. Anyone asks for a custom
object detector — we gather data, label it, verify quality, and export a
ready-to-train YOLO dataset. One command, any object class.

```
"I need a stop sign detector"
    ↓
gather → filter → label → verify → export
 (DDG)   (VLM)   (Falcon) (VLM)   (YOLO)
    ↓
best.pt  ← custom YOLO model
```

## Quick start (help users get running)

```bash
# Install
pip install .

# Set OpenRouter key (easiest path — no local GPU needed)
export OPENROUTER_API_KEY=sk-or-...

# Run full pipeline
data_label_factory pipeline \
  --project projects/stop-signs.yaml \
  --backend openrouter \
  --label-backend openrouter \
  --skip-gather --limit 50

# Train YOLO on the output
yolo detect train model=yolo11n.pt data=experiments/latest/yolo_dataset/data.yaml epochs=50
```

## CLI reference

```
data_label_factory <command>

  # Core pipeline
  pipeline    Full chain: gather → filter → label → verify → export (YOLO)
  gather      Search DDG/Wikimedia/YouTube for images
  filter      Image-level YES/NO classification via VLM
  label       v1 Falcon bbox grounding via mac_tensor /api/falcon
  label-v2    Label via provider registry (any backend)
  verify      Per-bbox YES/NO verification via VLM
  export      Convert COCO annotations to YOLO training format

  # Project management
  auto        Create project YAML from samples + description
  project     Print a project YAML for inspection
  list        Show timestamped experiment dirs

  # Benchmarking
  benchmark   Compare backends (--run), VLM models (--models), or COCO files (--compare)
  providers   List registered providers and capabilities
  status      Check which backends are alive

  # Servers
  serve-mcp   Run as MCP server for AI agents (stdio)

  # Synthetic data
  generate    Flywheel synthetic data generation
```

### Key flags

```
--project P              Project YAML (required for most commands)
--backend B              VLM for filter/verify: openrouter, qwen, gemma, chandra
--label-backend B        Backend for bbox labeling: openrouter, falcon, wilddet3d, chandra, flywheel
--verify-backend B       Backend for per-bbox verification
--skip-gather            Use existing images (skip DDG search)
--limit N                Process at most N images (smoke testing)
--model-list M           For benchmark --models: comma-separated model IDs
```

## Provider registry (7 backends)

| Backend | Filter | Label | Verify | Where |
|---------|--------|-------|--------|-------|
| `openrouter` | Y | Y | Y | Cloud — any model (Gemma 4, Claude, GPT-4V) |
| `qwen` | Y | - | Y | Local Mac — Qwen 2.5-VL-3B (2.5 GB) |
| `gemma` | Y | - | Y | Local Mac — Gemma 4 via Expert Sniper (2.8 GB) |
| `falcon` | - | Y | - | Local Mac — Falcon Perception MLX (2.4 GB) |
| `chandra` | Y | Y | Y | Local/GPU — Chandra OCR 2 (documents/text) |
| `wilddet3d` | - | Y | - | CUDA GPU — 13K+ categories, open-vocab 3D |
| `flywheel` | Y | Y | - | Local — synthetic data, perfect ground truth |

## Project YAML

Only thing a user writes to onboard a new object class:

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
  label: falcon
  verify: openrouter
```

Or skip the YAML entirely — auto-generate from samples:
```bash
data_label_factory auto --samples ~/my-images/ --description "fire hydrants"
```

## Environment variables

| Var | Default | What |
|-----|---------|------|
| `OPENROUTER_API_KEY` | (none) | OpenRouter cloud VLM access |
| `OPENROUTER_MODEL` | `google/gemma-4-26b-a4b-it` | Default OpenRouter model |
| `QWEN_URL` | `http://localhost:8291` | Local Qwen VLM server |
| `GEMMA_URL` | `http://localhost:8500` | Local Expert Sniper / Falcon server |
| `DLF_API_URL` | `http://localhost:8400` | Python API server (for web UI) |

## Web UI

```bash
cd web && npm install && PORT=3030 npm run dev
```

| Route | What |
|-------|------|
| `/label` | Upload images, filter + label + ask AI (v2) |
| `/pipeline` | Auto-research: crawl websites → screenshot → label → train |
| `/canvas` | Review labeled COCO datasets with bbox overlay |
| `/canvas/live` | Live video tracker with Falcon Perception |

The `/label` page needs the Python API server running:
```bash
python3 -m data_label_factory.serve --port 8400
```

## Repo layout

```
data-label-factory/
├── data_label_factory/
│   ├── cli.py              ← main CLI with all subcommands
│   ├── project.py          ← YAML loader + ProjectConfig
│   ├── gather.py           ← image search (DDG/Wikimedia/YouTube)
│   ├── experiments.py      ← timestamped run dirs
│   ├── metrics.py          ← deterministic bbox verification (8 rules, IoU)
│   ├── benchmark.py        ← compare backends or VLM models
│   ├── auto.py             ← auto-generate project from samples + description
│   ├── export.py           ← COCO → YOLO format converter
│   ├── serve.py            ← FastAPI REST server for web UI
│   ├── mcp.py              ← MCP server for AI agents
│   ├── providers/
│   │   ├── __init__.py     ← registry + Provider base class
│   │   ├── qwen.py         ← Qwen 2.5-VL
│   │   ├── gemma.py        ← Gemma 4 via Expert Sniper
│   │   ├── falcon.py       ← Falcon Perception (bbox grounding)
│   │   ├── openrouter.py   ← Any model via OpenRouter API
│   │   ├── chandra.py      ← Chandra OCR 2 (documents)
│   │   ├── wilddet3d.py    ← WildDet3D (3D detection, CUDA)
│   │   └── flywheel.py     ← Synthetic data generator
│   ├── runpod/             ← optional GPU path
│   └── identify/           ← open-set CLIP retrieval (separate feature)
├── projects/
│   ├── drones.yaml         ← reference: fiber-optic drones
│   └── stop-signs.yaml     ← smoke test
├── research/               ← session notes + benchmarks
└── web/                    ← Next.js review + labeling UI
```

## Quick task recipes

**"I need to label X"**
```bash
data_label_factory auto --samples ~/samples/ --description "X"
data_label_factory pipeline --project projects/x.yaml --backend openrouter --skip-gather --limit 20
```

**"Compare two labeling backends"**
```bash
data_label_factory benchmark --run --project P --backends falcon,openrouter --limit 30
```

**"Which VLM is best for my dataset?"**
```bash
data_label_factory benchmark --models --project P \
  --model-list "qwen,google/gemma-4-26b-a4b-it,meta-llama/llama-4-scout" --limit 30
```

**"Score label quality"**
```bash
data_label_factory benchmark --score experiments/latest/
```

## Safety rails

- Never commit `.env.local` or API keys
- Never push to GitHub/HF without explicit permission
- Always smoke test with `--limit 10` before full runs
- Don't delete `experiments/` — each subdir is a run record
