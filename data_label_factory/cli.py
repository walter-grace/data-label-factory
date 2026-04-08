#!/usr/bin/env python3
"""
data_label_factory — generic data labeling pipeline driven by a project YAML.

Same architecture as drone_factory but TARGET-AGNOSTIC. Pick any object class,
write a project YAML, run the same pipeline. Drones, stop signs, fire hydrants,
manufacturing defects — same scripts, different config.

Subcommands:
    status              check M4 backends are alive
    gather              DDG image search → local cache (uses project bucket queries)
    filter              image-level YES/NO classification
    label               Falcon Perception bbox grounding (or Qwen if config says so)
    verify              per-bbox YES/NO classification
    pipeline            full chain: gather → filter → label → verify
    list                list experiments
    show <experiment>   show experiment details
    project             dump a project YAML for inspection

Usage:
    # Inspect a project config
    data_label_factory project --project projects/drones.yaml

    # Run the entire pipeline for a project
    data_label_factory pipeline --project projects/stop-signs.yaml --max-per-query 20

    # Just gather (no labeling)
    data_label_factory gather --project projects/drones.yaml --max-per-query 30

    # Filter a specific experiment
    data_label_factory filter --project projects/drones.yaml --experiment latest
"""

import argparse
import base64
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))

from .project import load_project, ProjectConfig
from .experiments import (
    make_experiment_dir, write_readme, write_config,
    update_latest_symlink, list_experiments,
)


# ============================================================
# CONFIG — overridable via environment variables
# ============================================================
#
# Users pick a VLM backend at runtime via --backend qwen|gemma.
#
#   qwen   → Qwen 2.5-VL via mlx_vlm.server      (default URL: http://localhost:8291)
#   gemma  → Gemma 4 via mac_tensor              (default URL: http://localhost:8500)
#
# Falcon Perception (bbox grounding for `label`) is bundled with mac_tensor and
# is always reached via the GEMMA_URL regardless of which VLM you picked for
# the chat-style YES/NO stages.
#
# Override URLs via env vars when running against a remote machine, e.g.:
#   QWEN_URL=http://10.0.0.5:8291 data_label_factory filter --project ...

QWEN_URL = os.environ.get("QWEN_URL", "http://localhost:8291")
QWEN_MODEL_PATH = os.environ.get(
    "QWEN_MODEL_PATH", "mlx-community/Qwen2.5-VL-3B-Instruct-4bit"
)
GEMMA_URL = os.environ.get("GEMMA_URL", "http://localhost:8500")

VALID_BACKENDS = ("qwen", "gemma")


# ============================================================
# BACKEND CLIENTS (reused)
# ============================================================


def call_qwen(image_path: str, prompt: str, timeout: int = 60) -> tuple:
    from PIL import Image
    img = Image.open(image_path).convert("RGB")
    if max(img.size) > 1024:
        ratio = 1024 / max(img.size)
        img = img.resize((int(img.size[0]*ratio), int(img.size[1]*ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    payload = {
        "model": QWEN_MODEL_PATH,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            {"type": "text", "text": prompt},
        ]}],
        "max_tokens": 32, "temperature": 0,
    }
    req = urllib.request.Request(
        f"{QWEN_URL}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    return data["choices"][0]["message"]["content"].strip(), time.time() - t0


def call_gemma(image_path: str, prompt: str, timeout: int = 300, max_tokens: int = 64) -> tuple:
    """Hit mac_tensor /api/chat_vision with multipart + parse SSE.
    Returns (final_text, elapsed_seconds)."""
    boundary = f"----factory{int(time.time()*1000)}"
    body = io.BytesIO()
    def part(name, value, filename=None, content_type=None):
        body.write(f"--{boundary}\r\n".encode())
        if filename:
            body.write(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode())
            body.write(f'Content-Type: {content_type or "application/octet-stream"}\r\n\r\n'.encode())
            body.write(value)
            body.write(b"\r\n")
        else:
            body.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
            body.write(str(value).encode())
            body.write(b"\r\n")
    with open(image_path, "rb") as f:
        img_bytes = f.read()
    part("message", prompt)
    part("max_tokens", str(max_tokens))
    part("image", img_bytes, filename=os.path.basename(image_path), content_type="image/jpeg")
    body.write(f"--{boundary}--\r\n".encode())

    req = urllib.request.Request(
        f"{GEMMA_URL}/api/chat_vision",
        data=body.getvalue(),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    t0 = time.time()
    chunks = []
    final_text = ""
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for line in resp:
            line = line.rstrip(b"\r\n")
            if not line.startswith(b"data:"):
                continue
            try:
                event = json.loads(line[len(b"data:"):].strip())
            except Exception:
                continue
            etype = event.get("type")
            if etype == "token":
                chunks.append(event.get("text", ""))
            elif etype == "final":
                final_text = event.get("text", "")
                break
            elif etype == "done":
                break
    text = (final_text or "".join(chunks)).strip()
    return text, time.time() - t0


def call_vlm(backend: str, image_path: str, prompt: str, timeout: int = 120) -> tuple:
    """Backend-agnostic chat call. Returns (text, elapsed_seconds).
    Raises ValueError on unknown backend."""
    if backend == "qwen":
        return call_qwen(image_path, prompt, timeout=timeout)
    if backend == "gemma":
        return call_gemma(image_path, prompt, timeout=timeout)
    raise ValueError(f"unknown backend {backend!r}; valid: {VALID_BACKENDS}")


def resolve_backend(args, proj: ProjectConfig, stage: str) -> str:
    """CLI flag wins over project YAML; project YAML wins over default 'qwen'."""
    cli = getattr(args, "backend", None)
    if cli:
        if cli not in VALID_BACKENDS:
            raise SystemExit(f"--backend must be one of {VALID_BACKENDS}, got {cli!r}")
        return cli
    backend = proj.backend_for(stage)
    if backend not in VALID_BACKENDS:
        # project specifies "pod" or other legacy value — fall back to qwen
        return "qwen"
    return backend


def call_falcon_m4(image_path: str, query: str, timeout: int = 120) -> dict:
    """Hit mac_tensor /api/falcon (direct, no chained agent). Returns parsed JSON."""
    boundary = f"----factory{int(time.time()*1000)}"
    body = io.BytesIO()
    def part(name, value, filename=None, content_type=None):
        body.write(f"--{boundary}\r\n".encode())
        if filename:
            body.write(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode())
            body.write(f'Content-Type: {content_type or "application/octet-stream"}\r\n\r\n'.encode())
            body.write(value)
            body.write(b"\r\n")
        else:
            body.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
            body.write(str(value).encode())
            body.write(b"\r\n")
    with open(image_path, "rb") as f:
        img_bytes = f.read()
    part("query", query)
    part("image", img_bytes, filename=os.path.basename(image_path), content_type="image/jpeg")
    body.write(f"--{boundary}--\r\n".encode())

    req = urllib.request.Request(
        f"{GEMMA_URL}/api/falcon",
        data=body.getvalue(),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    data["_elapsed_seconds"] = time.time() - t0
    return data


def parse_yes_no(text: str) -> str:
    t = text.strip().upper()
    first = t.split()[0].rstrip(".,") if t else ""
    if "YES" in first: return "YES"
    if "NO" in first: return "NO"
    if "YES" in t: return "YES"
    if "NO" in t: return "NO"
    return "UNKNOWN"


# ============================================================
# COMMANDS
# ============================================================


def cmd_status(args):
    print("=" * 60)
    print("Backend status")
    print("=" * 60)
    print(f"  QWEN_URL  = {QWEN_URL}   (override with env QWEN_URL)")
    print(f"  GEMMA_URL = {GEMMA_URL}  (override with env GEMMA_URL)")
    for name, url, info_path in [
        ("Qwen2.5-VL (mlx_vlm.server)", QWEN_URL, "/v1/models"),
        ("Gemma 4 + Falcon (mac_tensor)", GEMMA_URL, "/api/info"),
    ]:
        print(f"\n  {name}")
        print(f"  {url}")
        try:
            with urllib.request.urlopen(f"{url}{info_path}", timeout=5) as r:
                data = json.loads(r.read())
            print(f"  ✓ alive: {json.dumps(data)[:200]}")
        except Exception as e:
            print(f"  ✗ DOWN: {e}")


def cmd_project(args):
    """Print a project config for inspection."""
    proj = load_project(args.project)
    print("=" * 60)
    print(f"Project: {proj.project_name}")
    print("=" * 60)
    print(f"  target_object:  {proj.target_object!r}")
    print(f"  description:    {proj.description.strip()}")
    print(f"  data_root:      {proj.local_image_dir()}")
    print(f"  r2_bucket:      {proj.r2_bucket}")
    print(f"  r2 raw prefix:  {proj.r2_raw_prefix}")
    print(f"  r2 labels:      {proj.r2_labels_prefix}")
    print(f"\n  buckets ({len(proj.bucket_queries)}):")
    for b, qs in proj.bucket_queries.items():
        print(f"    {b:40s} {len(qs)} queries")
    print(f"\n  falcon_queries: {proj.falcon_queries}")
    print(f"  backends:       {proj.backends}")
    print(f"  total_queries:  {proj.total_query_count()}")
    print(f"\n  Filter prompt preview:")
    for line in proj.prompt("filter").split("\n")[:6]:
        print(f"    {line}")


def resolve_experiment(name_or_latest: str) -> str:
    base = "experiments"
    if name_or_latest == "latest":
        link = os.path.join(base, "latest")
        if os.path.islink(link):
            return os.path.abspath(os.path.realpath(link))
        exps = list_experiments(base)
        if exps:
            return exps[0]["path"]
        raise FileNotFoundError("no experiments found")
    full = os.path.join(base, name_or_latest)
    if os.path.exists(full):
        return os.path.abspath(full)
    for e in list_experiments(base):
        if name_or_latest in e["name"]:
            return e["path"]
    raise FileNotFoundError(f"experiment '{name_or_latest}' not found")


def cmd_gather(args):
    """Run gather_v2 once per bucket from the project's bucket_queries."""
    proj = load_project(args.project)
    print(f"Gathering for project: {proj.project_name}")
    print(f"  target: {proj.target_object}")
    print(f"  data_root: {proj.local_image_dir()}")
    print(f"  buckets: {len(proj.bucket_queries)}")

    # Make experiment dir if not given
    exp_name = args.experiment or f"gather-{proj.project_name}"
    exp_dir = make_experiment_dir(exp_name)
    write_readme(exp_dir, exp_name,
                 description=f"Gather for {proj.project_name} ({proj.target_object})",
                 params=vars(args))
    write_config(exp_dir, {"project": proj.raw, **vars(args)})
    update_latest_symlink(exp_dir)
    print(f"Experiment: {exp_dir}")

    env = os.environ.copy()
    env["EXPERIMENT_DIR"] = exp_dir

    summary = []
    for bucket, queries in proj.bucket_queries.items():
        print(f"\n[{bucket}] {len(queries)} queries")
        cmd = [
            sys.executable, os.path.join(HERE, "gather.py"),
            "--out", proj.local_image_dir(),
            "--bucket", bucket,
            "--max-per-query", str(args.max_per_query),
            "--workers", str(args.workers),
        ]
        for q in queries:
            cmd += ["--query", q]
        t0 = time.time()
        try:
            result = subprocess.run(cmd, env=env, capture_output=True, text=True, check=True)
            print(result.stdout.strip().split("\n")[-2:][0] if result.stdout else "")
        except subprocess.CalledProcessError as e:
            print(f"  FAILED: {e.stderr[-300:]}")
        summary.append({"bucket": bucket, "elapsed": round(time.time() - t0, 1)})

    print(f"\nDONE — {sum(s['elapsed'] for s in summary):.0f}s total")


def cmd_filter(args):
    """Run image-level YES/NO classification on all images for a project.
    Backend chosen via --backend (qwen|gemma) or project YAML."""
    proj = load_project(args.project)
    backend = resolve_backend(args, proj, "filter")

    img_root = proj.local_image_dir()
    if not os.path.exists(img_root):
        print(f"  no images at {img_root}; run gather first")
        return

    images = []
    for root, _, names in os.walk(img_root):
        for n in names:
            if n.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                full = os.path.join(root, n)
                rel = os.path.relpath(full, img_root)
                parts = rel.split("/")
                if len(parts) < 2:
                    continue
                images.append(("/".join(parts[:2]), rel, full))
    if args.limit > 0:
        images = images[:args.limit]

    prompt = proj.prompt("filter")
    backend_label = {"qwen": "Qwen 2.5-VL", "gemma": "Gemma 4"}[backend]
    print(f"Filtering {len(images)} images via {backend_label}...")
    print(f"  prompt: {prompt[:120]}...")

    results = []
    counts = {"YES": 0, "NO": 0, "UNKNOWN": 0, "ERROR": 0}
    t0 = time.time()
    for i, (bucket, rel, full) in enumerate(images, 1):
        try:
            answer, elapsed = call_vlm(backend, full, prompt)
            verdict = parse_yes_no(answer)
        except Exception as e:
            answer, elapsed, verdict = f"ERROR: {e}", 0, "ERROR"
        counts[verdict] += 1
        results.append({
            "image_path": rel, "bucket": bucket, "verdict": verdict,
            "raw_answer": answer[:120], "elapsed_seconds": round(elapsed, 3),
        })
        if i % 10 == 0 or i == len(images):
            elapsed_total = time.time() - t0
            rate = i / max(elapsed_total, 1)
            eta = (len(images) - i) / max(rate, 0.001) / 60
            print(f"  [{i:4d}/{len(images)}] YES={counts['YES']} NO={counts['NO']} ERR={counts['ERROR']}  ETA {eta:.0f} min")

    # Save to a fresh experiment dir
    exp_name = args.experiment or f"filter-{proj.project_name}"
    exp_dir = resolve_experiment(args.experiment) if args.experiment else make_experiment_dir(exp_name)
    out_dir = os.path.join(exp_dir, f"filter_{backend}")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "keep_list.json")
    with open(out_path, "w") as f:
        json.dump({"backend": backend, "project": proj.project_name,
                   "counts": counts, "results": results}, f, indent=2)
    print(f"\nSaved {out_path}")
    print(f"  YES rate: {counts['YES']/max(1,len(images)):.0%}")


def cmd_label(args):
    """Label all images via M4 /api/falcon (one POST per image per query).
    Saves COCO-format annotations to <experiment>/label_falcon/<project>.coco.json.
    """
    proj = load_project(args.project)
    img_root = proj.local_image_dir()
    if not os.path.exists(img_root):
        print(f"  no images at {img_root}; run gather first")
        return

    images = []
    for root, _, names in os.walk(img_root):
        for n in names:
            if n.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                full = os.path.join(root, n)
                rel = os.path.relpath(full, img_root)
                if "/" not in rel:
                    continue
                images.append((rel.split("/", 1)[0], rel, full))
    if args.limit > 0:
        images = images[:args.limit]
    print(f"Labeling {len(images)} images x {len(proj.falcon_queries)} Falcon queries each")
    print(f"  queries: {proj.falcon_queries}")

    # COCO accumulator
    coco = {
        "info": {
            "description": f"data_label_factory run for {proj.project_name}",
            "date_created": datetime.now().isoformat(timespec="seconds"),
            "target_object": proj.target_object,
        },
        "images": [],
        "annotations": [],
        "categories": [
            {"id": i+1, "name": q, "supercategory": "object"}
            for i, q in enumerate(proj.falcon_queries)
        ],
    }
    cat_id = {q: i+1 for i, q in enumerate(proj.falcon_queries)}
    next_img_id, next_ann_id = 1, 1
    n_with_dets = 0
    n_total_dets = 0
    t0 = time.time()

    for i, (bucket, rel, full) in enumerate(images, 1):
        try:
            from PIL import Image
            im = Image.open(full)
            iw, ih = im.size
        except Exception as e:
            print(f"  skip {rel}: load fail {e}")
            continue
        img_id = next_img_id
        next_img_id += 1
        coco["images"].append({"id": img_id, "file_name": rel, "width": iw, "height": ih, "bucket": bucket})

        img_dets = 0
        for q in proj.falcon_queries:
            try:
                resp = call_falcon_m4(full, q, timeout=180)
                masks = resp.get("masks", [])
            except Exception as e:
                masks = []
                print(f"    {rel} [{q}]: error {str(e)[:80]}")
            for m in masks:
                bb = m.get("bbox_norm") or {}
                if not bb:
                    continue
                x1 = bb.get("x1", 0) * iw
                y1 = bb.get("y1", 0) * ih
                x2 = bb.get("x2", 0) * iw
                y2 = bb.get("y2", 0) * ih
                w = max(0, x2 - x1)
                h = max(0, y2 - y1)
                coco["annotations"].append({
                    "id": next_ann_id, "image_id": img_id,
                    "category_id": cat_id[q],
                    "bbox": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                    "area": round(w * h, 2), "iscrowd": 0,
                    "score": float(m.get("area_fraction", 1.0)),
                })
                next_ann_id += 1
                img_dets += 1

        if img_dets > 0:
            n_with_dets += 1
        n_total_dets += img_dets

        if i % 5 == 0 or i == len(images):
            elapsed = time.time() - t0
            rate = i / max(elapsed, 1)
            eta = (len(images) - i) / max(rate, 0.001) / 60
            print(f"  [{i:4d}/{len(images)}] hit={n_with_dets} dets={n_total_dets} ETA {eta:.0f} min")

    # Save COCO
    exp_dir = resolve_experiment(args.experiment) if args.experiment else make_experiment_dir(f"label-m4-{proj.project_name}")
    out_dir = os.path.join(exp_dir, "label_falcon")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{proj.project_name}.coco.json")
    with open(out_path, "w") as f:
        json.dump(coco, f, indent=2)
    print(f"\nSaved {out_path}")
    print(f"  {len(coco['images'])} images, {len(coco['annotations'])} bboxes")


def cmd_pipeline(args):
    """Full pipeline: gather → filter for the project."""
    proj = load_project(args.project)
    print("=" * 70)
    print(f"PIPELINE — {proj.project_name} ({proj.target_object})")
    print("=" * 70)

    exp = make_experiment_dir(f"pipeline-{proj.project_name}")
    write_readme(exp, f"pipeline-{proj.project_name}",
                 description=f"Full pipeline for {proj.target_object}",
                 params=vars(args))
    write_config(exp, {"project": proj.raw, **vars(args)})
    update_latest_symlink(exp)
    print(f"Experiment: {exp}\n")

    # 1. Gather
    print(">>> GATHER")
    args.experiment = os.path.basename(exp).split("_", 2)[-1]
    cmd_gather(args)

    # 2. Filter
    print("\n>>> FILTER")
    args.experiment = os.path.basename(exp)
    cmd_filter(args)

    # Label + verify TBD via pod or qwen — skipping in this MVP
    print("\n>>> LABEL + VERIFY: skipped in MVP — use drone_factory pod path or extend")
    print(f"\nPIPELINE DONE — {exp}")


def cmd_list(args):
    print("=" * 60)
    print("Experiments")
    print("=" * 60)
    for e in list_experiments():
        cfg = e.get("config", {})
        proj = (cfg.get("project") or {}).get("project_name", cfg.get("backend", "?"))
        print(f"  {e['name']:50s}  project={proj}")


# ============================================================
# MAIN
# ============================================================


def main():
    p = argparse.ArgumentParser(
        prog="data_label_factory",
        description=(
            "Generic data labeling pipeline. Pick any object class via a "
            "project YAML, then run: gather → filter → label → verify. "
            "Choose your VLM backend with --backend qwen|gemma."
        ),
    )
    sub = p.add_subparsers(dest="command", required=True)

    def add_backend_flag(parser):
        parser.add_argument(
            "--backend",
            choices=VALID_BACKENDS,
            default=None,
            help=("VLM backend for chat-style stages (filter, verify). "
                  "Overrides the project YAML. Defaults to project setting "
                  "or 'qwen'."),
        )

    sub.add_parser("status", help="Check backends are alive")

    sp = sub.add_parser("project", help="Show project YAML")
    sp.add_argument("--project", required=True)

    sg = sub.add_parser("gather", help="Gather images for a project")
    sg.add_argument("--project", required=True)
    sg.add_argument("--max-per-query", type=int, default=30)
    sg.add_argument("--workers", type=int, default=50)
    sg.add_argument("--experiment", default=None)

    sf = sub.add_parser("filter", help="Image-level YES/NO classification (qwen or gemma)")
    sf.add_argument("--project", required=True)
    sf.add_argument("--experiment", default=None)
    sf.add_argument("--limit", type=int, default=0)
    add_backend_flag(sf)

    sl = sub.add_parser("label", help="Falcon Perception bbox grounding via mac_tensor /api/falcon")
    sl.add_argument("--project", required=True)
    sl.add_argument("--experiment", default=None)
    sl.add_argument("--limit", type=int, default=0)

    spi = sub.add_parser("pipeline", help="Full chain: gather → filter (label/verify TBD)")
    spi.add_argument("--project", required=True)
    spi.add_argument("--max-per-query", type=int, default=20)
    spi.add_argument("--workers", type=int, default=50)
    spi.add_argument("--experiment", default=None)
    spi.add_argument("--limit", type=int, default=0)
    add_backend_flag(spi)

    sub.add_parser("list", help="List experiments")

    args = p.parse_args()
    cmd_func = {
        "status": cmd_status,
        "project": cmd_project,
        "gather": cmd_gather,
        "filter": cmd_filter,
        "label": cmd_label,
        "pipeline": cmd_pipeline,
        "list": cmd_list,
    }.get(args.command)
    if cmd_func is None:
        p.print_help()
        sys.exit(1)
    cmd_func(args)


if __name__ == "__main__":
    main()
