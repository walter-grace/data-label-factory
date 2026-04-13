# data-label-factory v2: Expert Sniper Integration

**Date:** 2026-04-13
**Status:** Validated end-to-end on Mac Mini M4 16GB

## Summary

data-label-factory v2 adds a provider registry, new labeling backends, deterministic
verification metrics, a model benchmark system, and MCP server support. The core
advancement: any VLM model can now be swapped in for filter/verify stages, and the
system can be driven by AI agents via MCP.

Validated with **Expert Sniper** (Gemma 4 26B-A4B streaming from SSD) on a 16GB
Mac Mini, proving the full pipeline works with a large vision model at only 2.77 GB
resident memory.

## Architecture: v1 vs v2

### v1 (existing)
```
project.yaml → gather → filter(qwen|gemma) → label(falcon) → verify(qwen)
                                    ↑ hardcoded backends
```

### v2 (new)
```
auto(samples + description) → project.yaml
                                  ↓
              gather → filter → label → verify → benchmark
                  ↑        ↑       ↑       ↑         ↑
              flywheel  any VLM  falcon  any VLM  deterministic
                        provider  wild   provider    metrics
                        registry  det3d  registry
                                  chandra
```

## Provider Registry

All backends implement a common `Provider` interface with `filter_image()`,
`label_image()`, and `verify_bbox()` methods. New backends are added with a
single `@register_provider("name")` decorator.

| Provider | Filter | Label | Verify | Runs on | Notes |
|----------|--------|-------|--------|---------|-------|
| qwen | Y | - | Y | Mac (local) | Qwen 2.5-VL-3B, ~3.5s/img |
| gemma | Y | - | Y | Mac (Expert Sniper) | Gemma 4 26B via SSD streaming |
| openrouter | Y | - | Y | Cloud (any model) | Pay-per-token, hundreds of models |
| falcon | - | Y | - | Mac (local) | Falcon Perception 0.6B bbox grounding |
| chandra | Y | Y | Y | Mac or GPU | Chandra OCR 2 for text/documents |
| wilddet3d | - | Y | - | CUDA/RunPod | 13K+ categories, open-vocab |
| flywheel | Y | Y | - | Mac (local) | Synthetic data, perfect ground truth |

## Expert Sniper Test Results

**Hardware:** Mac Mini M4, 16 GB RAM, 512 GB SSD
**Model:** Gemma 4 26B-A4B (4-bit, 15 GB on SSD, 2.77 GB resident via expert streaming)
**Server:** mac_tensor `--vision` mode, port 8500

### Filter accuracy (stop-sign dataset, 157 images)

| Image type | Expected | Verdict | Time | Correct |
|-----------|----------|---------|------|---------|
| positive/clear_view | YES | YES | 60.5s | Y |
| negative/other_objects | NO | NO | 77.2s | Y |
| background/no_signs | NO | NO | 89.3s | Y |

### Verify accuracy

| Crop | Query | Verdict | Time | Correct |
|------|-------|---------|------|---------|
| [50,50,200,200] (sky) | stop sign | NO | 97.2s | Y (correctly rejected — crop shows sky + power lines) |

### Throughput

- **Expert Sniper (SSD streaming):** ~60-90s per image (26B model, experts paged from SSD)
- **Qwen 2.5-VL (in-memory):** ~3.5s per image (3B model, fully resident)
- **OpenRouter (cloud):** ~1-3s per image (depends on model, pay-per-token)

Expert Sniper trades speed for accuracy: a 26B model that fits in 2.77 GB of RAM.
For batch labeling, use Qwen or OpenRouter for filter/verify, then Expert Sniper
for difficult cases or final verification.

## Deterministic Metrics

v2 replaces LLM-as-judge verification with rule-based metrics (inspired by
ParseBench). Each bounding box is checked against 8 deterministic rules:

1. `non_degenerate` — w > 0 and h > 0
2. `within_image` — bbox inside image bounds
3. `min_area` — area >= 100 px^2
4. `max_area_ratio` — area <= 95% of image
5. `min_dimension` — w >= 5 px and h >= 5 px
6. `aspect_ratio` — w/h between 0.02 and 50
7. `edge_margin` — center not at image edge
8. `score_threshold` — detection confidence >= 0.1

Cross-backend comparison uses IoU matching to pair detections from two backends,
then reports precision, recall, F1, and per-category agreement.

## Model Benchmark

v2 can benchmark VLMs against each other on the same filter task:

```bash
data_label_factory benchmark --models \
    --project projects/stop-signs.yaml \
    --model-list "qwen,google/gemma-4-26b-a4b-it" \
    --limit 30
```

Output: per-model YES/NO rates, pairwise agreement, top disagreements.
Answers the question: "which VLM is best at filtering images for my dataset?"

## Auto Project Creation

Users provide sample images + a text description, and the system:
1. Analyzes samples via the best available VLM
2. Detects content type (document, object, card, 3D scene)
3. Picks optimal backends per stage
4. Generates search queries for the gather stage
5. Creates a complete project YAML

```bash
data_label_factory auto \
    --samples ~/my-samples/ \
    --description "fire hydrants in urban settings"
```

## MCP Server

The factory exposes 7 tools via MCP for AI agent integration:

| Tool | Description |
|------|-------------|
| label_dataset | Full pipeline: samples + description → labeled COCO dataset |
| create_project | Auto-generate project YAML |
| check_status | Which backends are alive |
| list_providers | Provider capabilities |
| score_results | Deterministic quality metrics on COCO file |
| benchmark | Compare two COCO files |
| generate_synthetic | Flywheel synthetic data generation |

## Flywheel Synthetic Data

The flywheel provider generates perfectly-labeled training data by compositing
reference images onto random backgrounds. Originally built for card games
(blackjack), generalized for any domain with reference image assets.

- Output: YOLO format + COCO format simultaneously
- Labels: ground truth (no detection needed)
- Speed: ~100+ scenes/second
- Use case: bootstrap training data, augment real datasets

## New CLI Commands

```bash
data_label_factory auto          # create project from samples
data_label_factory label-v2      # label via provider registry
data_label_factory benchmark     # compare backends or models
data_label_factory providers     # list registered providers
data_label_factory generate      # flywheel synthetic data
data_label_factory serve-mcp     # MCP server for agents
```

## Files Added

```
data_label_factory/
├── providers/
│   ├── __init__.py          # registry + Provider base class
│   ├── qwen.py              # Qwen 2.5-VL
│   ├── gemma.py             # Gemma 4 via Expert Sniper
│   ├── falcon.py            # Falcon Perception
│   ├── chandra.py           # Chandra OCR 2
│   ├── wilddet3d.py         # WildDet3D (CUDA)
│   ├── openrouter.py        # Any model via OpenRouter
│   └── flywheel.py          # Synthetic data generator
├── metrics.py               # deterministic bbox verification
├── benchmark.py             # v1 vs v2 comparison + model benchmark
├── auto.py                  # smart project creation
└── mcp.py                   # MCP server for AI agents
```

## Dependencies

Core (no change): `pyyaml`, `pillow`, `requests`

Optional extras:
- `[chandra]` — `chandra-ocr[hf]`, `transformers`
- `[wilddet3d]` — `torch`, `torchvision`, `einops`, `timm`
- `[mcp]` — `mcp`
- `[flywheel]` — `opencv-python`, `numpy`

## Falcon Perception on MLX

Falcon Perception is now running natively on MLX via `mlx-vlm` 0.4.4.

**Setup (Mac Mini M4):**
```bash
# Install Miniforge (user-local, no admin needed)
curl -fsSL https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-MacOSX-arm64.sh -o /tmp/miniforge.sh
bash /tmp/miniforge.sh -b -p ~/miniforge3

# Install mlx-vlm (latest, with falcon_perception + gemma4 support)
~/miniforge3/bin/pip install mlx mlx-vlm python-multipart

# Convert Falcon Perception weights to MLX format
~/miniforge3/bin/python3 -c "
from mlx_vlm import convert
convert('tiiuae/Falcon-Perception', '~/models/falcon-perception-mlx', trust_remote_code=True)
"

# Test
~/miniforge3/bin/python3 -c "
from mlx_vlm import load
model, processor = load('~/models/falcon-perception-mlx', trust_remote_code=True)
# model.generate_perception(processor, image=img, query='object', max_new_tokens=256)
"
```

**Result:** 18 detections on a stop-sign image (stop signs, signs, poles) in 42.8s.

**Important:** Requires Python 3.10+ (the HF model code uses `float | list` syntax).
The Mac Mini shipped with Python 3.9 — Miniforge provides 3.13 without needing admin.

## Web UI — Label Page

The web UI at `/label` provides a visual interface to the full pipeline.

### Quick Start

```bash
# Terminal 1: Start the Python API server
cd data-label-factory
GEMMA_URL=http://192.168.1.244:8500 python3 -m data_label_factory.serve --port 8400

# Terminal 2: Start the Next.js web UI
cd data-label-factory/web
npm install    # first time only
PORT=3030 npm run dev

# Open http://localhost:3030/label
```

### How to Use

1. **Check providers** — The status bar at the top shows which backends are alive
   (green = ready, gray = offline). Gemma + Falcon need the Expert Sniper running.

2. **Describe your target** — Type what you want to detect in the text field:
   `stop signs`, `fire hydrants`, `trading cards`, etc.

3. **Upload images** — Drag and drop images onto the upload area, or click to
   select files. Thumbnails appear in the center column.

4. **Pick backends** — Choose a filter backend (Gemma, Qwen, OpenRouter) and a
   label backend (Falcon, WildDet3D, Chandra, Flywheel) from the dropdowns.

5. **Filter All** — Click to run YES/NO classification on every image. Results
   appear as color-coded badges (green YES, red NO) with timing. The summary
   bar at the bottom shows counts and a progress bar.

6. **Label individual images** — Click the "Label" button on any image to run
   bbox detection. The canvas on the right draws color-coded bounding boxes
   with category labels and confidence scores.

7. **Review annotations** — Below the canvas, each detection shows:
   - Category name and confidence percentage
   - Pixel coordinates `[x, y, w, h]`
   - Quality pass rate from deterministic metrics (green = all rules pass)

### Architecture

```
Browser (localhost:3030/label)
    ↓ fetch
Next.js API route (/api/dlf)
    ↓ proxy
Python API server (localhost:8400)
    ↓ provider registry
Expert Sniper (192.168.1.244:8500)
    ├── Gemma 4 26B (filter/verify)
    └── Falcon Perception (label/bbox)
```

### Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `GEMMA_URL` | `http://localhost:8500` | Expert Sniper endpoint |
| `QWEN_URL` | `http://localhost:8291` | Qwen VLM endpoint |
| `OPENROUTER_API_KEY` | (none) | OpenRouter cloud models |
| `DLF_API_URL` | `http://localhost:8400` | Python API (for Next.js proxy) |
| `DLF_UPLOAD_DIR` | `/tmp/dlf-uploads` | Temp upload storage |

## What's Next

1. **Batch benchmark:** Run all 157 stop-sign images through Qwen vs Expert Sniper vs OpenRouter
2. **Pipeline v2 integration:** Wire `label-v2` into the full `pipeline` command
3. **Web UI improvements:** Live progress streaming, batch label, export COCO from UI
4. **Publish Falcon MLX weights:** Upload converted weights to HuggingFace so others skip the conversion step
