# CLAUDE.md — instructions for Claude Code

This file gives Claude Code (and any other AI coding assistant) the context it
needs to help a user run, debug, and extend `data-label-factory`. If you're a
human reading this, you probably want [`README.md`](README.md) instead.

---

## What this repo is

`data-label-factory` is a **generic auto-labeling pipeline for vision datasets**
that runs entirely on a 16 GB Apple Silicon Mac. Pipeline stages:

```
gather → filter → label → verify → review
```

- **gather** — pulls images from DuckDuckGo, Wikimedia, Openverse, or YouTube
- **filter** — image-level YES/NO via a VLM (Qwen 2.5-VL or Gemma 4)
- **label** — bounding-box grounding via Falcon Perception
- **verify** — per-bbox YES/NO via the same VLM
- **review** — Next.js + HTML5 Canvas web UI in `web/`

The pipeline is **target-agnostic**. Object class is configured via a YAML in
`projects/`. The reference projects are `projects/drones.yaml` (fiber-optic
combat drones) and `projects/stop-signs.yaml` (smoke test).

---

## How to help the user get started

When a user points you at this repo, the first thing they need is to **install
the CLI and start a backend**. The flow:

```bash
# 1. Install the CLI (registers `data_label_factory` on PATH)
pip install -e .

# 2. Start a VLM backend. Recommend qwen as the default — it's smaller,
#    faster, and the gemma backend has known reliability issues for batch
#    YES/NO calls (see Known gotchas below).
pip install mlx-vlm
python3 -m mlx_vlm.server \
  --model mlx-community/Qwen2.5-VL-3B-Instruct-4bit \
  --port 8291

# 3. Verify the backend is reachable
data_label_factory status
```

Once `status` shows the backend is alive, the user can inspect a project and
run a tiny smoke test:

```bash
data_label_factory project --project projects/stop-signs.yaml
data_label_factory filter  --project projects/stop-signs.yaml --backend qwen --limit 5
```

If they want to label their own object class, copy `projects/stop-signs.yaml`,
edit `project_name`, `target_object`, `buckets`, and `falcon_queries`, then run
the full pipeline.

---

## CLI reference

```
data_label_factory <subcommand>

  status                       Check if backends (qwen, gemma) are alive
  project --project P          Print a project YAML for inspection
  gather  --project P          Search the web and download images per bucket
  filter  --project P          Image-level YES/NO classification (--backend qwen|gemma)
  label   --project P          Falcon Perception bbox grounding via mac_tensor
  pipeline --project P         Full chain: gather → filter (label/verify TBD)
  list                         Show timestamped experiment dirs
```

Common flags:
- `--backend qwen|gemma` (filter, pipeline) — overrides the project YAML
- `--limit N` (filter, label) — process at most N images, useful for smoke tests
- `--experiment NAME` — reuse an existing experiment dir instead of creating one
- `--max-per-query N` (gather, pipeline) — DDG can rate-limit above ~50

Every command writes a timestamped folder under `experiments/` (relative to
the user's CWD) with the config, prompts, raw model answers, and JSON outputs.

---

## Project YAML schema

A project YAML is the **only** thing a user writes to onboard a new object
class. Required fields:

```yaml
project_name: fire-hydrants                # used in experiment dir names
target_object: "fire hydrant"              # templated as {target_object} in prompts
description: |
  One-paragraph human description.
data_root: ~/data-label-factory/fire-hydrants

# Cloudflare R2 (optional — only used if you want to push images to cloud)
r2:
  bucket: my-bucket
  raw_prefix: raw/
  labels_prefix: labels/

# Gather plan: bucket → list of image-search queries
buckets:
  positive/clear_view:
    queries: ["red fire hydrant", "yellow fire hydrant"]
  negative/other_street_objects:
    queries: ["mailbox", "parking meter"]
  background/empty_streets:
    queries: ["empty city street"]

# What Falcon Perception will look for during the label stage
falcon_queries:
  - "fire hydrant"
  - "red metal post"

# Default backend per stage. CLI --backend overrides.
backends:
  filter: qwen
  label:  gemma
  verify: qwen
```

**Important rules when editing project YAMLs:**
- `falcon_queries` should be **visually grounded** — Falcon is a perception
  model, not a reasoner. "fire hydrant" works; "object representing emergency
  water access" doesn't.
- The `target_object` string is interpolated into all default prompts via
  Python's `str.format()`. Don't put curly braces in it.
- Buckets named `positive/*`, `negative/*`, `distractor/*`, `background/*`
  is convention, not enforced — but the gather/filter scripts treat them
  uniformly.

The full prompt templates live in `data_label_factory/project.py` under
`DEFAULT_PROMPTS`. Override per-project via a top-level `prompts:` section.

---

## Web UI (`web/`)

Next.js + Tailwind v4 + HTML5 Canvas. Two routes:

- `/` — older shadcn-based grid review with per-bbox approve/reject buttons
- `/canvas` — newer pure HTML5 Canvas viewer (drag to pan, scroll to zoom,
  click a bbox to inspect, ←→ to navigate). This is the recommended one.

To start it:

```bash
cd web
npm install            # first time only
PORT=3030 npm run dev
# open http://localhost:3030/canvas
```

The web UI reads labels from R2 by default. Configure credentials in
`web/.env.local` (see `web/.env.example`):

```
R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=your-bucket
```

If R2 isn't configured, the web UI will throw on startup with a clear error
message. **Never commit `.env.local`.** It's gitignored at both `web/.gitignore`
and the root `.gitignore`.

---

## Environment variables

| Var | Default | What |
|---|---|---|
| `QWEN_URL` | `http://localhost:8291` | Where the `mlx_vlm.server` lives |
| `QWEN_MODEL_PATH` | `mlx-community/Qwen2.5-VL-3B-Instruct-4bit` | Model id sent in OpenAI request |
| `GEMMA_URL` | `http://localhost:8500` | Where `mac_tensor` lives (also serves Falcon) |

These can be exported in the user's shell or set inline:

```bash
QWEN_URL=http://192.168.1.244:8291 data_label_factory status
```

---

## Optional GPU path

If a user has more than ~10k images and wants the run to finish in minutes
instead of an hour, point them at the RunPod path:

```bash
pip install -e ".[runpod]"
export RUNPOD_API_KEY=rpa_xxxxxxxxxx
python3 -m data_label_factory.runpod pipeline \
    --project projects/<theirs>.yaml --gpu L40S \
    --publish-to <user>/<dataset>
```

The runpod subpackage is opt-in — `data_label_factory` itself never imports
it, so users without `RUNPOD_API_KEY` are not affected. Full docs at
`data_label_factory/runpod/README.md`. **Always smoke-test with `--limit 5`
locally before kicking off a paid pod run.**

---

## Reference dataset

This pipeline produced [`waltgrace/fiber-optic-drones`](https://huggingface.co/datasets/waltgrace/fiber-optic-drones)
on Hugging Face — 2,260 images, 8,759 Falcon bboxes, 5,114 (58%) Qwen-verified,
five categories. If a user wants to compare their own labeling run against the
reference, they can `load_dataset("waltgrace/fiber-optic-drones")`.

A labels-only release (no pixels, Apache 2.0) is at
[`waltgrace/fiber-optic-drones-labels`](https://huggingface.co/datasets/waltgrace/fiber-optic-drones-labels).

---

## Known gotchas

1. **Gemma `/api/chat_vision` is unreliable for batch YES/NO prompts.** When
   the chained agent can't decide whether to call Falcon as a tool, it can
   stall or take 60+ seconds. **For `filter` and `verify`, prefer `--backend
   qwen`.** Gemma is rock solid for the `label` stage which uses `/api/falcon`
   directly — that path is independent of the chained agent.

2. **DDG image search rate-limits hard above ~100 results per query.** Use
   `--max-per-query 30` to 50 for safety. If you need more volume, lean on
   Wikimedia + YouTube frame extraction in `gather.py`.

3. **The generic `verify` subcommand is a TODO.** The original drone-specific
   `runpod_falcon/verify_vlm.py` (in the parent `auto-research/` workspace,
   not in this published repo) has the working implementation. The generic
   wrapper is pending a small refactor.

4. **The `gather` stage has optional dependencies.** If a user hits "module not
   found" for `duckduckgo_search` or `yt_dlp`, install the extras:
   `pip install -e ".[gather]"`.

5. **Falcon Perception requires `task="segmentation"`, NOT `task="detection"`.**
   This is hardcoded in the mac_tensor server, but worth knowing if a user
   asks why detection mode returns empty bboxes.

6. **macOS Screen Recording filenames sometimes contain non-breaking spaces
   (U+00A0)** instead of regular spaces. Use shell globs (`Screen*Recording*.mov`)
   instead of literal filenames if a user is feeding video into the pipeline.

---

## What NOT to do (safety rails)

- **Never commit `.env`, `.env.local`, `web/.env.local`, or any file containing
  R2 / HF / API credentials.** The `.gitignore` files block these by default;
  do not override.
- **Never push to GitHub or HF without explicit user permission.** Even if the
  user has authenticated with `gh` or `hf auth`. Always ask first.
- **Never run `data_label_factory pipeline` without `--limit N` first** for an
  unfamiliar project YAML. The full pipeline can run for hours and incur DDG
  rate limits or fill local disk.
- **Don't delete `experiments/` without checking first.** Each subdir has a
  `README.md` with the run config and may be the user's only record of a run.
- **Don't modify `pyproject.toml` versions or dependencies** without the user
  asking. The pinned versions are deliberate.

---

## Repo layout

```
data-label-factory/
├── README.md                           ← user-facing install + walkthrough
├── CLAUDE.md                           ← this file
├── pyproject.toml                      ← pip-installable, entry: data_label_factory
├── setup.py                            ← shim for older pip
├── data_label_factory/                 ← Python package
│   ├── __init__.py                     ← exports load_project, ProjectConfig
│   ├── cli.py                          ← main() with all subcommands
│   ├── project.py                      ← YAML loader + ProjectConfig + DEFAULT_PROMPTS
│   ├── experiments.py                  ← timestamped run dirs
│   └── gather.py                       ← image search (DDG/Wikimedia/YouTube)
├── projects/                           ← project YAMLs
│   ├── drones.yaml                     ← reference: fiber-optic drones
│   └── stop-signs.yaml                 ← smoke test: stop signs
└── web/                                ← Next.js review UI
    ├── app/canvas/page.tsx             ← canvas viewer (recommended)
    ├── app/page.tsx                    ← shadcn grid view
    ├── components/BboxCanvas.tsx       ← responsive HTML5 canvas component
    └── lib/r2.ts                       ← R2 credentials read from env vars
```

---

## When the user is stuck

Common questions and how to handle them:

| User says | Likely cause | What to do |
|---|---|---|
| "filter is hanging" | Gemma backend was selected and `/api/chat_vision` stalled | Switch to `--backend qwen` |
| "no images found" | Gather hit DDG rate limit, or `data_root` is wrong | Check `data_label_factory project --project P` for the resolved `data_root` and verify it matches what's on disk |
| "ImportError: No module named 'duckduckgo_search'" | Optional gather extra not installed | `pip install -e ".[gather]"` |
| "ConnectionRefusedError on 8291" | Qwen backend isn't running | Start it: `python3 -m mlx_vlm.server --model mlx-community/Qwen2.5-VL-3B-Instruct-4bit --port 8291` |
| "I want to label X" where X isn't in the references | Need a new project YAML | Copy `projects/stop-signs.yaml`, edit four fields, run `project` to inspect, then `pipeline --limit 10` to smoke test |
| "the canvas web UI shows blank" | R2 credentials not set in `web/.env.local` | Ask user for their R2 credentials, set them in `web/.env.local`, restart `npm run dev`. If they don't have R2, point them at the local image cache instead |

---

## Quick task recipes for Claude Code

When a user asks for one of these, here's the TL;DR:

**"Help me label fire hydrants"**
1. `cp projects/stop-signs.yaml projects/fire-hydrants.yaml`
2. Edit `project_name`, `target_object: "fire hydrant"`, the buckets/queries, and `falcon_queries`
3. `data_label_factory project --project projects/fire-hydrants.yaml` to verify
4. `data_label_factory gather --project projects/fire-hydrants.yaml --max-per-query 30`
5. `data_label_factory filter --project projects/fire-hydrants.yaml --backend qwen --limit 20` (smoke test)
6. If smoke test passes, drop `--limit` for the full run

**"Show me the dataset in a browser"**
1. Make sure R2 credentials are in `web/.env.local`
2. `cd web && npm install && PORT=3030 npm run dev`
3. Open http://localhost:3030/canvas

**"How do I check if my labels are good?"**
1. After running label + verify, look at `experiments/<latest>/verify_qwen/verified.json`
2. The `summary` block has `yes_rate` — anything below 50% means your Falcon
   queries are too noisy or your `target_object` is too narrow
3. Use the canvas web UI (`/canvas`) to spot-check rejected bboxes — if Qwen
   is rejecting things you'd accept, the prompt needs tuning in
   `data_label_factory/project.py:DEFAULT_PROMPTS`

**"Compare my run to the reference dataset"**
```python
from datasets import load_dataset
ref = load_dataset("waltgrace/fiber-optic-drones-labels", split="train")
# ref[i]["bboxes"] is a struct of lists, not a list of dicts
```
