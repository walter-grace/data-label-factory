"""Falcon Perception provider — bbox grounding via mac_tensor /api/falcon."""

from __future__ import annotations

import io
import json
import os
import time
import urllib.request
from typing import Any

from . import Provider, LabelResult, register_provider


@register_provider("falcon")
class FalconProvider(Provider):
    """Falcon Perception 0.6B via mac_tensor /api/falcon endpoint.

    Label-only provider: returns COCO-format bounding boxes for text queries.
    Must use task="segmentation" (detection returns empty bboxes).
    """

    @property
    def name(self) -> str:
        return "falcon"

    def _url(self) -> str:
        return self.config.get("url") or os.environ.get("GEMMA_URL", "http://localhost:8500")

    def status(self) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(f"{self._url()}/api/info", timeout=5) as r:
                data = json.loads(r.read())
            return {"alive": True, "info": data}
        except Exception as e:
            return {"alive": False, "info": str(e)}

    def _call_falcon(self, image_path: str, query: str, timeout: int = 120) -> dict:
        boundary = f"----factory{int(time.time() * 1000)}"
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
            f"{self._url()}/api/falcon",
            data=body.getvalue(),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
        data["_elapsed_seconds"] = time.time() - t0
        return data

    def label_image(self, image_path: str, queries: list[str],
                    image_wh: tuple[int, int] | None = None) -> LabelResult:
        if image_wh is None:
            from PIL import Image
            im = Image.open(image_path)
            image_wh = im.size

        iw, ih = image_wh
        annotations = []
        total_elapsed = 0.0

        for query in queries:
            try:
                resp = self._call_falcon(image_path, query, timeout=180)
                total_elapsed += resp.get("_elapsed_seconds", 0)
                masks = resp.get("masks", [])
            except Exception as e:
                masks = []

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
                annotations.append({
                    "bbox": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                    "category": query,
                    "score": float(m.get("area_fraction", 1.0)),
                    "source": "falcon",
                })

        return LabelResult(annotations=annotations, elapsed=total_elapsed)
