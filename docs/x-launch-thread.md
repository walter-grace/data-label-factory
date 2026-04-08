# X launch thread — data-label-factory

A 6-tweet thread. Target: ML-Twitter, Apple-Silicon devs, dataset-builders.
Hook: "labeled 1.8k drone images on a 16 GB MacBook." Asset: canvas-demo.gif.

---

**1/ (the hook)**

I labeled 1,799 fiber-optic drone images on a 16 GB MacBook.

No GPU. No cloud. No labeling vendor.

One Python CLI + one YAML file + a 26-billion-parameter vision model streamed off the SSD.

Open-sourcing the whole pipeline today 🧵

[attach: canvas-demo.gif]

---

**2/ (what's in the box)**

`data-label-factory` is a generic auto-labeling pipeline for vision datasets.

You write a project YAML — `target_object: "fire hydrant"`, a few search queries, done — and run:

```
data_label_factory pipeline --project projects/fire-hydrants.yaml
```

Out the other end: a clean COCO dataset, reviewed in a browser.

---

**3/ (the pipeline)**

Four stages, all running locally on Apple Silicon:

```
gather → filter → label → verify → review
 (DDG)   (VLM)    (Falcon) (VLM)   (Canvas)
```

- **gather** — DuckDuckGo / Wikimedia / Openverse image search per bucket
- **filter** — image-level YES/NO classification (Qwen 2.5-VL or Gemma 4)
- **label** — bbox grounding via Falcon Perception (TII)
- **verify** — per-bbox YES/NO via the same VLM
- **review** — HTML5 Canvas web UI with hover/click/zoom/pan

---

**4/ (how it fits in 16 GB RAM)**

The trick is MLX Expert Sniper.

Gemma 4-26B is a Mixture-of-Experts model — only ~3 GB of weights are active per token. So instead of loading all 13 GB into RAM, we **stream cold experts off the SSD on demand**.

Resident set: ~3 GB Gemma + 1.5 GB Falcon = ~5 GB total.

You get 26B-param vision quality on a base-model M-series Mac.

---

**5/ (what we labeled)**

Reference run: detect fiber-optic-spool drones (the Ukraine-conflict kind).

- 1,421 images gathered from DDG + Wikimedia + Openverse
- 15,355 Falcon Perception bboxes generated
- 11,928 (78%) verified YES by Qwen 2.5-VL
- All reviewed in the canvas UI

Per-query Falcon↔Qwen agreement:
`cable spool` 88% · `quadcopter` 81% · `drone` 80%

---

**6/ (the canvas UI)**

The review tool is **pure HTML5 Canvas** — no SVG, no React-DOM bbox elements, just `ctx.drawImage` + `ctx.strokeRect` rendered every frame.

Drag to pan, scroll to zoom around the cursor, click a bbox to inspect, ←→ to step through 1,799 images.

[attach: canvas-demo.gif]

---

**7/ (the link)**

Repo: https://github.com/<USER>/data-label-factory
Reference dataset (1.8k drone images, COCO + verdicts): https://huggingface.co/datasets/<USER>/fiber-optic-drones

Reproduce in 5 commands:
```
git clone <repo>
cd data-label-factory && pip install pyyaml pillow requests
python3 -m mlx_vlm.server --model mlx-community/Qwen2.5-VL-3B-Instruct-4bit --port 8291
data_label_factory pipeline --project projects/stop-signs.yaml
cd web && PORT=3030 npm run dev   # http://localhost:3030/canvas
```

Built on @MLX_apple, @PrinceCanuma's mlx-vlm, Falcon Perception by @TIIuae, and Gemma 4 by @GoogleDeepMind. Apache 2.0 all the way down.

---

## Notes for posting day

- Replace `<USER>` with the github org once chosen
- Confirm HF dataset card exists before posting tweet 7
- Pin tweet 1 to profile for the day
- Best post window: Tue/Wed 9-11am PT (ML-Twitter is most active)
- If engagement spikes, follow up with: a behind-the-scenes thread on the Expert Sniper streaming engine, OR a "label your own dataset in 10 minutes" tutorial
