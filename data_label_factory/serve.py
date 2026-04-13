"""
serve.py — REST API server for data-label-factory.

The web UI frontend calls this server to run the labeling pipeline.
Wraps the same logic as the MCP tools but over HTTP.

Usage:
    python3 -m data_label_factory.serve --port 8400

Endpoints:
    GET  /api/providers          — list registered providers + status
    POST /api/auto               — create project from samples + description
    POST /api/filter             — filter a single image
    POST /api/label              — label a single image
    POST /api/verify             — verify a bbox crop
    POST /api/score              — score a COCO annotation file
    POST /api/upload             — upload sample images
    GET  /api/experiments        — list experiments
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import tempfile
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from fastapi import FastAPI, UploadFile, File, Form, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, FileResponse
    from fastapi.staticfiles import StaticFiles
except ImportError:
    raise ImportError("FastAPI required: pip install fastapi uvicorn python-multipart")

app = FastAPI(title="data-label-factory", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path(os.environ.get("DLF_UPLOAD_DIR", "/tmp/dlf-uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


# ─── Providers ──────────────────────────────────────────────

@app.get("/api/providers")
def get_providers():
    from .providers import list_providers, create_provider
    results = []
    for name in list_providers():
        try:
            p = create_provider(name)
            st = p.status()
            results.append({
                "name": name,
                "alive": st.get("alive", False),
                "capabilities": sorted(p.capabilities),
                "info": str(st.get("info", ""))[:200],
            })
        except Exception as e:
            results.append({"name": name, "alive": False, "error": str(e)})
    return {"providers": results}


# ─── Auto project ──────────────────────────────────────────

@app.post("/api/auto")
async def auto_project(
    description: str = Form(...),
    samples: list[UploadFile] = File(default=[]),
):
    """Create a project from uploaded samples + description."""
    # Save uploaded files
    session_id = f"session_{int(time.time())}"
    session_dir = UPLOAD_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    saved_paths = []
    for f in samples:
        dest = session_dir / f.filename
        with open(dest, "wb") as out:
            out.write(await f.read())
        saved_paths.append(str(dest))

    from .auto import auto_project as _auto, detect_content_type
    content_type = detect_content_type(description)

    try:
        config = _auto(
            samples=str(session_dir) if saved_paths else [],
            description=description,
            output="",
            analyze=False,  # skip VLM analysis for speed in web UI
        )
    except Exception as e:
        raise HTTPException(500, str(e))

    return {
        "session_id": session_id,
        "content_type": content_type,
        "config": config,
        "n_samples": len(saved_paths),
        "sample_dir": str(session_dir),
    }


# ─── Filter ────────────────────────────────────────────────

@app.post("/api/filter")
async def filter_image(
    image: UploadFile = File(...),
    prompt: str = Form(default="Does this image show the target object? Answer YES or NO."),
    backend: str = Form(default="qwen"),
):
    """Filter a single image via a VLM backend."""
    from .providers import create_provider

    # Save temp file
    suffix = Path(image.filename).suffix or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOAD_DIR)) as f:
        f.write(await image.read())
        tmp_path = f.name

    try:
        provider = create_provider(backend)
        result = provider.filter_image(tmp_path, prompt)
        return {
            "verdict": result.verdict,
            "raw_answer": result.raw_answer,
            "elapsed": round(result.elapsed, 2),
            "confidence": result.confidence,
            "backend": backend,
        }
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        os.unlink(tmp_path)


# ─── Label ─────────────────────────────────────────────────

@app.post("/api/label")
async def label_image(
    image: UploadFile = File(...),
    queries: str = Form(default="object"),
    backend: str = Form(default="falcon"),
):
    """Label a single image — returns COCO-style bboxes."""
    from .providers import create_provider
    from PIL import Image

    suffix = Path(image.filename).suffix or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOAD_DIR)) as f:
        f.write(await image.read())
        tmp_path = f.name

    try:
        provider = create_provider(backend)
        im = Image.open(tmp_path)
        iw, ih = im.size
        query_list = [q.strip() for q in queries.split(",")]
        result = provider.label_image(tmp_path, query_list, image_wh=(iw, ih))

        # Also run metrics on the annotations
        from .metrics import verify_bbox_rules
        scored_anns = []
        for ann in result.annotations:
            vr = verify_bbox_rules(ann["bbox"], (iw, ih), score=ann.get("score", 1.0))
            scored_anns.append({
                **ann,
                "pass_rate": round(vr.pass_rate, 2),
                "failed_rules": vr.failed_rules,
            })

        return {
            "annotations": scored_anns,
            "elapsed": round(result.elapsed, 2),
            "backend": backend,
            "image_size": [iw, ih],
            "n_detections": len(scored_anns),
        }
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        os.unlink(tmp_path)


# ─── Verify ────────────────────────────────────────────────

@app.post("/api/verify")
async def verify_bbox(
    image: UploadFile = File(...),
    bbox: str = Form(...),  # JSON: [x, y, w, h]
    query: str = Form(default="object"),
    backend: str = Form(default="qwen"),
):
    """Verify a single bbox crop."""
    from .providers import create_provider

    suffix = Path(image.filename).suffix or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOAD_DIR)) as f:
        f.write(await image.read())
        tmp_path = f.name

    try:
        provider = create_provider(backend)
        bbox_list = json.loads(bbox)
        result = provider.verify_bbox(tmp_path, bbox_list, query)
        return {
            "verdict": result.verdict,
            "raw_answer": result.raw_answer,
            "elapsed": round(result.elapsed, 2),
            "confidence": result.confidence,
            "backend": backend,
        }
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        os.unlink(tmp_path)


# ─── Score ─────────────────────────────────────────────────

@app.post("/api/score")
async def score_coco(coco_file: UploadFile = File(...)):
    """Score a COCO annotation file with deterministic metrics."""
    from .metrics import score_coco as _score
    content = await coco_file.read()
    coco = json.loads(content)
    score = _score(coco)
    return {
        "total_images": score.total_images,
        "total_annotations": score.total_annotations,
        "pass_rate": round(score.pass_rate, 4),
        "mean_score": round(score.mean_score, 4),
        "mean_area_ratio": round(score.mean_area_ratio, 4),
        "rule_breakdown": {k: round(v, 4) for k, v in score.rule_breakdown.items()},
        "per_category": score.per_category,
    }


# ─── Batch pipeline ───────────────────────────────────────

@app.post("/api/pipeline")
async def run_pipeline(
    description: str = Form(...),
    backend: str = Form(default="gemma"),
    samples: list[UploadFile] = File(default=[]),
):
    """Full pipeline: upload samples → auto project → filter → return results."""
    from .providers import create_provider
    from .auto import detect_content_type, CONTENT_PROFILES

    session_id = f"pipeline_{int(time.time())}"
    session_dir = UPLOAD_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    # Save uploads
    saved = []
    for f in samples:
        dest = session_dir / f.filename
        with open(dest, "wb") as out:
            out.write(await f.read())
        saved.append({"name": f.filename, "path": str(dest)})

    content_type = detect_content_type(description)
    profile = CONTENT_PROFILES.get(content_type, CONTENT_PROFILES["generic"])

    # Use the recommended filter backend or override
    filter_backend = backend if backend != "auto" else profile["filter_backend"]

    try:
        provider = create_provider(filter_backend)
    except Exception as e:
        return {"error": f"Backend {filter_backend} not available: {e}"}

    prompt = (
        f"Look at this image. Does it show a {description}? "
        "Answer with exactly one word: YES or NO."
    )

    results = []
    t0 = time.time()
    for item in saved:
        try:
            fr = provider.filter_image(item["path"], prompt)
            results.append({
                "name": item["name"],
                "verdict": fr.verdict,
                "raw_answer": fr.raw_answer,
                "elapsed": round(fr.elapsed, 2),
                "confidence": fr.confidence,
            })
        except Exception as e:
            results.append({
                "name": item["name"],
                "verdict": "ERROR",
                "raw_answer": str(e)[:100],
                "elapsed": 0,
                "confidence": 0,
            })

    elapsed_total = time.time() - t0
    counts = {}
    for r in results:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1

    return {
        "session_id": session_id,
        "content_type": content_type,
        "backend": filter_backend,
        "prompt": prompt,
        "n_images": len(saved),
        "elapsed_total": round(elapsed_total, 1),
        "counts": counts,
        "results": results,
    }


# ─── Experiments ───────────────────────────────────────────

@app.get("/api/experiments")
def list_experiments_api():
    from .experiments import list_experiments
    return {"experiments": list_experiments()}


# ─── Health ────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok", "version": "0.2.0", "timestamp": datetime.now().isoformat()}


# ─── Main ──────────────────────────────────────────────────

def main():
    import argparse
    import uvicorn

    p = argparse.ArgumentParser(prog="data_label_factory.serve")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8400)
    args = p.parse_args()

    print(f"data-label-factory API server on http://{args.host}:{args.port}")
    print(f"  Docs: http://localhost:{args.port}/docs")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
