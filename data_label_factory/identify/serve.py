"""HTTP server that serves a CLIP retrieval index over a mac_tensor-shaped
/api/falcon endpoint. Compatible with the existing data-label-factory web UI
(`web/canvas/live`) without any client changes.

Architecture per request:
    1. YOLOv8-World detects "card-shaped" regions (open-vocab "card" class)
    2. Each region is cropped, CLIP-encoded, optionally projection-headed
    3. Cosine-matched against the loaded index → top match per region
    4. If YOLO finds nothing, falls back to classifying the center crop
    5. Returns mac_tensor /api/falcon-shaped JSON so the existing proxy works

Also serves the reference images at /refs/<filename> so the live tracker UI
can show "this is what the model thinks you're holding" alongside the webcam.

Configurable via env vars:
    CARD_INDEX            path to .npz from `index` (default: card_index.npz)
    CLIP_PROJ             optional path to projection head .pt (default: clip_proj.pt)
    REFS_DIR              folder of reference images served at /refs/ (default: limit-over-pack)
    YOLO_CONF             YOLO confidence threshold (default: 0.05)
    CLIP_SIM_THRESHOLD    minimum cosine to accept a match (default: 0.70)
    CLIP_MARGIN_THRESHOLD minimum top1−top2 cosine gap to be 'confident' (default: 0.04)
    PORT                  HTTP port (default: 8500)
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import threading
import time
import traceback
from typing import Any


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="data_label_factory.identify serve",
        description=(
            "Run a mac_tensor-shaped /api/falcon HTTP server that serves a CLIP "
            "retrieval index. Compatible with the existing data-label-factory "
            "web/canvas/live UI without client changes."
        ),
    )
    parser.add_argument("--index", default=os.environ.get("CARD_INDEX", "card_index.npz"),
                        help="Path to the .npz index built by `index`")
    parser.add_argument("--projection", default=os.environ.get("CLIP_PROJ", "clip_proj.pt"),
                        help="Path to the .pt projection head from `train` (optional)")
    parser.add_argument("--refs", default=os.environ.get("REFS_DIR", "limit-over-pack"),
                        help="Folder of reference images, served at /refs/")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8500")))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--sim-threshold", type=float,
                        default=float(os.environ.get("CLIP_SIM_THRESHOLD", "0.70")))
    parser.add_argument("--margin-threshold", type=float,
                        default=float(os.environ.get("CLIP_MARGIN_THRESHOLD", "0.04")))
    parser.add_argument("--yolo-conf", type=float,
                        default=float(os.environ.get("YOLO_CONF", "0.05")))
    parser.add_argument("--no-yolo", action="store_true",
                        help="Skip YOLO detection entirely; always classify the center crop")
    args = parser.parse_args(argv)

    try:
        import numpy as np
        import torch
        import torch.nn as nn
        import torch.nn.functional as F
        from PIL import Image
        from fastapi import FastAPI, UploadFile, File, Form, HTTPException
        from fastapi.responses import JSONResponse, PlainTextResponse
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.staticfiles import StaticFiles
        import uvicorn
        import clip
    except ImportError as e:
        raise SystemExit(
            f"missing dependency: {e}\n"
            "install with:\n"
            "    pip install fastapi 'uvicorn[standard]' python-multipart pillow torch "
            "git+https://github.com/openai/CLIP.git\n"
            "  (and `pip install ultralytics` if you want YOLO detection)"
        )

    DEVICE = ("mps" if torch.backends.mps.is_available()
              else "cuda" if torch.cuda.is_available() else "cpu")
    print(f"[serve] device={DEVICE}", flush=True)

    # ---------- load CLIP + projection head ----------
    print(f"[serve] loading CLIP ViT-B/32 …", flush=True)
    clip_model, clip_preprocess = clip.load("ViT-B/32", device=DEVICE)
    clip_model.eval()

    proj_head = None
    if args.projection and os.path.exists(args.projection):
        class ProjectionHead(nn.Module):
            def __init__(self, in_dim=512, hidden=512, out_dim=256):
                super().__init__()
                self.net = nn.Sequential(
                    nn.Linear(in_dim, hidden), nn.GELU(), nn.Linear(hidden, out_dim))

            def forward(self, x):
                return F.normalize(self.net(x), dim=-1)

        ckpt = torch.load(args.projection, map_location=DEVICE)
        sd = ckpt.get("state_dict", ckpt)
        proj_head = ProjectionHead(
            in_dim=ckpt.get("in_dim", 512),
            hidden=ckpt.get("hidden", 512),
            out_dim=ckpt.get("out_dim", 256),
        ).to(DEVICE)
        proj_head.load_state_dict(sd)
        proj_head.eval()
        print(f"[serve] loaded fine-tuned projection head from {args.projection}", flush=True)
    else:
        print(f"[serve] no projection head — using raw CLIP features", flush=True)

    # ---------- load index ----------
    if not os.path.exists(args.index):
        raise SystemExit(f"index not found: {args.index}\n"
                         f"build one with: data_label_factory.identify index --refs <folder>")
    npz = np.load(args.index, allow_pickle=True)
    CARD_EMB = npz["embeddings"]
    CARD_NAMES = list(npz["names"])
    CARD_FILES = list(npz["filenames"]) if "filenames" in npz.files else ["" for _ in CARD_NAMES]
    print(f"[serve] loaded {len(CARD_NAMES)} refs from {args.index}", flush=True)

    # ---------- optional YOLO for multi-card detection ----------
    yolo = None
    if not args.no_yolo:
        try:
            from ultralytics import YOLO
            print(f"[serve] loading YOLOv8s-world for card detection …", flush=True)
            yolo = YOLO("yolov8s-world.pt")
            yolo.set_classes(["card", "trading card", "playing card"])
            print(f"[serve]   yolo ready (device={yolo.device})", flush=True)
        except Exception as e:
            print(f"[serve] YOLO unavailable ({e}); using whole-frame mode only", flush=True)

    # ---------- helpers ----------
    RARITY_SUFFIXES = {
        "pscr": "PScR", "scr": "ScR", "ur": "UR", "sr": "SR",
        "op": "OP", "utr": "UtR", "cr": "CR", "ea": "EA", "gmr": "GMR",
    }

    def _split_name_and_rarity(full: str) -> tuple[str, str]:
        parts = full.split()
        if parts and parts[-1].lower() in RARITY_SUFFIXES:
            return " ".join(parts[:-1]), RARITY_SUFFIXES[parts[-1].lower()]
        return full, ""

    def _embed_pil(pil) -> "np.ndarray":
        with torch.no_grad():
            t = clip_preprocess(pil).unsqueeze(0).to(DEVICE)
            f = clip_model.encode_image(t).float()
            f = f / f.norm(dim=-1, keepdim=True)
            if proj_head is not None:
                f = proj_head(f)
        return f.cpu().numpy()[0].astype(np.float32)

    def _identify_crop(crop, top_k: int = 3) -> dict:
        q = _embed_pil(crop)
        sims = CARD_EMB @ q
        order = np.argsort(-sims)[:top_k]
        top = [{
            "name": CARD_NAMES[i],
            "filename": CARD_FILES[i] if i < len(CARD_FILES) else "",
            "score": float(sims[i]),
        } for i in order]
        margin = top[0]["score"] - top[1]["score"] if len(top) > 1 else top[0]["score"]
        return {
            "top": top,
            "best_name": top[0]["name"],
            "best_filename": top[0]["filename"],
            "best_score": top[0]["score"],
            "margin": float(margin),
            "confident": float(margin) >= args.margin_threshold,
        }

    # ---------- FastAPI app ----------
    app = FastAPI(title="data-label-factory identify worker")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    if os.path.isdir(args.refs):
        app.mount("/refs", StaticFiles(directory=args.refs), name="refs")
        print(f"[serve] mounted /refs/ from {args.refs}", flush=True)

    _state = {"requests": 0, "last_query": ""}
    _lock = threading.Lock()

    @app.get("/")
    def root() -> PlainTextResponse:
        return PlainTextResponse(
            f"data-label-factory identify · index={len(CARD_NAMES)} refs · "
            f"requests={_state['requests']} · last_query={_state['last_query']!r}\n"
            f"POST /api/falcon (multipart: image, query) — mac_tensor-shaped\n"
            f"GET /refs/<filename> — reference images\n"
            f"GET /health — JSON status\n"
        )

    @app.get("/health")
    def health() -> dict:
        return {
            "phase": "ready",
            "model_loaded": True,
            "device": DEVICE,
            "index_size": len(CARD_NAMES),
            "has_projection": proj_head is not None,
            "has_yolo": yolo is not None,
            "sim_threshold": args.sim_threshold,
            "margin_threshold": args.margin_threshold,
            "requests_served": _state["requests"],
            "last_query": _state["last_query"],
        }

    @app.post("/api/falcon")
    async def falcon(image: UploadFile = File(...), query: str = Form(...)) -> JSONResponse:
        t0 = time.time()
        try:
            pil = Image.open(io.BytesIO(await image.read())).convert("RGB")
        except Exception as e:
            raise HTTPException(400, f"bad image: {e}")
        W, H = pil.size

        with _lock:
            _state["last_query"] = query

        masks: list[dict] = []

        # 1. YOLO multi-card detection (if available)
        if yolo is not None:
            try:
                results = yolo.predict(pil, conf=args.yolo_conf, iou=0.5, verbose=False)
                if results:
                    boxes = getattr(results[0], "boxes", None)
                    if boxes is not None and boxes.xyxy is not None:
                        for x1, y1, x2, y2 in boxes.xyxy.cpu().numpy().tolist():
                            bx1, by1 = max(0, int(x1)), max(0, int(y1))
                            bx2, by2 = min(W, int(x2)), min(H, int(y2))
                            if bx2 - bx1 < 20 or by2 - by1 < 20:
                                continue
                            crop = pil.crop((bx1, by1, bx2, by2))
                            info = _identify_crop(crop)
                            if info["best_score"] < args.sim_threshold:
                                continue
                            name, rarity = _split_name_and_rarity(info["best_name"])
                            display = f"{name} ({rarity})" if rarity else name
                            if not info["confident"]:
                                display = f"{display}?"
                            masks.append({
                                "bbox_norm": {
                                    "x1": float(x1) / W, "y1": float(y1) / H,
                                    "x2": float(x2) / W, "y2": float(y2) / H,
                                },
                                "area_fraction": float((x2 - x1) * (y2 - y1)) / max(W * H, 1),
                                "label": display,
                                "name": name,
                                "rarity": rarity,
                                "score": info["best_score"],
                                "top_k": info["top"],
                                "margin": info["margin"],
                                "confident": info["confident"],
                                "ref_filename": info["best_filename"],
                            })
            except Exception as e:
                print(f"[serve] yolo error: {e}", flush=True)

        # 2. Whole-frame fallback (single-card workflow)
        if not masks:
            cx1, cy1 = int(W * 0.10), int(H * 0.05)
            cx2, cy2 = int(W * 0.90), int(H * 0.95)
            center = pil.crop((cx1, cy1, cx2, cy2))
            info = _identify_crop(center)
            if info["best_score"] >= args.sim_threshold and info["confident"]:
                name, rarity = _split_name_and_rarity(info["best_name"])
                display = f"{name} ({rarity})" if rarity else name
                masks.append({
                    "bbox_norm": {
                        "x1": cx1 / W, "y1": cy1 / H, "x2": cx2 / W, "y2": cy2 / H,
                    },
                    "area_fraction": (cx2 - cx1) * (cy2 - cy1) / max(W * H, 1),
                    "label": display,
                    "name": name,
                    "rarity": rarity,
                    "score": info["best_score"],
                    "top_k": info["top"],
                    "margin": info["margin"],
                    "confident": True,
                    "ref_filename": info["best_filename"],
                })

        with _lock:
            _state["requests"] += 1

        return JSONResponse(content={
            "image_size": [W, H],
            "count": len(masks),
            "masks": masks,
            "query": query,
            "elapsed_seconds": round(time.time() - t0, 3),
        })

    print(f"\n[serve] listening on http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
