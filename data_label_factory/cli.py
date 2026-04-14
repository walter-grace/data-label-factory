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

VALID_BACKENDS = ("qwen", "gemma", "chandra", "wilddet3d", "openrouter")


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


def cmd_label_v2(args):
    """Label images using the provider registry (v2 — supports all backends).

    Supports: falcon (default), wilddet3d, chandra, or any registered provider.
    """
    from .providers import create_provider

    proj = load_project(args.project)
    backend = args.backend or proj.backend_for("label") or "falcon"
    # Normalize legacy "pod" to "falcon"
    if backend == "pod":
        backend = "falcon"

    img_root = proj.local_image_dir()
    if not os.path.exists(img_root):
        print(f"  no images at {img_root}; run gather first")
        return

    try:
        provider = create_provider(backend)
    except ValueError as e:
        print(f"  {e}")
        return

    status = provider.status()
    if not status.get("alive"):
        print(f"  {backend} not available: {status.get('info', '')}")
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

    print(f"Labeling {len(images)} images via {backend} (v2 provider)")
    print(f"  queries: {proj.falcon_queries}")

    coco = {
        "info": {
            "description": f"data_label_factory v2 run for {proj.project_name} via {backend}",
            "date_created": datetime.now().isoformat(timespec="seconds"),
            "target_object": proj.target_object,
            "backend": backend,
        },
        "images": [],
        "annotations": [],
        "categories": [
            {"id": i + 1, "name": q, "supercategory": "object"}
            for i, q in enumerate(proj.falcon_queries)
        ],
    }
    cat_id = {q: i + 1 for i, q in enumerate(proj.falcon_queries)}
    next_img_id, next_ann_id = 1, 1
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
        coco["images"].append({
            "id": img_id, "file_name": rel, "width": iw, "height": ih, "bucket": bucket
        })

        result = provider.label_image(full, proj.falcon_queries, image_wh=(iw, ih))
        for ann in result.annotations:
            cat_name = ann.get("category", proj.falcon_queries[0])
            cid = cat_id.get(cat_name)
            if cid is None:
                cid = len(coco["categories"]) + 1
                coco["categories"].append({"id": cid, "name": cat_name, "supercategory": "object"})
                cat_id[cat_name] = cid

            coco["annotations"].append({
                "id": next_ann_id, "image_id": img_id,
                "category_id": cid,
                "bbox": ann["bbox"],
                "area": round(ann["bbox"][2] * ann["bbox"][3], 2),
                "iscrowd": 0,
                "score": ann.get("score", 1.0),
            })
            next_ann_id += 1
            n_total_dets += 1

        if i % 5 == 0 or i == len(images):
            elapsed = time.time() - t0
            rate = i / max(elapsed, 1)
            eta = (len(images) - i) / max(rate, 0.001) / 60
            print(f"  [{i:4d}/{len(images)}] dets={n_total_dets} ETA {eta:.0f} min")

    exp_dir = (resolve_experiment(args.experiment) if args.experiment
               else make_experiment_dir(f"label-{backend}-{proj.project_name}"))
    out_dir = os.path.join(exp_dir, f"label_{backend}")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{proj.project_name}.coco.json")
    with open(out_path, "w") as f:
        json.dump(coco, f, indent=2)
    print(f"\nSaved {out_path}")
    print(f"  {len(coco['images'])} images, {len(coco['annotations'])} bboxes")


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

    # Legacy direct checks
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

    # v2 provider registry
    try:
        from .providers import list_providers, create_provider
        print(f"\n  --- Provider Registry (v2) ---")
        for pname in list_providers():
            try:
                p = create_provider(pname)
                st = p.status()
                flag = "✓" if st.get("alive") else "✗"
                caps = ", ".join(sorted(p.capabilities)) if p.capabilities else "none"
                info = str(st.get("info", ""))[:80]
                print(f"  {flag} {pname:12s}  caps=[{caps}]  {info}")
            except Exception as e:
                print(f"  ✗ {pname:12s}  error: {e}")
    except ImportError:
        pass


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


def cmd_verify_v2(args):
    """Verify bboxes from a COCO file using a VLM provider (per-bbox YES/NO)."""
    from .providers import create_provider

    proj = load_project(args.project)
    backend = args.backend or proj.backend_for("verify") or "openrouter"

    # Find COCO file
    exp_dir = resolve_experiment(args.experiment) if args.experiment else resolve_experiment("latest")
    coco_files = []
    for dirpath, _, filenames in os.walk(exp_dir):
        for fn in filenames:
            if fn.endswith(".coco.json"):
                coco_files.append(os.path.join(dirpath, fn))
    if not coco_files:
        print(f"  No COCO files in {exp_dir}")
        return
    coco_path = coco_files[0]
    print(f"Verifying bboxes in {coco_path} via {backend}")

    with open(coco_path) as f:
        coco = json.load(f)

    img_root = proj.local_image_dir()
    images_by_id = {img["id"]: img for img in coco.get("images", [])}
    categories = {cat["id"]: cat["name"] for cat in coco.get("categories", [])}
    annotations = coco.get("annotations", [])

    if args.limit > 0:
        annotations = annotations[:args.limit]

    try:
        provider = create_provider(backend)
    except Exception as e:
        print(f"  {e}")
        return

    print(f"  {len(annotations)} bboxes to verify")
    results = []
    counts = {"YES": 0, "NO": 0, "UNSURE": 0, "ERROR": 0}
    t0 = time.time()

    for i, ann in enumerate(annotations, 1):
        img = images_by_id.get(ann["image_id"], {})
        img_path = os.path.join(img_root, img.get("file_name", ""))
        cat_name = categories.get(ann.get("category_id"), "object")
        bbox = ann["bbox"]

        if not os.path.exists(img_path):
            results.append({"ann_id": ann["id"], "verdict": "ERROR", "detail": "image not found"})
            counts["ERROR"] += 1
            continue

        try:
            vr = provider.verify_bbox(img_path, bbox, cat_name)
            verdict = vr.verdict
        except Exception as e:
            verdict = "ERROR"
            vr = type("VR", (), {"raw_answer": str(e), "elapsed": 0})()

        counts[verdict] = counts.get(verdict, 0) + 1
        results.append({
            "ann_id": ann["id"], "image": img.get("file_name", ""),
            "category": cat_name, "bbox": bbox,
            "verdict": verdict, "raw_answer": vr.raw_answer[:120],
            "elapsed": round(vr.elapsed, 2),
        })

        if i % 10 == 0 or i == len(annotations):
            elapsed_total = time.time() - t0
            rate = i / max(elapsed_total, 1)
            eta = (len(annotations) - i) / max(rate, 0.001) / 60
            print(f"  [{i:4d}/{len(annotations)}] YES={counts.get('YES',0)} NO={counts.get('NO',0)} "
                  f"ERR={counts.get('ERROR',0)}  ETA {eta:.1f} min")

    # Save
    out_dir = os.path.join(exp_dir, f"verify_{backend}")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "verified.json")
    with open(out_path, "w") as f:
        json.dump({"backend": backend, "project": proj.project_name,
                   "counts": counts, "results": results}, f, indent=2)
    print(f"\nSaved {out_path}")
    approve_rate = counts.get("YES", 0) / max(1, len(results))
    print(f"  Approval rate: {approve_rate:.0%} ({counts.get('YES',0)}/{len(results)})")


def cmd_pipeline(args):
    """Full pipeline: gather → filter → label → verify → score.

    Runs the complete data labeling factory end-to-end.
    Uses the v2 provider registry for all stages.
    """
    from .providers import create_provider
    from .metrics import score_coco

    proj = load_project(args.project)
    filter_backend = resolve_backend(args, proj, "filter")
    label_backend = getattr(args, "label_backend", None) or proj.backend_for("label") or "falcon"
    verify_backend = getattr(args, "verify_backend", None) or proj.backend_for("verify") or filter_backend

    print("=" * 70)
    print(f"PIPELINE — {proj.project_name} ({proj.target_object})")
    print(f"  filter:  {filter_backend}")
    print(f"  label:   {label_backend}")
    print(f"  verify:  {verify_backend}")
    print("=" * 70)

    exp = make_experiment_dir(f"pipeline-{proj.project_name}")
    write_readme(exp, f"pipeline-{proj.project_name}",
                 description=f"Full pipeline for {proj.target_object}",
                 params=vars(args))
    write_config(exp, {"project": proj.raw, **vars(args),
                       "filter_backend": filter_backend,
                       "label_backend": label_backend,
                       "verify_backend": verify_backend})
    update_latest_symlink(exp)
    print(f"Experiment: {exp}\n")

    skip_gather = getattr(args, "skip_gather", False)
    img_root = proj.local_image_dir()

    # ── 1. GATHER ──
    if not skip_gather:
        print("=" * 50)
        print(">>> [1/4] GATHER")
        print("=" * 50)
        args.experiment = os.path.basename(exp).split("_", 2)[-1]
        cmd_gather(args)
    else:
        print(">>> [1/4] GATHER — skipped (--skip-gather)")

    # Collect images
    images = []
    if os.path.exists(img_root):
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
    print(f"\n  {len(images)} images found in {img_root}")

    if not images:
        print("  No images — pipeline stopped. Run gather first.")
        return

    # ── 2. FILTER ──
    print("\n" + "=" * 50)
    print(f">>> [2/4] FILTER via {filter_backend}")
    print("=" * 50)

    try:
        filter_prov = create_provider(filter_backend)
    except Exception as e:
        print(f"  Filter provider error: {e}")
        print("  Falling back to all-YES (no filter)")
        filter_prov = None

    prompt = proj.prompt("filter")
    filter_results = []
    counts = {"YES": 0, "NO": 0, "UNKNOWN": 0, "ERROR": 0}
    t0 = time.time()

    for i, (bucket, rel, full) in enumerate(images, 1):
        if filter_prov:
            fr = filter_prov.filter_image(full, prompt)
            verdict = fr.verdict
            raw = fr.raw_answer
            elapsed_img = fr.elapsed
        else:
            verdict, raw, elapsed_img = "YES", "no filter", 0

        counts[verdict] = counts.get(verdict, 0) + 1
        filter_results.append({
            "image_path": rel, "bucket": bucket, "verdict": verdict,
            "raw_answer": raw[:120], "elapsed_seconds": round(elapsed_img, 3),
        })
        if i % 10 == 0 or i == len(images):
            elapsed_total = time.time() - t0
            rate = i / max(elapsed_total, 1)
            eta = (len(images) - i) / max(rate, 0.001) / 60
            print(f"  [{i:4d}/{len(images)}] YES={counts['YES']} NO={counts['NO']}  ETA {eta:.0f} min")

    out_dir = os.path.join(exp, f"filter_{filter_backend}")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "keep_list.json"), "w") as f:
        json.dump({"backend": filter_backend, "project": proj.project_name,
                   "counts": counts, "results": filter_results}, f, indent=2)
    print(f"  YES rate: {counts['YES']}/{len(images)} ({counts['YES']/max(1,len(images)):.0%})")

    # Keep only YES images for labeling
    yes_images = [(b, r, full) for (b, r, full), fr in zip(images, filter_results)
                  if fr["verdict"] == "YES"]
    print(f"  {len(yes_images)} images pass filter → label stage")

    if not yes_images:
        print("  No images passed filter — pipeline stopped.")
        print(f"\nPIPELINE DONE — {exp}")
        return

    # ── 3. LABEL ──
    print("\n" + "=" * 50)
    print(f">>> [3/4] LABEL via {label_backend}")
    print("=" * 50)

    try:
        label_prov = create_provider(label_backend)
    except Exception as e:
        print(f"  Label provider error: {e}")
        print(f"\nPIPELINE STOPPED at label stage — {exp}")
        return

    from PIL import Image
    coco = {
        "info": {
            "description": f"data_label_factory pipeline for {proj.project_name}",
            "date_created": datetime.now().isoformat(timespec="seconds"),
            "target_object": proj.target_object,
            "filter_backend": filter_backend,
            "label_backend": label_backend,
        },
        "images": [],
        "annotations": [],
        "categories": [
            {"id": i + 1, "name": q, "supercategory": "object"}
            for i, q in enumerate(proj.falcon_queries)
        ],
    }
    cat_id = {q: i + 1 for i, q in enumerate(proj.falcon_queries)}
    next_img_id, next_ann_id = 1, 1
    n_total_dets = 0
    t0 = time.time()

    for i, (bucket, rel, full) in enumerate(yes_images, 1):
        try:
            im = Image.open(full)
            iw, ih = im.size
        except Exception as e:
            continue

        img_id = next_img_id
        next_img_id += 1
        coco["images"].append({
            "id": img_id, "file_name": rel, "width": iw, "height": ih, "bucket": bucket
        })

        result = label_prov.label_image(full, proj.falcon_queries, image_wh=(iw, ih))
        for ann in result.annotations:
            cat_name = ann.get("category", proj.falcon_queries[0])
            cid = cat_id.get(cat_name)
            if cid is None:
                cid = len(coco["categories"]) + 1
                coco["categories"].append({"id": cid, "name": cat_name, "supercategory": "object"})
                cat_id[cat_name] = cid

            coco["annotations"].append({
                "id": next_ann_id, "image_id": img_id,
                "category_id": cid,
                "bbox": ann["bbox"],
                "area": round(ann["bbox"][2] * ann["bbox"][3], 2),
                "iscrowd": 0,
                "score": ann.get("score", 1.0),
            })
            next_ann_id += 1
            n_total_dets += 1

        if i % 5 == 0 or i == len(yes_images):
            elapsed = time.time() - t0
            rate = i / max(elapsed, 1)
            eta = (len(yes_images) - i) / max(rate, 0.001) / 60
            print(f"  [{i:4d}/{len(yes_images)}] dets={n_total_dets}  ETA {eta:.0f} min")

    out_dir = os.path.join(exp, f"label_{label_backend}")
    os.makedirs(out_dir, exist_ok=True)
    coco_path = os.path.join(out_dir, f"{proj.project_name}.coco.json")
    with open(coco_path, "w") as f:
        json.dump(coco, f, indent=2)
    print(f"  {len(coco['images'])} images, {n_total_dets} bboxes → {coco_path}")

    # ── 4. VERIFY ──
    print("\n" + "=" * 50)
    print(f">>> [4/4] VERIFY via {verify_backend}")
    print("=" * 50)

    try:
        verify_prov = create_provider(verify_backend)
    except Exception as e:
        print(f"  Verify provider error: {e} — skipping verify")
        verify_prov = None

    verify_results = []
    v_counts = {"YES": 0, "NO": 0, "UNSURE": 0, "ERROR": 0}

    if verify_prov and n_total_dets > 0:
        verify_limit = args.limit if args.limit > 0 else len(coco["annotations"])
        anns_to_verify = coco["annotations"][:verify_limit]
        t0 = time.time()

        for i, ann in enumerate(anns_to_verify, 1):
            img = {im["id"]: im for im in coco["images"]}.get(ann["image_id"], {})
            img_path = os.path.join(img_root, img.get("file_name", ""))
            cat_name = {c["id"]: c["name"] for c in coco["categories"]}.get(ann["category_id"], "object")

            if not os.path.exists(img_path):
                verify_results.append({"ann_id": ann["id"], "verdict": "ERROR"})
                v_counts["ERROR"] += 1
                continue

            try:
                vr = verify_prov.verify_bbox(img_path, ann["bbox"], cat_name)
                verdict = vr.verdict
            except Exception:
                verdict = "ERROR"

            v_counts[verdict] = v_counts.get(verdict, 0) + 1
            verify_results.append({
                "ann_id": ann["id"], "category": cat_name,
                "verdict": verdict,
            })

            if i % 10 == 0 or i == len(anns_to_verify):
                elapsed_total = time.time() - t0
                rate = i / max(elapsed_total, 1)
                eta = (len(anns_to_verify) - i) / max(rate, 0.001) / 60
                print(f"  [{i:4d}/{len(anns_to_verify)}] YES={v_counts['YES']} NO={v_counts['NO']}  ETA {eta:.1f} min")

        out_dir = os.path.join(exp, f"verify_{verify_backend}")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "verified.json"), "w") as f:
            json.dump({"backend": verify_backend, "counts": v_counts,
                       "results": verify_results}, f, indent=2)
        approve = v_counts.get("YES", 0) / max(1, len(verify_results))
        print(f"  Approval: {v_counts.get('YES',0)}/{len(verify_results)} ({approve:.0%})")
    else:
        print("  Skipped (no provider or no detections)")

    # ── SCORE ──
    print("\n" + "=" * 50)
    print(">>> QUALITY SCORE")
    print("=" * 50)
    score = score_coco(coco)
    print(f"  Images:      {score.total_images}")
    print(f"  Annotations: {score.total_annotations}")
    print(f"  Pass rate:   {score.pass_rate:.0%}")
    print(f"  Mean score:  {score.mean_score:.3f}")
    for rule, rate in sorted(score.rule_breakdown.items()):
        flag = "ok" if rate >= 0.95 else "WARN"
        print(f"    {rule:20s} {rate:6.1%}  {flag}")

    print(f"\n{'=' * 70}")
    print(f"PIPELINE DONE — {exp}")
    print(f"  COCO: {coco_path}")
    print(f"  {len(coco['images'])} images, {n_total_dets} bboxes, "
          f"filter={counts['YES']}/{len(images)} YES, "
          f"verify={v_counts.get('YES','?')}/{len(verify_results) if verify_results else '?'} approved")
    print(f"{'=' * 70}")


def cmd_list(args):
    print("=" * 60)
    print("Experiments")
    print("=" * 60)
    for e in list_experiments():
        cfg = e.get("config", {})
        proj = (cfg.get("project") or {}).get("project_name", cfg.get("backend", "?"))
        print(f"  {e['name']:50s}  project={proj}")


def cmd_providers(args):
    """List all registered providers and their capabilities."""
    from .providers import list_providers, create_provider
    print("=" * 60)
    print("Registered Providers")
    print("=" * 60)
    for pname in list_providers():
        try:
            p = create_provider(pname)
            caps = ", ".join(sorted(p.capabilities)) if p.capabilities else "none"
            st = p.status()
            flag = "ALIVE" if st.get("alive") else "DOWN/NOT INSTALLED"
            print(f"\n  {pname}")
            print(f"    capabilities: {caps}")
            print(f"    status:       {flag}")
            info = st.get("info", "")
            if info:
                print(f"    info:         {str(info)[:100]}")
        except Exception as e:
            print(f"\n  {pname}")
            print(f"    error: {e}")


def cmd_auto(args):
    """Auto-create a project from samples + description."""
    from .auto import auto_project
    output = args.output
    if not output:
        name = args.name or args.description.lower().replace(" ", "-")[:30]
        output = f"projects/{name}.yaml"
    auto_project(
        samples=args.samples,
        description=args.description,
        project_name=args.name,
        output=output,
        analyze=not args.no_analyze,
    )


def cmd_serve_mcp(args):
    """Run as MCP server for AI agents."""
    from .mcp import main as mcp_main
    mcp_main()


def cmd_generate(args):
    """Generate synthetic training data using the flywheel provider."""
    from .providers import create_provider
    provider = create_provider("flywheel", config={"refs_dir": args.refs})
    summary = provider.generate_dataset(
        refs_dir=args.refs,
        output_dir=args.output,
        n_scenes=args.scenes,
    )
    print(f"\n  Classes: {summary.get('n_classes', 0)}")
    print(f"  COCO: {summary.get('coco_path', '')}")
    print(f"  YOLO: {summary.get('yolo_data_yaml', '')}")


def cmd_benchmark(args):
    """Dispatch to benchmark module."""
    from .benchmark import main as benchmark_main
    # Re-pack args for the benchmark module
    argv = []
    if args.compare:
        argv += ["--compare"] + list(args.compare)
    elif args.score:
        argv += ["--score", args.score]
    elif args.run:
        argv += ["--run"]
    elif getattr(args, "models", False):
        argv += ["--models"]
    if getattr(args, "project", None):
        argv += ["--project", args.project]
    if getattr(args, "backends", None):
        argv += ["--backends", args.backends]
    if getattr(args, "model_list", None):
        argv += ["--model-list", args.model_list]
    if getattr(args, "limit", 0) > 0:
        argv += ["--limit", str(args.limit)]
    if getattr(args, "output", None):
        argv += ["--output", args.output]
    benchmark_main(argv)


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

    spi = sub.add_parser("pipeline", help="Full chain: gather → filter → label → verify → score")
    spi.add_argument("--project", required=True)
    spi.add_argument("--max-per-query", type=int, default=20)
    spi.add_argument("--workers", type=int, default=50)
    spi.add_argument("--experiment", default=None)
    spi.add_argument("--limit", type=int, default=0)
    spi.add_argument("--skip-gather", action="store_true",
                     help="Skip image gathering (use existing images)")
    spi.add_argument("--label-backend", default=None,
                     help="Backend for bbox labeling (falcon, openrouter, etc.)")
    spi.add_argument("--verify-backend", default=None,
                     help="Backend for per-bbox verification")
    add_backend_flag(spi)

    sv = sub.add_parser("verify", help="Verify bboxes in a COCO file via VLM")
    sv.add_argument("--project", required=True)
    sv.add_argument("--experiment", default=None)
    sv.add_argument("--limit", type=int, default=0)
    add_backend_flag(sv)

    sl2 = sub.add_parser("label-v2", help="Label via provider registry (falcon, wilddet3d, chandra)")
    sl2.add_argument("--project", required=True)
    sl2.add_argument("--backend", default=None,
                     help="Label backend: falcon (default), wilddet3d, chandra")
    sl2.add_argument("--experiment", default=None)
    sl2.add_argument("--limit", type=int, default=0)

    sb = sub.add_parser("benchmark", help="Compare labeling backends or VLM models")
    sb_group = sb.add_mutually_exclusive_group(required=True)
    sb_group.add_argument("--compare", nargs=2, metavar=("COCO_A", "COCO_B"),
                          help="Compare two COCO files")
    sb_group.add_argument("--score", metavar="EXP_DIR",
                          help="Score a single experiment directory")
    sb_group.add_argument("--run", action="store_true",
                          help="Run fresh benchmark with multiple label backends")
    sb_group.add_argument("--models", action="store_true",
                          help="Model benchmark: compare VLMs for filter/verify accuracy")
    sb.add_argument("--project", help="Project YAML (for --run / --models)")
    sb.add_argument("--backends", default="falcon",
                    help="Comma-separated backends (for --run, e.g. falcon,wilddet3d)")
    sb.add_argument("--model-list",
                    default="qwen,google/gemma-4-26b-a4b-it",
                    help="Comma-separated model IDs for --models "
                         "(e.g. qwen,google/gemma-4-26b-a4b-it,meta-llama/llama-4-scout)")
    sb.add_argument("--limit", type=int, default=0)
    sb.add_argument("--output", help="Output report path")

    sub.add_parser("list", help="List experiments")

    sp_providers = sub.add_parser("providers", help="List registered providers and capabilities")

    sa = sub.add_parser("auto", help="Auto-create project from samples + description")
    sa.add_argument("--samples", required=True,
                    help="Directory of sample images or single image path")
    sa.add_argument("--description", required=True,
                    help='What to label (e.g. "fire hydrants in urban settings")')
    sa.add_argument("--name", default="", help="Project name (auto-generated if empty)")
    sa.add_argument("--output", default="", help="Output YAML path")
    sa.add_argument("--no-analyze", action="store_true",
                    help="Skip VLM analysis of samples")

    sub.add_parser("serve-mcp", help="Run as MCP server for AI agents (stdio)")

    sg_syn = sub.add_parser("generate", help="Generate synthetic training data (flywheel)")
    sg_syn.add_argument("--refs", required=True,
                        help="Directory of reference images (PNGs with alpha preferred)")
    sg_syn.add_argument("--output", default="flywheel_data",
                        help="Output directory for generated dataset")
    sg_syn.add_argument("--scenes", type=int, default=100,
                        help="Number of scenes to generate")

    args = p.parse_args()
    cmd_func = {
        "status": cmd_status,
        "project": cmd_project,
        "gather": cmd_gather,
        "filter": cmd_filter,
        "label": cmd_label,
        "label-v2": cmd_label_v2,
        "verify": cmd_verify_v2,
        "pipeline": cmd_pipeline,
        "list": cmd_list,
        "providers": cmd_providers,
        "benchmark": cmd_benchmark,
        "auto": cmd_auto,
        "serve-mcp": cmd_serve_mcp,
        "generate": cmd_generate,
    }.get(args.command)
    if cmd_func is None:
        p.print_help()
        sys.exit(1)
    cmd_func(args)


if __name__ == "__main__":
    main()
