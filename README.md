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
