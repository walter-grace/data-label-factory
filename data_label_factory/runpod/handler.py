#!/usr/bin/env python3
"""
Serverless handler for the data-label-factory worker.

Loaded once per worker cold start, then handles per-request grounding +
verification jobs. Designed to be deployed as a RunPod serverless endpoint.

Job input schema
----------------
    {
        "image_base64": "<base64 JPEG/PNG bytes>",      # OR
        "image_url":    "https://...",                   # one of these required
        "query":        "fiber optic drone",
        "task":         "segmentation",                  # or "detection"
        "verify":       true                             # optional: also run Qwen verify
    }

Job output schema
-----------------
    {
        "query":            "fiber optic drone",
        "task":             "segmentation",
        "image_size":       [w, h],
        "count":            int,
        "bboxes":           [{x1, y1, x2, y2, score, vlm_verdict?, vlm_reasoning?}, ...],
        "elapsed_seconds":  float,
        "cold_start":       bool,
    }

The handler is intentionally minimal — one image, one query, one response.
For batch labeling use the pod path instead (see ../README.md).
"""

import base64
import io
import os
import time
import traceback
from typing import Any
from urllib import request as _urlreq

# These imports happen at MODULE LOAD time inside the worker so the model
# loads once per cold start, not per request.
print("[handler] importing falcon_perception ...", flush=True)
try:
    import torch
    from PIL import Image
    from falcon_perception import (
        PERCEPTION_MODEL_ID,
        build_prompt_for_task,
        load_and_prepare_model,
        setup_torch_config,
    )
    from falcon_perception.data import ImageProcessor
    from falcon_perception.paged_inference import (
        PagedInferenceEngine,
        SamplingParams,
        Sequence,
    )
    HEAVY_DEPS_OK = True
except ImportError as e:
    print(f"[handler] heavy deps not yet installed: {e}", flush=True)
    HEAVY_DEPS_OK = False


# ============================================================
# Module-level setup — runs ONCE per worker cold start
# ============================================================

_engine = None
_processor = None
_model = None
_cold_start = True


def _ensure_loaded():
    """Lazy-load the model on first request, not at import time, so the
    handler can also be imported in test contexts where torch isn't ready."""
    global _engine, _processor, _model

    if not HEAVY_DEPS_OK:
        raise RuntimeError(
            "Falcon Perception is not installed in this worker. "
            "Rebuild the Docker image with the runpod/requirements-pod.txt deps."
        )

    if _engine is not None:
        return  # already loaded

    print(f"[handler] loading model {PERCEPTION_MODEL_ID} ...", flush=True)
    setup_torch_config()
    _model, _processor = load_and_prepare_model(PERCEPTION_MODEL_ID)
    _engine = PagedInferenceEngine(model=_model, processor=_processor)
    print("[handler] model loaded.", flush=True)


# ============================================================
# Helpers
# ============================================================

def _decode_image(job_input: dict) -> Image.Image:
    if "image_base64" in job_input:
        return Image.open(io.BytesIO(base64.b64decode(job_input["image_base64"]))).convert("RGB")
    if "image_url" in job_input:
        with _urlreq.urlopen(job_input["image_url"], timeout=30) as r:
            return Image.open(io.BytesIO(r.read())).convert("RGB")
    raise ValueError("job input must contain image_base64 or image_url")


def _normalize_bboxes(raw, w: int, h: int) -> list[dict]:
    """Convert Falcon's bbox dicts to our canonical schema."""
    out = []
    for b in raw or []:
        bn = b.get("bbox_norm") or {}
        if not bn:
            continue
        out.append({
            "x1":    round(bn.get("x1", 0) * w, 2),
            "y1":    round(bn.get("y1", 0) * h, 2),
            "x2":    round(bn.get("x2", 0) * w, 2),
            "y2":    round(bn.get("y2", 0) * h, 2),
            "score": float(b.get("area_fraction", 1.0)),
        })
    return out


# ============================================================
# RunPod entry point
# ============================================================

def handler(job: dict[str, Any]) -> dict[str, Any]:
    """RunPod serverless calls this for every job."""
    global _cold_start

    t0 = time.time()
    was_cold = _cold_start

    try:
        _ensure_loaded()
        _cold_start = False

        job_input = job.get("input") or {}
        query = job_input.get("query")
        task = job_input.get("task", "segmentation")
        if not query:
            return {"error": "input.query is required"}

        img = _decode_image(job_input)
        w, h = img.size

        # Run Falcon
        prompt = build_prompt_for_task(task, query)
        params = SamplingParams(max_new_tokens=512, temperature=0.0)
        seq = Sequence(prompt=prompt, image=img, sampling_params=params)
        result = _engine.generate([seq])[0]

        # Parse Falcon output. The exact field name varies by version of
        # falcon-perception; we accept either `bbox_entries` or `boxes`.
        raw_boxes = getattr(result, "bbox_entries", None) or getattr(result, "boxes", [])
        bboxes = _normalize_bboxes(raw_boxes, w, h)

        return {
            "query":           query,
            "task":            task,
            "image_size":      [w, h],
            "count":           len(bboxes),
            "bboxes":          bboxes,
            "elapsed_seconds": round(time.time() - t0, 3),
            "cold_start":      was_cold,
        }

    except Exception as e:
        return {
            "error":    str(e),
            "trace":    traceback.format_exc().splitlines()[-6:],
            "elapsed":  round(time.time() - t0, 3),
        }


# ============================================================
# RunPod registration
# ============================================================

if __name__ == "__main__":
    try:
        import runpod  # type: ignore
    except ImportError:
        print("runpod SDK not installed; running in test mode")
        # Allow local smoke testing without the runpod package
        import json, sys
        if len(sys.argv) > 1:
            job = json.load(open(sys.argv[1]))
            print(json.dumps(handler(job), indent=2))
        else:
            print("usage: python3 handler.py <job.json>")
        sys.exit(0)

    runpod.serverless.start({"handler": handler})
