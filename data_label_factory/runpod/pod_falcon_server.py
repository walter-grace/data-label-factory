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
_tokenizer = None
_image_processor = None
_model = None
_model_args = None
_sampling_params = None
_torch = None  # cached torch module reference


def _run_inference(pil_img: "Image.Image", query: str) -> dict:
    """Single-image Falcon Perception forward pass.

    Uses task='segmentation' per the prior session learning ('detection mode
    returns empty bboxes'). Extracts bboxes from each segmentation mask via
    pycocotools mask decoding.
    """
    if _engine is None:
        raise RuntimeError("model not loaded")

    from falcon_perception import build_prompt_for_task  # type: ignore
    from falcon_perception.paged_inference import Sequence  # type: ignore

    W, H = pil_img.size
    task = "segmentation" if getattr(_model_args, "do_segmentation", False) else "detection"
    prompt = build_prompt_for_task(query, task)

    sequences = [Sequence(
        text=prompt,
        image=pil_img,
        min_image_size=256,
        max_image_size=1024,
        task=task,
    )]
    with _torch.inference_mode():
        _engine.generate(
            sequences,
            sampling_params=_sampling_params,
            use_tqdm=False,
            print_stats=False,
        )
    seq = sequences[0]
    aux = seq.output_aux

    masks_out: list[dict] = []

    # Path A: detection mode (bboxes_raw is populated)
    bboxes_raw = getattr(aux, "bboxes_raw", None)
    if bboxes_raw:
        try:
            from falcon_perception.visualization_utils import pair_bbox_entries  # type: ignore
            pairs = pair_bbox_entries(bboxes_raw)
            for entry in pairs:
                if hasattr(entry, "_asdict"):
                    d = entry._asdict()
                elif isinstance(entry, dict):
                    d = entry
                else:
                    vals = list(entry)
                    if len(vals) < 5:
                        continue
                    d = {"x1": vals[1], "y1": vals[2], "x2": vals[3], "y2": vals[4]}
                x1 = float(d.get("x1", 0)); y1 = float(d.get("y1", 0))
                x2 = float(d.get("x2", 0)); y2 = float(d.get("y2", 0))
                masks_out.append({
                    "bbox_norm": {
                        "x1": x1 / W if x1 > 1.5 else x1,
                        "y1": y1 / H if y1 > 1.5 else y1,
                        "x2": x2 / W if x2 > 1.5 else x2,
                        "y2": y2 / H if y2 > 1.5 else y2,
                    },
                    "area_fraction": ((x2 - x1) * (y2 - y1)) / (W * H) if W and H else 0.0,
                })
        except Exception as e:
            _log(f"pair_bbox_entries failed: {e}")

    # Path B: segmentation mode (masks_rle is populated)
    if not masks_out:
        masks_rle = getattr(aux, "masks_rle", None) or []
        for m in masks_rle:
            try:
                # Try to extract a bbox from the mask. Multiple possible shapes.
                if isinstance(m, dict) and "bbox" in m:
                    bb = m["bbox"]  # could be [x,y,w,h] or [x1,y1,x2,y2]
                    if len(bb) == 4:
                        x1, y1 = float(bb[0]), float(bb[1])
                        # Heuristic: if last two are smaller than first two, treat as w/h
                        if bb[2] < bb[0] or bb[3] < bb[1]:
                            x2, y2 = x1 + float(bb[2]), y1 + float(bb[3])
                        else:
                            x2, y2 = float(bb[2]), float(bb[3])
                        masks_out.append({
                            "bbox_norm": {
                                "x1": x1 / W if x1 > 1.5 else x1,
                                "y1": y1 / H if y1 > 1.5 else y1,
                                "x2": x2 / W if x2 > 1.5 else x2,
                                "y2": y2 / H if y2 > 1.5 else y2,
                            },
                            "area_fraction": float(m.get("area", (x2 - x1) * (y2 - y1))) / max(W * H, 1),
                        })
                        continue
                # Fall back to decoding the RLE mask via pycocotools
                from pycocotools import mask as maskUtils  # type: ignore
                import numpy as np  # type: ignore
                rle = m if isinstance(m, dict) else {"counts": m, "size": [H, W]}
                if "size" not in rle:
                    rle["size"] = [H, W]
                if isinstance(rle.get("counts"), str):
                    rle["counts"] = rle["counts"].encode()
                decoded = maskUtils.decode(rle)
                if decoded is None or decoded.size == 0:
                    continue
                ys, xs = np.where(decoded > 0)
                if xs.size == 0:
                    continue
                x1, y1 = int(xs.min()), int(ys.min())
                x2, y2 = int(xs.max()), int(ys.max())
                masks_out.append({
                    "bbox_norm": {"x1": x1 / W, "y1": y1 / H, "x2": x2 / W, "y2": y2 / H},
                    "area_fraction": float(decoded.sum()) / max(W * H, 1),
                })
            except Exception as e:
                _log(f"mask parse failed: {e}")

    return {"count": len(masks_out), "masks": masks_out}


def _heavy_install_and_load() -> None:
    """Background thread: install heavy deps, download model, load inference engine."""
    global _engine, _tokenizer, _image_processor, _model, _model_args, _sampling_params, _torch
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
            "numpy<2",  # falcon-perception is happier with numpy 1.x
        ]):
            raise RuntimeError("pip install of heavy deps failed")

        STATE["phase"] = "installing falcon-perception"
        _log("installing falcon-perception (--no-deps to preserve base torch)…")
        if not _pip(["--no-deps", "falcon-perception"]):
            raise RuntimeError("pip install of falcon-perception failed")

        STATE["phase"] = "loading model"
        _log("importing torch + falcon_perception …")
        import torch as _t  # type: ignore
        _torch = _t

        from falcon_perception import (  # type: ignore
            PERCEPTION_MODEL_ID,
            build_prompt_for_task,
            load_and_prepare_model,
            setup_torch_config,
        )
        from falcon_perception.data import ImageProcessor  # type: ignore
        from falcon_perception.paged_inference import (  # type: ignore
            PagedInferenceEngine,
            SamplingParams,
            Sequence,
        )

        STATE["model_id"] = PERCEPTION_MODEL_ID
        _log(f"model id: {PERCEPTION_MODEL_ID}")
        _log("setting up torch …")
        setup_torch_config()

        _log("loading model + processor (downloads ~600 MB on first run, may take 2-5 min)…")
        load_t0 = time.time()
        _model, _tokenizer, _model_args = load_and_prepare_model(
            hf_model_id=PERCEPTION_MODEL_ID,
            hf_revision="main",
            hf_local_dir=None,
            device=None,         # let model pick CUDA
            dtype="bfloat16",
            compile=False,       # skip torch.compile to keep load fast (~30s vs 60s+)
        )
        _log("instantiating ImageProcessor + PagedInferenceEngine…")
        _image_processor = ImageProcessor(patch_size=16, merge_size=1)
        _engine = PagedInferenceEngine(
            _model, _tokenizer, _image_processor,
            max_batch_size=1,
            max_seq_length=8192,
            n_pages=128,
            page_size=128,
            prefill_length_limit=8192,
            enable_hr_cache=False,
            capture_cudagraph=False,
        )
        _sampling_params = SamplingParams(
            stop_token_ids=[_tokenizer.eos_token_id, _tokenizer.end_of_query_token_id],
        )

        STATE["load_seconds"] = round(time.time() - load_t0, 1)
        STATE["device"] = "cuda" if _torch.cuda.is_available() else "cpu"

        # Quick warmup so the first real request isn't 30s slower than steady state
        _log("warmup pass on a dummy image…")
        warmup_img = Image.new("RGB", (256, 256), color=(128, 128, 128))
        warmup_seqs = [Sequence(
            text=build_prompt_for_task("anything", "detection"),
            image=warmup_img,
            min_image_size=256,
            max_image_size=512,
            task="detection",
        )]
        with _torch.inference_mode():
            _engine.generate(warmup_seqs, sampling_params=_sampling_params,
                             use_tqdm=False, print_stats=False)

        STATE["phase"] = "ready"
        STATE["model_loaded"] = True
        _log(f"✓ READY in {time.time() - BOOT_T0:.1f}s total")

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
