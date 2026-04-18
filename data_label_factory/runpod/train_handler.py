#!/usr/bin/env python3
"""
RunPod serverless handler for YOLO training.

Materialises a small COCO-like payload into a YOLO dataset, trains a YOLOv8
model on the GPU, and returns the weights as base64 in the job output. Small
model (yolov8n = ~6 MB) keeps the response well under RunPod's output limit.

Job input schema
----------------
    {
        "query":  "construction hard hats",             # used as class name
        "images": [
            {"url": "...", "image_size": [w, h],
             "annotations": [{"bbox": [x, y, w, h], ...}, ...]},
            ...
        ],
        "epochs":  20,           # default 20
        "imgsz":   640,          # default 640
        "model":   "yolov8n.pt"  # default yolov8n
    }

Job output schema
-----------------
    {
        "ok":             true,
        "weights_b64":    "...",          # base64-encoded best.pt
        "weights_bytes":  6123456,
        "class_name":     "construction_hard_hats",
        "train_count":    12,
        "val_count":       3,
        "epochs":         20,
        "metrics":        {"metrics/mAP50(B)": 0.41, ...},
        "elapsed_seconds": 245.3
    }
"""

import base64
import io
import os
import shutil
import tempfile
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Dict, List

print("[train_handler] import", flush=True)

try:
    import requests
    from PIL import Image
    HEAVY_DEPS_OK = True
except ImportError as e:
    print(f"[train_handler] deps missing: {e}", flush=True)
    HEAVY_DEPS_OK = False


def _bbox_to_yolo(bbox, iw, ih):
    x, y, w, h = bbox
    if iw <= 0 or ih <= 0 or w <= 0 or h <= 0:
        return None
    cx = (x + w / 2) / iw
    cy = (y + h / 2) / ih
    nw = w / iw
    nh = h / ih
    return [max(0.0, min(1.0, cx)), max(0.0, min(1.0, cy)),
            max(0.001, min(1.0, nw)), max(0.001, min(1.0, nh))]


def _materialize(images, class_name, out_dir, progress):
    train_img = out_dir / "images" / "train"
    val_img = out_dir / "images" / "val"
    train_lbl = out_dir / "labels" / "train"
    val_lbl = out_dir / "labels" / "val"
    for d in (train_img, val_img, train_lbl, val_lbl):
        d.mkdir(parents=True, exist_ok=True)

    kept = 0
    val_every = max(2, len(images) // 5)
    for i, item in enumerate(images):
        url = item.get("url")
        if not url:
            continue
        try:
            r = requests.get(url, timeout=20)
            r.raise_for_status()
            img = Image.open(io.BytesIO(r.content)).convert("RGB")
            iw, ih = img.size
            lines = []
            for ann in (item.get("annotations") or []):
                b = _bbox_to_yolo(ann.get("bbox", []), iw, ih)
                if b:
                    lines.append(f"0 {b[0]:.6f} {b[1]:.6f} {b[2]:.6f} {b[3]:.6f}")
            if not lines:
                continue
            is_val = (i % val_every) == 0 and kept > 0
            idir = val_img if is_val else train_img
            ldir = val_lbl if is_val else train_lbl
            img.save(idir / f"img_{i:04d}.jpg", "JPEG", quality=92)
            (ldir / f"img_{i:04d}.txt").write_text("\n".join(lines))
            kept += 1
        except Exception as e:
            print(f"[train_handler] skip {url}: {e}", flush=True)
        progress({"stage": "materializing", "done": i + 1, "total": len(images), "kept": kept})

    train_count = len(list(train_img.glob("*.jpg")))
    val_count = len(list(val_img.glob("*.jpg")))
    if val_count == 0 and train_count > 0:
        sample = sorted(train_img.glob("*.jpg"))[-1]
        shutil.copy(sample, val_img / sample.name)
        lbl = train_lbl / (sample.stem + ".txt")
        if lbl.exists():
            shutil.copy(lbl, val_lbl / lbl.name)
        val_count = 1

    data_yaml = out_dir / "data.yaml"
    data_yaml.write_text(
        f"path: {out_dir.as_posix()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"nc: 1\n"
        f"names: [\"{class_name}\"]\n"
    )
    return train_count, val_count, data_yaml


def handler(job):
    t0 = time.time()
    try:
        import runpod
        _progress = runpod.serverless.progress_update
    except Exception:
        _progress = None

    def progress(payload):
        if _progress is None:
            return
        try:
            _progress(job, payload)
        except TypeError:
            try:
                _progress(payload)
            except Exception:
                pass
        except Exception:
            pass

    if not HEAVY_DEPS_OK:
        return {"ok": False, "error": "requests/Pillow missing in worker"}

    try:
        inp = job.get("input") or {}
        query = (inp.get("query") or "object").strip()
        images = inp.get("images") or []
        epochs = int(inp.get("epochs", 20))
        imgsz = int(inp.get("imgsz", 640))
        base_model = inp.get("model", "yolov8n.pt")

        if not images:
            return {"ok": False, "error": "input.images required"}

        class_name = query.split(",")[0].strip().lower().replace(" ", "_")[:40] or "object"
        progress({"stage": "starting", "query": query, "images": len(images), "epochs": epochs})

        with tempfile.TemporaryDirectory(prefix="yolo-train-") as tmp:
            tmp_path = Path(tmp)
            ds_dir = tmp_path / "dataset"
            ds_dir.mkdir()
            train_count, val_count, data_yaml = _materialize(images, class_name, ds_dir, progress)
            if train_count == 0:
                return {"ok": False, "error": "no usable images after download + label validation"}
            progress({"stage": "training", "train": train_count, "val": val_count})

            from ultralytics import YOLO
            model = YOLO(base_model)

            def _epoch_cb(trainer):
                try:
                    progress({
                        "stage": "training",
                        "epoch": int(trainer.epoch) + 1,
                        "total_epochs": int(trainer.epochs),
                        "train": train_count,
                        "val": val_count,
                    })
                except Exception:
                    pass
            model.add_callback("on_train_epoch_end", _epoch_cb)

            results = model.train(
                data=str(data_yaml),
                epochs=epochs,
                imgsz=imgsz,
                batch=min(16, train_count),
                project=str(tmp_path / "runs"),
                name="train",
                exist_ok=True,
                verbose=False,
                plots=False,
                workers=2,
            )

            best = tmp_path / "runs" / "train" / "weights" / "best.pt"
            if not best.exists():
                return {"ok": False, "error": "best.pt not produced"}

            data = best.read_bytes()
            b64 = base64.b64encode(data).decode("ascii")

            try:
                mdict = results.results_dict if hasattr(results, "results_dict") else {}
                metrics = {k: round(float(v), 4) for k, v in mdict.items() if isinstance(v, (int, float))}
            except Exception:
                metrics = {}

            return {
                "ok": True,
                "weights_b64": b64,
                "weights_bytes": len(data),
                "class_name": class_name,
                "train_count": train_count,
                "val_count": val_count,
                "epochs": epochs,
                "metrics": metrics,
                "elapsed_seconds": round(time.time() - t0, 2),
            }

    except Exception as e:
        return {
            "ok": False,
            "error": str(e)[:500],
            "trace": traceback.format_exc().splitlines()[-8:],
            "elapsed": round(time.time() - t0, 2),
        }


if __name__ == "__main__":
    try:
        import runpod
    except ImportError:
        import json, sys
        if len(sys.argv) > 1:
            job = json.load(open(sys.argv[1]))
            out = handler(job)
            # Don't print huge b64 in smoke tests
            if isinstance(out, dict) and "weights_b64" in out:
                out = {**out, "weights_b64": f"<{out['weights_bytes']} bytes>"}
            print(json.dumps(out, indent=2))
        else:
            print("usage: python3 train_handler.py <job.json>")
        sys.exit(0)

    runpod.serverless.start({"handler": handler})
