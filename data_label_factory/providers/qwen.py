"""Qwen 2.5-VL provider — fast YES/NO classification via mlx_vlm.server."""

from __future__ import annotations

import base64
import io
import json
import os
import time
import urllib.request
from typing import Any

from . import Provider, FilterResult, VerifyResult, register_provider


def _parse_yes_no(text: str) -> tuple[str, float]:
    """Parse YES/NO from VLM response. Returns (verdict, confidence)."""
    t = text.strip().upper()
    first = t.split()[0].rstrip(".,") if t else ""
    if "YES" in first:
        return "YES", 0.9
    if "NO" in first:
        return "NO", 0.9
    if "YES" in t:
        return "YES", 0.6
    if "NO" in t:
        return "NO", 0.6
    return "UNKNOWN", 0.0


@register_provider("qwen")
class QwenProvider(Provider):
    """Qwen 2.5-VL-3B via mlx_vlm.server (OpenAI-compatible API)."""

    @property
    def name(self) -> str:
        return "qwen"

    def _url(self) -> str:
        return self.config.get("url") or os.environ.get("QWEN_URL", "http://localhost:8291")

    def _model(self) -> str:
        return self.config.get("model") or os.environ.get(
            "QWEN_MODEL_PATH", "mlx-community/Qwen2.5-VL-3B-Instruct-4bit"
        )

    def status(self) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(f"{self._url()}/v1/models", timeout=5) as r:
                data = json.loads(r.read())
            return {"alive": True, "info": data}
        except Exception as e:
            return {"alive": False, "info": str(e)}

    def _call(self, image_path: str, prompt: str, max_tokens: int = 32,
              timeout: int = 60) -> tuple[str, float]:
        from PIL import Image
        img = Image.open(image_path).convert("RGB")
        if max(img.size) > 1024:
            ratio = 1024 / max(img.size)
            img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()

        payload = {
            "model": self._model(),
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                {"type": "text", "text": prompt},
            ]}],
            "max_tokens": max_tokens,
            "temperature": 0,
        }
        req = urllib.request.Request(
            f"{self._url()}/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
        text = data["choices"][0]["message"]["content"].strip()
        return text, time.time() - t0

    def filter_image(self, image_path: str, prompt: str) -> FilterResult:
        try:
            answer, elapsed = self._call(image_path, prompt)
            verdict, conf = _parse_yes_no(answer)
        except Exception as e:
            return FilterResult(verdict="ERROR", raw_answer=str(e), elapsed=0, confidence=0)
        return FilterResult(verdict=verdict, raw_answer=answer[:120], elapsed=elapsed, confidence=conf)

    def verify_bbox(self, image_path: str, bbox: list[float],
                    query: str, prompt: str = "") -> VerifyResult:
        from PIL import Image
        img = Image.open(image_path).convert("RGB")
        x, y, w, h = bbox
        crop = img.crop((int(x), int(y), int(x + w), int(y + h)))
        # Save crop to temp file
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            crop.save(f, format="PNG")
            crop_path = f.name
        try:
            if not prompt:
                prompt = (
                    f"Is the main object in this crop actually a {query}? "
                    "Answer YES, NO, or UNSURE in one word, then briefly describe what you see."
                )
            answer, elapsed = self._call(crop_path, prompt, max_tokens=64)
            verdict, conf = _parse_yes_no(answer)
        except Exception as e:
            return VerifyResult(verdict="ERROR", raw_answer=str(e), elapsed=0)
        finally:
            os.unlink(crop_path)
        return VerifyResult(verdict=verdict, raw_answer=answer[:120], elapsed=elapsed, confidence=conf)
