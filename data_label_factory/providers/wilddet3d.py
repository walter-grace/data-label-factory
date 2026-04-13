"""WildDet3D provider — open-vocabulary 2D+3D detection (13K+ categories).

WildDet3D from Allen AI uses SAM3 + LingBot-Depth for text-prompted detection.
Supports arbitrary category names at inference time — no pre-defined taxonomy.

CUDA-only: designed for RunPod GPU or local NVIDIA GPU.
Cannot run on Apple Silicon (no MPS support).

Use cases in the pipeline:
  - label: Text-prompt detection with any category name → COCO bboxes
           Massively broader vocabulary than Falcon Perception

Install: pip install torch torchvision einops timm transformers utils3d
         huggingface-cli download allenai/WildDet3D wilddet3d_alldata_all_prompt_v1.0.pt --local-dir ckpt/
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from typing import Any

from . import Provider, LabelResult, register_provider


@register_provider("wilddet3d")
class WildDet3DProvider(Provider):
    """WildDet3D open-vocabulary 3D detector (CUDA required).

    Two modes:
      1. Local: loads model directly (needs CUDA GPU + ~8GB VRAM)
      2. Remote: calls a WildDet3D HTTP server (for RunPod deployment)
    """

    @property
    def name(self) -> str:
        return "wilddet3d"

    def _mode(self) -> str:
        """'remote' if a URL is configured, else 'local'."""
        if self.config.get("url") or os.environ.get("WILDDET3D_URL"):
            return "remote"
        return "local"

    def _url(self) -> str:
        return self.config.get("url") or os.environ.get("WILDDET3D_URL", "")

    def _checkpoint(self) -> str:
        return self.config.get("checkpoint") or os.environ.get(
            "WILDDET3D_CHECKPOINT", "ckpt/wilddet3d_alldata_all_prompt_v1.0.pt"
        )

    def _score_threshold(self) -> float:
        return float(self.config.get("score_threshold", 0.3))

    def _get_model(self):
        """Lazy-load the local WildDet3D model."""
        if not hasattr(self, "_model"):
            try:
                import torch
                if not torch.cuda.is_available():
                    raise RuntimeError(
                        "WildDet3D requires CUDA. Use remote mode (set WILDDET3D_URL) "
                        "for RunPod or set up a GPU server."
                    )
                from wilddet3d import build_model
            except ImportError:
                raise ImportError(
                    "WildDet3D not installed. Clone https://github.com/allenai/WildDet3D "
                    "and run: pip install -r requirements.txt"
                )
            self._model = build_model(
                checkpoint=self._checkpoint(),
                score_threshold=self._score_threshold(),
            )
        return self._model

    def status(self) -> dict[str, Any]:
        if self._mode() == "remote":
            url = self._url()
            try:
                with urllib.request.urlopen(f"{url}/health", timeout=5) as r:
                    return {"alive": True, "info": json.loads(r.read()), "mode": "remote"}
            except Exception as e:
                return {"alive": False, "info": str(e), "mode": "remote"}
        else:
            try:
                import torch
                has_cuda = torch.cuda.is_available()
                ckpt = self._checkpoint()
                has_ckpt = os.path.exists(ckpt)
                return {
                    "alive": has_cuda and has_ckpt,
                    "info": {"cuda": has_cuda, "checkpoint": ckpt, "exists": has_ckpt},
                    "mode": "local",
                }
            except ImportError:
                return {"alive": False, "info": "torch not installed", "mode": "local"}

    def _label_local(self, image_path: str, queries: list[str],
                     image_wh: tuple[int, int]) -> LabelResult:
        """Run WildDet3D locally on CUDA."""
        import torch
        import numpy as np
        from PIL import Image
        from wilddet3d import preprocess

        model = self._get_model()
        img = np.array(Image.open(image_path).convert("RGB")).astype(np.float32)
        data = preprocess(img)

        t0 = time.time()
        with torch.no_grad():
            results = model(
                images=data["images"].cuda(),
                intrinsics=data["intrinsics"].cuda()[None],
                input_hw=[data["input_hw"]],
                original_hw=[data["original_hw"]],
                padding=[data["padding"]],
                input_texts=queries,
            )
        elapsed = time.time() - t0

        boxes, boxes3d, scores, scores_2d, scores_3d, class_ids, depth_maps = results
        iw, ih = image_wh
        annotations = []

        if len(boxes) > 0:
            b = boxes[0]  # first (only) image in batch
            s = scores[0]
            s2d = scores_2d[0]
            cids = class_ids[0]

            for j in range(len(b)):
                x1, y1, x2, y2 = b[j].cpu().numpy()
                w = max(0, float(x2 - x1))
                h = max(0, float(y2 - y1))
                cat_idx = int(cids[j].item())
                annotations.append({
                    "bbox": [round(float(x1), 2), round(float(y1), 2),
                             round(w, 2), round(h, 2)],
                    "category": queries[cat_idx] if cat_idx < len(queries) else "unknown",
                    "score": round(float(s[j].item()), 4),
                    "score_2d": round(float(s2d[j].item()), 4),
                    "source": "wilddet3d",
                })

        return LabelResult(annotations=annotations, elapsed=elapsed,
                           metadata={"mode": "local", "n_queries": len(queries)})

    def _label_remote(self, image_path: str, queries: list[str],
                      image_wh: tuple[int, int]) -> LabelResult:
        """Call a remote WildDet3D HTTP server."""
        import base64

        url = self._url()
        with open(image_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()

        payload = {
            "image_b64": img_b64,
            "queries": queries,
            "score_threshold": self._score_threshold(),
        }
        req = urllib.request.Request(
            f"{url}/detect",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
        elapsed = time.time() - t0

        annotations = []
        for det in data.get("detections", []):
            bbox = det.get("bbox", det.get("bbox_xyxy", []))
            if len(bbox) == 4:
                x1, y1, x2, y2 = bbox
                w = max(0, x2 - x1)
                h = max(0, y2 - y1)
                annotations.append({
                    "bbox": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                    "category": det.get("category", det.get("class", "unknown")),
                    "score": float(det.get("score", det.get("confidence", 0))),
                    "source": "wilddet3d",
                })

        return LabelResult(annotations=annotations, elapsed=elapsed,
                           metadata={"mode": "remote"})

    def label_image(self, image_path: str, queries: list[str],
                    image_wh: tuple[int, int] | None = None) -> LabelResult:
        if image_wh is None:
            from PIL import Image
            im = Image.open(image_path)
            image_wh = im.size

        if self._mode() == "remote":
            return self._label_remote(image_path, queries, image_wh)
        else:
            return self._label_local(image_path, queries, image_wh)
