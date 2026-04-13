"""Gemma 4 provider — richer reasoning via mac_tensor /api/chat_vision (SSE)."""

from __future__ import annotations

import io
import json
import os
import time
import urllib.request
from typing import Any

from . import Provider, FilterResult, VerifyResult, register_provider


def _strip_thinking(text: str) -> str:
    """Strip Gemma 4's <think>...</think> and 'thought' prefix tokens."""
    import re
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
    # Gemma 4 sometimes emits bare "thought\nthought\n" prefixes
    text = re.sub(r'^(?:thought\s*\n?\s*)+', '', text, flags=re.IGNORECASE)
    return text.strip()


def _parse_yes_no(text: str) -> tuple[str, float]:
    text = _strip_thinking(text)
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


@register_provider("gemma")
class GemmaProvider(Provider):
    """Gemma 4-26B-A4B via mac_tensor /api/chat_vision (SSE streaming)."""

    @property
    def name(self) -> str:
        return "gemma"

    def _url(self) -> str:
        return self.config.get("url") or os.environ.get("GEMMA_URL", "http://localhost:8500")

    def status(self) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(f"{self._url()}/api/info", timeout=5) as r:
                data = json.loads(r.read())
            return {"alive": True, "info": data}
        except Exception as e:
            return {"alive": False, "info": str(e)}

    def _call(self, image_path: str, prompt: str, max_tokens: int = 64,
              timeout: int = 300) -> tuple[str, float]:
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
        part("message", prompt)
        part("max_tokens", str(max_tokens))
        part("image", img_bytes, filename=os.path.basename(image_path), content_type="image/jpeg")
        body.write(f"--{boundary}--\r\n".encode())

        req = urllib.request.Request(
            f"{self._url()}/api/chat_vision",
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
        text = _strip_thinking((final_text or "".join(chunks)).strip())
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
