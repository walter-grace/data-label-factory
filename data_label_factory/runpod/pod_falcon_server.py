#!/usr/bin/env python3
"""
pod_falcon_server.py — single-file Falcon Perception HTTP server for a RunPod pod.

Designed to be curl-installed via the pod's dockerStartCmd. Two phases:

1. **Boot phase (instant):** start a FastAPI server on 0.0.0.0:8000 with two
   endpoints: `/health` (always responds) and `/api/falcon` (returns 503 until
   the model is loaded). A background thread starts heavy installation.

2. **Install phase (~5-10 min):** install pip deps, install falcon-perception
   with --no-deps, download the Falcon model from Hugging Face, instantiate
   the inference engine. As soon as it's ready, `/api/falcon` flips to live.

The endpoint shape MATCHES mac_tensor's /api/falcon so the existing
`web/app/api/falcon-frame/route.ts` proxy works against it without changes:

  Request:  multipart/form-data with `image` (file) + `query` (string)
  Response: {
              "image_size": [w, h],
              "count": int,
              "masks": [{"bbox_norm": {x1, y1, x2, y2}, "area_fraction": float}, ...],
              "elapsed_seconds": float,
              "cold_start": bool
            }

You can poll progress via:
  curl https://<pod-id>-8000.proxy.runpod.net/health
"""

import io
import os
import subprocess
import sys
import threading
import time
import traceback
from typing import Any

# ============================================================
# Boot phase — keep imports minimal so the server starts FAST
# ============================================================

print("[server] starting boot phase…", flush=True)
BOOT_T0 = time.time()

# Install fastapi + uvicorn synchronously since we need them for the boot server.
# These are tiny (~30 MB) so this takes ~10 seconds.
def _pip(args, retries=3):
    for attempt in range(retries):
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "--no-cache-dir"] + args,
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            return True
        print(f"[pip] attempt {attempt+1} failed: {r.stderr[:300]}", flush=True)
        time.sleep(3)
    return False

print("[server] installing fastapi + uvicorn + multipart…", flush=True)
if not _pip(["fastapi==0.115.6", "uvicorn[standard]==0.32.1", "python-multipart==0.0.20", "pillow"]):
    print("[server] CRITICAL: failed to install fastapi", flush=True)
    sys.exit(1)

# Now we can import fastapi
from fastapi import FastAPI, Request, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, PlainTextResponse
from PIL import Image

app = FastAPI(title="data-label-factory falcon worker")

STATE: dict[str, Any] = {
    "phase":          "boot",
    "boot_started":   BOOT_T0,
    "model_loaded":   False,
    "install_log":    [],
    "error":          None,
    "model_id":       None,
    "device":         None,
    "load_seconds":   None,
    "cold_start_used": False,
    "requests_served": 0,
}

def _log(msg: str) -> None:
    line = f"[{time.time() - BOOT_T0:6.1f}s] {msg}"
    print(line, flush=True)
    STATE["install_log"].append(line)
    # cap log to last 200 lines
    if len(STATE["install_log"]) > 200:
        STATE["install_log"] = STATE["install_log"][-200:]


# ============================================================
# Endpoints
# ============================================================

@app.get("/")
def root() -> PlainTextResponse:
    return PlainTextResponse(
        f"data-label-factory falcon worker · phase={STATE['phase']} "
        f"loaded={STATE['model_loaded']} requests={STATE['requests_served']}\n"
        f"see /health for full status, POST /api/falcon for inference\n"
    )


@app.get("/health")
def health() -> dict:
    return {
        "phase":          STATE["phase"],
        "model_loaded":   STATE["model_loaded"],
        "model_id":       STATE.get("model_id"),
        "device":         STATE.get("device"),
        "load_seconds":   STATE.get("load_seconds"),
        "uptime_seconds": round(time.time() - BOOT_T0, 1),
        "requests_served": STATE["requests_served"],
        "error":          STATE["error"],
        "recent_log":     STATE["install_log"][-30:],
    }


@app.post("/api/falcon")
async def falcon(image: UploadFile = File(...), query: str = Form(...)) -> JSONResponse:
    if not STATE["model_loaded"]:
        return JSONResponse(
            status_code=503,
            content={
                "error":   "model not loaded yet",
                "phase":   STATE["phase"],
                "loaded":  False,
                "uptime":  round(time.time() - BOOT_T0, 1),
                "recent":  STATE["install_log"][-5:],
            },
        )

    t0 = time.time()
    img_bytes = await image.read()
    try:
        pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": f"bad image: {e}"})

    cold = not STATE["cold_start_used"]
    STATE["cold_start_used"] = True

    try:
        result = _run_inference(pil, query)
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "trace": traceback.format_exc().splitlines()[-6:]},
        )

    STATE["requests_served"] += 1
    return JSONResponse(content={
        "image_size":      [pil.width, pil.height],
        "count":           result["count"],
        "masks":           result["masks"],
        "query":           query,
        "elapsed_seconds": round(time.time() - t0, 3),
        "cold_start":      cold,
    })


# ============================================================
# Heavy install + inference (loaded in background thread)
# ============================================================

_engine = None
_processor = None
_model = None


def _run_inference(pil_img: "Image.Image", query: str) -> dict:
    """Single-image Falcon Perception forward pass."""
    if _engine is None or _processor is None:
        raise RuntimeError("model not loaded")

    from falcon_perception import build_prompt_for_task  # type: ignore
    from falcon_perception.paged_inference import SamplingParams, Sequence  # type: ignore

    prompt = build_prompt_for_task("segmentation", query)
    params = SamplingParams(max_new_tokens=512, temperature=0.0)
    seq = Sequence(prompt=prompt, image=pil_img, sampling_params=params)
    out = _engine.generate([seq])[0]

    raw_boxes = getattr(out, "bbox_entries", None) or getattr(out, "boxes", []) or []

    masks = []
    W, H = pil_img.size
    for b in raw_boxes:
        bn = b.get("bbox_norm") if isinstance(b, dict) else None
        if not bn:
            # Try other shapes
            x1 = b.get("x1") if isinstance(b, dict) else None
            if x1 is None:
                continue
            bn = {
                "x1": x1 / W if x1 > 1 else x1,
                "y1": b.get("y1", 0) / H if b.get("y1", 0) > 1 else b.get("y1", 0),
                "x2": b.get("x2", 0) / W if b.get("x2", 0) > 1 else b.get("x2", 0),
                "y2": b.get("y2", 0) / H if b.get("y2", 0) > 1 else b.get("y2", 0),
            }
        masks.append({
            "bbox_norm":     bn,
            "area_fraction": float(b.get("area_fraction", 1.0)) if isinstance(b, dict) else 1.0,
        })
    return {"count": len(masks), "masks": masks}


def _heavy_install_and_load() -> None:
    """Background thread: install heavy deps, download model, load inference engine."""
    global _engine, _processor, _model
    try:
        STATE["phase"] = "installing pip"
        _log("installing transformers + qwen-vl-utils + accelerate + safetensors …")
        if not _pip([
            "transformers>=4.49.0,<5",
            "qwen-vl-utils>=0.0.10",
            "accelerate>=0.34",
            "safetensors>=0.4",
            "einops>=0.8.0",
            "opencv-python>=4.10.0",
            "scipy>=1.13.0",
            "pycocotools>=2.0.7",
            "tyro>=0.8.0",
            "huggingface_hub>=0.26",
        ]):
            raise RuntimeError("pip install of heavy deps failed")

        STATE["phase"] = "installing falcon-perception"
        _log("installing falcon-perception (--no-deps to preserve base torch)…")
        if not _pip(["--no-deps", "falcon-perception"]):
            raise RuntimeError("pip install of falcon-perception failed")

        STATE["phase"] = "loading model"
        _log("importing falcon_perception …")
        from falcon_perception import (  # type: ignore
            PERCEPTION_MODEL_ID,
            load_and_prepare_model,
            setup_torch_config,
        )
        from falcon_perception.paged_inference import PagedInferenceEngine  # type: ignore

        STATE["model_id"] = PERCEPTION_MODEL_ID
        _log(f"model id: {PERCEPTION_MODEL_ID}")

        _log("setting up torch …")
        setup_torch_config()

        _log("loading model + processor (downloads ~600 MB on first run)…")
        load_t0 = time.time()
        _model, _processor = load_and_prepare_model(PERCEPTION_MODEL_ID)
        _log("instantiating PagedInferenceEngine…")
        _engine = PagedInferenceEngine(model=_model, processor=_processor)

        STATE["load_seconds"] = round(time.time() - load_t0, 1)
        STATE["phase"] = "ready"
        STATE["model_loaded"] = True
        _log(f"✓ READY in {time.time() - BOOT_T0:.1f}s total")

        try:
            import torch  # type: ignore
            STATE["device"] = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            pass

    except Exception as e:
        STATE["phase"] = "FAILED"
        STATE["error"] = str(e)
        _log(f"FATAL: {e}")
        _log(traceback.format_exc())


# Kick off the install thread now (server hasn't started yet but the import is done)
threading.Thread(target=_heavy_install_and_load, daemon=True).start()


# ============================================================
# Run the server
# ============================================================

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    _log(f"booting uvicorn on 0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
