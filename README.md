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
  - qwen
  - gemma
  - falcon-perception
pipeline_tag: image-feature-extraction
---

# data-label-factory

A generic auto-labeling pipeline for vision datasets. Pick any object class in
a YAML file, run one command, and end up with a clean COCO dataset reviewed in
a browser. Designed to run entirely on a 16 GB Apple Silicon Mac.

```
gather  →  filter  →  label  →  verify  →  review
 (DDG/   (VLM YES/   (Falcon  (VLM per-   (canvas
  yt)     NO)         bbox)    bbox)       UI)
```

Two interchangeable VLM backends:

| Backend | Model | Server | Pick when |
|---|---|---|---|
| `qwen` | Qwen 2.5-VL-3B 4-bit | `mlx_vlm.server` | You want fast YES/NO classification (~3.5s/img on M4) |
| `gemma` | Gemma 4-26B-A4B 4-bit | `mac_tensor` (Expert Sniper) | You want richer reasoning + grounded segmentation in one server |

The `label` stage always uses **Falcon Perception** for bbox grounding, served
out of `mac_tensor` alongside Gemma. Falcon doesn't depend on the VLM choice —
it's a separate ~600 MB model.

---

## What you get when this finishes

For our reference run on a fiber-optic-drone detector:

- **1421 source images** gathered from DuckDuckGo + Wikimedia + Openverse
- **15,355 Falcon Perception bboxes** generated via the `label` stage
- **11,928 / 15,355 (78%)** approved by Qwen 2.5-VL in the `verify` stage
- **Reviewed in a browser** via the canvas web UI (`web/`)

Per-query agreement between Falcon and Qwen on this dataset:
`cable spool` 88%, `quadcopter` 81%, `drone` 80%, `fiber optic spool` 57%.

You can reproduce all of this from this repo by following the steps below.

---

## 1. Install

```bash
# Clone
git clone https://github.com/walter-grace/data-label-factory.git
cd data-label-factory

# Install the CLI (registers `data_label_factory` on your $PATH)
pip install -e .

# (Optional) Add image-search dependencies for the `gather` stage
pip install -e ".[gather]"

# (Optional) Web UI deps — only if you want to review labels in a browser
cd web && npm install && cd ..
```

Or install straight from GitHub without cloning first:

```bash
pip install git+https://github.com/walter-grace/data-label-factory
```

The repo is also mirrored on Hugging Face at
[`waltgrace/data-label-factory`](https://huggingface.co/waltgrace/data-label-factory).
HF git serving doesn't play well with pip's partial-clone, so to install from
HF use a regular clone:

```bash
git clone https://huggingface.co/waltgrace/data-label-factory
cd data-label-factory && pip install -e .
```

The factory CLI needs Python 3.10+. The backend servers (Qwen and/or Gemma)
are installed separately — you only need the one(s) you plan to use.

---

## 2. Pick a backend and start it

### Option A — Qwen 2.5-VL (recommended for filter/verify)

```bash
# Install mlx-vlm (Apple Silicon)
pip install mlx-vlm

# Start the OpenAI-compatible server
python3 -m mlx_vlm.server \
  --model mlx-community/Qwen2.5-VL-3B-Instruct-4bit \
  --port 8291
```

Verify it's alive:

```bash
QWEN_URL=http://localhost:8291 data_label_factory status
```

### Option B — Gemma 4 + Falcon (recommended for `label`)

This is the [MLX Expert Sniper](https://github.com/walter-grace/mac-code) deploy
package. It serves Gemma 4-26B-A4B (chat / `--vision`) **and** Falcon Perception
(`--falcon`) from the same process at port 8500. Total ~5 GB resident on a 16 GB
Mac via SSD-streamed experts.

```bash
# Install + download model (one-time, ~13 GB)
git clone https://github.com/walter-grace/mac-code
cd mac-code/research/expert-sniper/distributed
pip install -e . mlx mlx-vlm fastapi uvicorn pillow huggingface_hub python-multipart

huggingface-cli download mlx-community/gemma-4-26b-a4b-it-4bit \
  --local-dir ~/models/gemma4-source
python3 split_gemma4.py \
  --input  ~/models/gemma4-source \
  --output ~/models/gemma4-stream

# Launch
python3 -m mac_tensor ui --vision --falcon \
  --stream-dir ~/models/gemma4-stream \
  --source-dir ~/models/gemma4-source \
  --port 8500
```

Verify:

```bash
GEMMA_URL=http://localhost:8500 data_label_factory status
```

You can run **both** servers at the same time. The factory CLI will use whichever
backend you select per command via `--backend qwen|gemma`.

---

## 3. Define a project

A project YAML is the *only* thing you need to write to onboard a new object
class. Two examples ship in `projects/`:

- [`projects/drones.yaml`](projects/drones.yaml) — fiber-optic drone detection (the original use case)
- [`projects/stop-signs.yaml`](projects/stop-signs.yaml) — minimal smoke test

Copy one and edit the four important fields:

```yaml
project_name:  fire-hydrants
target_object: "fire hydrant"            # templated into all prompts as {target_object}
data_root:     ~/data-label-factory/fire-hydrants

buckets:
  positive/clear_view:
    queries: ["red fire hydrant", "yellow fire hydrant", "fire hydrant on sidewalk"]
  negative/other_street_objects:
    queries: ["mailbox", "parking meter", "trash can"]
  background/empty_streets:
    queries: ["empty city street", "suburban sidewalk"]

falcon_queries:                          # what Falcon will look for during `label`
  - "fire hydrant"
  - "red metal post"

backends:
  filter: qwen                           # default per stage; CLI --backend overrides
  label:  gemma
  verify: qwen
```

Inspect a project before running anything:

```bash
data_label_factory project --project projects/fire-hydrants.yaml
```

---

## 4. Run the pipeline

The four stages can be run individually or chained:

```bash
PROJECT=projects/stop-signs.yaml

# 4a. Gather — image search across buckets
data_label_factory gather  --project $PROJECT --max-per-query 30

# 4b. Filter — image-level YES/NO via your chosen VLM
data_label_factory filter  --project $PROJECT --backend qwen

# 4c. Label — Falcon Perception bbox grounding (needs Gemma server up)
data_label_factory label   --project $PROJECT

# 4d. Verify — per-bbox YES/NO via your chosen VLM
#     (verify is a TODO in the generic CLI today; runpod_falcon/verify_vlm.py
#      is the original drone-specific impl that the generic version will wrap.)

# OR run gather → filter end-to-end:
data_label_factory pipeline --project $PROJECT --backend qwen
```

Every command writes a timestamped folder under `experiments/` (relative to
your current working directory) with the config, prompts, raw model answers,
and JSON outputs. List them with:

```bash
data_label_factory list
```

---

## 5. Review the labels in a browser

The `web/` directory is a Next.js + HTML5 Canvas review tool. It reads your
labeled JSON straight from R2 (or local — see `web/app/api/labels/route.ts`)
and renders the bboxes over each image with hover, click-to-select, scroll-zoom,
and keyboard navigation.

```bash
cd web
PORT=3030 npm run dev
# open http://localhost:3030/canvas
```

Features:
- **Drag** to pan, **scroll** to zoom around the cursor, **double-click** to reset
- **←/→** to navigate images, **click** a bbox to select it
- **Color coding**: per-query color, dashed red for VLM rejections, white outline for active
- **Bucket tabs** to filter by source bucket
- **Per-image query summary** with YES/NO counts

The grid view at `http://localhost:3030/` is the older shadcn-based browser
with thumbnail-grid + per-bbox approve/reject buttons.

---

## Configuration reference

### Environment variables

| Var | Default | What |
|---|---|---|
| `QWEN_URL` | `http://localhost:8291` | Where the `mlx_vlm.server` lives |
| `QWEN_MODEL_PATH` | `mlx-community/Qwen2.5-VL-3B-Instruct-4bit` | Model id sent in the OpenAI request |
| `GEMMA_URL` | `http://localhost:8500` | Where `mac_tensor` lives (also serves Falcon) |

Set them inline for one command, or `export` them in your shell.

### CLI flags

```
data_label_factory <command> [flags]

Commands:
  status                      Check both backends are alive
  project --project P         Print a project YAML for inspection
  gather  --project P         Search the web for images across buckets
  filter  --project P         Image-level YES/NO via Qwen or Gemma
  label   --project P         Falcon Perception bbox grounding
  pipeline --project P        gather → filter
  list                        Show experiments

Common flags:
  --backend qwen|gemma        Pick the VLM (filter, pipeline). Overrides project YAML.
  --limit N                   Process at most N images (smoke testing)
  --experiment NAME           Reuse an existing experiment dir
```

### Project YAML reference

See [`projects/drones.yaml`](projects/drones.yaml) for the canonical, fully
commented example. Required fields: `project_name`, `target_object`, `buckets`,
`falcon_queries`. Everything else has defaults.

---

## How big is this thing?

| Component | Disk | RAM (resident) |
|---|---|---|
| Factory CLI + Python deps | < 50 MB | negligible |
| Qwen 2.5-VL-3B 4-bit | ~2.2 GB | ~2.5 GB |
| Gemma 4-26B-A4B (Expert Sniper streaming) | ~13 GB on disk | ~3 GB |
| Falcon Perception 0.6B | ~1.5 GB | ~1.5 GB |
| Web UI dev server | ~300 MB node_modules | ~150 MB |
| **Total (Gemma + Falcon path)** | **~17 GB** | **~5 GB** |

Fits comfortably on a 16 GB Apple Silicon Mac.

---

## Known issues

1. **Gemma `/api/chat_vision` is unreliable for batch YES/NO prompts.** When the
   chained agent doesn't see a clear reason to call Falcon, it can stall. For the
   `filter` and `verify` stages, prefer `--backend qwen`. Gemma is rock solid for
   the `label` stage (which uses `/api/falcon` directly).
2. **The generic `verify` command is a TODO** — the original drone-specific
   `runpod_falcon/verify_vlm.py` works today, the generic wrapper is a small
   refactor still pending.
3. **Image search hits DDG rate limits** if you run with too high `--max-per-query`.
   30-50 per query is comfortable; beyond ~100 you'll see throttling.

---

## Credits

- **Falcon Perception** by TII — Apache 2.0
- **Gemma 4** by Google DeepMind — Apache 2.0
- **Qwen 2.5-VL** by Alibaba — Apache 2.0
- **MLX** by Apple Machine Learning Research — MIT
- **mlx-vlm** by Prince Canuma — MIT
- **MLX Expert Sniper** streaming engine by [walter-grace](https://github.com/walter-grace/mac-code)
