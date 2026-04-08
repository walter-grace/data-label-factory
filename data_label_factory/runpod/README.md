# `data_label_factory.runpod` — optional GPU path

The default `data_label_factory` runs entirely on your local machine (Apple
Silicon Mac via MLX, or any machine with Python 3.10+). For most use cases
that's plenty: a 2,000-image dataset takes about an hour on an M4 Mini.

This subpackage is the **optional GPU path**. Use it when:

- You're labeling tens of thousands of images and don't want to wait
- You don't have a Mac to run MLX locally
- You want to amortize a one-off labeling job over a $0.50/hour pod
- You want the dataset published straight to Hugging Face when the run finishes

The runpod path produces **the same outputs** as the local path (COCO JSON +
verified verdicts). Same `data_label_factory pipeline` semantics, same project
YAML, same experiments folder layout. The only thing that changes is *where*
the GPU work happens.

---

## Architecture

```
Your machine                              RunPod GPU pod
─────────────                             ──────────────
runpod_factory up           ───────►      provision pod
runpod_factory push P.yaml  ───────►      copy project YAML + image manifest
runpod_factory run          ───────►      run data_label_factory pipeline
                                          ↳ pulls images from R2 / HF
                                          ↳ runs Falcon + Qwen on GPU
                                          ↳ writes COCO + verified.json
                            ◄───────      runpod_factory pull
                                          (downloads experiment dir back)
runpod_factory publish      ───────►      huggingface.co/<you>/<dataset>
runpod_factory down         ───────►      destroy pod
```

The pod runs the **exact same `data_label_factory` package** that runs on your
Mac — there's no rewriting. The Docker image just bundles the package + GPU
deps + a serverless `handler.py` for one-image-per-request usage.

You can use the runpod path in two modes:

| Mode | When | Cost shape |
|---|---|---|
| **Pod** (recommended for batches) | One large labeling run, e.g., 5,000 images | Pay per minute the pod is up. ~$0.30–$1.00/hour depending on GPU |
| **Serverless** (recommended for trickle traffic) | A web app that wants live labels | Pay per request. Cold starts ~30s on the first call |

---

## Quick start (pod mode)

```bash
# 0. install runpod extras
pip install -e ".[runpod]"

# 1. one-time: set your RunPod API key
export RUNPOD_API_KEY=rpa_xxxxxxxxxx

# 2. one-shot end-to-end (provisions pod, runs pipeline, pulls results, destroys pod)
python3 -m data_label_factory.runpod pipeline \
    --project projects/drones.yaml \
    --gpu L40S \
    --publish-to waltgrace/my-drone-dataset
```

That's it. When the command returns, your dataset is on Hugging Face and the
pod is destroyed. You will not be billed for idle time.

If you want finer control:

```bash
python3 -m data_label_factory.runpod up    --gpu L40S
python3 -m data_label_factory.runpod push  --project projects/drones.yaml
python3 -m data_label_factory.runpod run   --command "data_label_factory pipeline --project projects/drones.yaml"
python3 -m data_label_factory.runpod pull  --experiment latest
python3 -m data_label_factory.runpod publish --to waltgrace/my-drone-dataset
python3 -m data_label_factory.runpod down
```

## Quick start (serverless mode)

Serverless gives you a `https://api.runpod.ai/v2/<endpoint-id>/runsync` URL
that takes one image and returns one set of bboxes. Use this for a web app
that wants live labels rather than batch jobs.

```bash
# Build + push the worker image to a container registry
python3 -m data_label_factory.runpod build --tag yourname/dlf-worker:latest --push

# Create a serverless endpoint from that image
python3 -m data_label_factory.runpod serverless create \
    --image yourname/dlf-worker:latest \
    --gpu RTX_A4000 \
    --workers-min 0 \
    --workers-max 3

# Test it
python3 -m data_label_factory.runpod serverless test \
    --image-path test.jpg \
    --query "fiber optic drone"
```

The endpoint stays alive at `workersMin=0` (zero idle cost) and spins up a
worker on demand.

---

## What gets installed in the pod

The Dockerfile bakes:

- CUDA 12.8 + PyTorch 2.7
- The `data_label_factory` package (cloned from this repo at build time)
- `falcon-perception` (TII)
- `transformers`, `qwen-vl-utils` for the Qwen 2.5-VL backend
- `huggingface_hub` for dataset pushes
- `boto3` for Cloudflare R2 access (if you use R2 for image storage)
- `runpod` for the serverless handler

Image size is ~12 GB. First-time pod cold start is 5–8 minutes (image pull
dominates). Subsequent starts on the same volume are ~30 seconds.

---

## Cost expectations

Reference run (2,260 fiber-optic-drone images, 8,759 bboxes, 5 categories):

| Hardware | Wall time | Cost |
|---|---|---|
| M4 Mac Mini, local MLX | ~1 hour | $0 |
| RunPod L40S (community) | ~6 minutes | ~$0.06 |
| RunPod RTX A4000 (community) | ~12 minutes | ~$0.05 |
| RunPod RTX 4090 (secure) | ~5 minutes | ~$0.10 |

For the canonical 2,260-image run, the GPU path costs about a nickel and
finishes in the time it takes to make coffee. For 50,000+ image runs the
math gets much more interesting in the GPU's favor.

---

## Files in this folder

```
runpod/
├── README.md             ← you are here
├── __init__.py
├── cli.py                ← `python3 -m data_label_factory.runpod`
├── handler.py            ← serverless worker entry point
├── Dockerfile            ← worker image
├── pod_entrypoint.sh     ← what the pod runs on startup
└── requirements-pod.txt  ← pod-side python deps (separate from local install)
```

---

## Known gotchas (read this before you provision a pod)

1. **You will pay even if the pipeline crashes.** Always smoke-test with
   `--limit 5` locally before kicking off a multi-thousand-image run on a
   pod. The CLI does not babysit failed pods.
2. **RunPod community pods can take 5+ minutes to start** because of image
   pulls. Use secure cloud (more expensive) if you need < 1 minute startup.
3. **`falcon-perception` PyPI requires `torch>=2.11`** as a *soft* pin.
   It actually works with `torch 2.9+cu129`. If you hit version conflicts,
   force the install: `pip install falcon-perception --no-deps`.
4. **The handler keeps the model loaded between requests** (cold start once
   per worker). If you serverless-deploy, the FIRST request will be slow
   (~30s); subsequent requests on the same warm worker are ~2s.
5. **Don't put your `RUNPOD_API_KEY` in any committed file.** It belongs in
   `~/.runpod/config.json` (the SDK reads it automatically) or as an env var.
6. **Use a network volume** if you want images to persist across pod
   destruction. Without it, your gathered images get nuked when the pod
   terminates. The CLI creates one for you under `--volume-name dlf-data`.

---

## Status

- **Pod mode CLI**: implemented (`up`, `push`, `run`, `pull`, `publish`, `down`, `pipeline`)
- **Serverless mode CLI**: implemented (`build`, `serverless create/test/destroy`)
- **Dockerfile**: written, NOT yet tested in CI (build it locally and report bugs!)
- **Handler**: tested locally with mock input, NOT yet deployed end-to-end on real RunPod GPUs

Treat this as a **v0** that you should sanity-check on your own RunPod account
before relying on it for production work. PRs welcome.
