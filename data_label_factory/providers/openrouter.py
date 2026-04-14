"""OpenRouter provider — any VLM model for filter/verify via OpenRouter API.

OpenRouter gives you access to hundreds of models (Gemma, Claude, GPT-4V,
Llama, Qwen, Mistral, etc.) through a single OpenAI-compatible API.
This turns data-label-factory into a model benchmark tool: run the same
images through different VLMs and compare filter/verify accuracy.

Usage:
    # Set your API key
    export OPENROUTER_API_KEY=sk-or-...

    # Filter with Gemma 3 via OpenRouter
    data_label_factory filter --project projects/drones.yaml --backend openrouter

    # Benchmark multiple models (set model via env or config)
    OPENROUTER_MODEL=google/gemma-4-26b-a4b-it data_label_factory filter ...
    OPENROUTER_MODEL=meta-llama/llama-4-scout data_label_factory filter ...
    OPENROUTER_MODEL=anthropic/claude-sonnet-4 data_label_factory filter ...

    # In project YAML:
    backends:
      filter: openrouter
      label: falcon          # still use Falcon for bbox grounding
      verify: openrouter

    openrouter:
      model: google/gemma-4-26b-a4b-it
      # or any model from https://openrouter.ai/models
"""

from __future__ import annotations

import base64
import io
import json
import os
import time
import urllib.request
from typing import Any

import re as _re

from . import Provider, FilterResult, VerifyResult, LabelResult, register_provider


API_URL = "https://openrouter.ai/api/v1/chat/completions"


def _strip_thinking(text: str) -> str:
    """Strip thinking tokens from models that emit them (Gemma 4, etc.)."""
    import re
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
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


@register_provider("openrouter")
class OpenRouterProvider(Provider):
    """Any VLM model via OpenRouter's OpenAI-compatible API.

    Config / env vars:
      OPENROUTER_API_KEY  — required
      OPENROUTER_MODEL    — model ID (default: google/gemma-4-26b-a4b-it)
      OPENROUTER_URL      — API endpoint (default: https://openrouter.ai/api/v1/chat/completions)
    """

    @property
    def name(self) -> str:
        return "openrouter"

    def _api_key(self) -> str:
        key = self.config.get("api_key") or os.environ.get("OPENROUTER_API_KEY", "")
        if not key:
            raise ValueError(
                "OPENROUTER_API_KEY not set. Get one at https://openrouter.ai/keys"
            )
        return key

    def _model(self) -> str:
        return (
            self.config.get("model")
            or os.environ.get("OPENROUTER_MODEL", "google/gemma-4-26b-a4b-it")
        )

    def _url(self) -> str:
        return self.config.get("url") or os.environ.get("OPENROUTER_URL", API_URL)

    def status(self) -> dict[str, Any]:
        try:
            key = self._api_key()
            model = self._model()
            return {
                "alive": True,
                "info": {
                    "model": model,
                    "key_set": bool(key),
                    "url": self._url(),
                },
            }
        except ValueError as e:
            return {"alive": False, "info": str(e)}

    def _call(self, image_path: str, prompt: str, max_tokens: int = 64,
              timeout: int = 60) -> tuple[str, float, dict]:
        """Call OpenRouter with an image + text prompt.
        Returns (text, elapsed_seconds, usage_dict).
        """
        from PIL import Image

        img = Image.open(image_path).convert("RGB")
        if max(img.size) > 1024:
            ratio = 1024 / max(img.size)
            img = img.resize(
                (int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS
            )
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()

        payload = {
            "model": self._model(),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{b64}"},
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "max_tokens": max_tokens,
            "temperature": 0,
        }

        req = urllib.request.Request(
            self._url(),
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key()}",
                "HTTP-Referer": "https://github.com/walter-grace/data-label-factory",
                "X-Title": "data-label-factory",
            },
            method="POST",
        )

        t0 = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
        elapsed = time.time() - t0

        text = data["choices"][0]["message"]["content"].strip()
        usage = data.get("usage", {})
        return text, elapsed, usage

    def _call_text_only(self, prompt: str, max_tokens: int = 64,
                        timeout: int = 30) -> tuple[str, float]:
        """Call OpenRouter with text-only prompt (no image)."""
        payload = {
            "model": self._model(),
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0,
        }
        req = urllib.request.Request(
            self._url(),
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key()}",
                "HTTP-Referer": "https://github.com/walter-grace/data-label-factory",
                "X-Title": "data-label-factory",
            },
            method="POST",
        )
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
        text = data["choices"][0]["message"]["content"].strip()
        return text, time.time() - t0

    def filter_image(self, image_path: str, prompt: str) -> FilterResult:
        try:
            answer, elapsed, usage = self._call(image_path, prompt, max_tokens=32)
            verdict, conf = _parse_yes_no(answer)
        except Exception as e:
            return FilterResult(
                verdict="ERROR", raw_answer=str(e), elapsed=0, confidence=0
            )
        return FilterResult(
            verdict=verdict,
            raw_answer=answer[:120],
            elapsed=elapsed,
            confidence=conf,
        )

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
                    "Answer YES, NO, or UNSURE in one word, then briefly describe "
                    "what you see."
                )
            answer, elapsed, usage = self._call(crop_path, prompt, max_tokens=64)
            verdict, conf = _parse_yes_no(answer)
        except Exception as e:
            return VerifyResult(verdict="ERROR", raw_answer=str(e), elapsed=0)
        finally:
            os.unlink(crop_path)

        return VerifyResult(
            verdict=verdict,
            raw_answer=answer[:120],
            elapsed=elapsed,
            confidence=conf,
        )

    def label_image(self, image_path: str, queries: list[str],
                    image_wh: tuple[int, int] | None = None) -> LabelResult:
        """Bbox detection via Gemma 4 vision grounding.

        Prompts the model to return bounding box coordinates for each query.
        Gemma 4 supports grounded detection — it returns [y1, x1, y2, x2]
        normalized to 0-1000 when prompted correctly.
        """
        if image_wh is None:
            from PIL import Image
            im = Image.open(image_path)
            image_wh = im.size

        iw, ih = image_wh
        all_annotations = []
        total_elapsed = 0.0

        for query in queries:
            prompt = (
                f"Detect all instances of \"{query}\" in this image. "
                f"For each instance, return a bounding box as [ymin, xmin, ymax, xmax] "
                f"with coordinates normalized from 0 to 1000. "
                f"Format each detection on its own line as: "
                f"[ymin, xmin, ymax, xmax] label\n"
                f"If none found, say NONE."
            )

            try:
                answer, elapsed, _ = self._call(image_path, prompt, max_tokens=512, timeout=30)
                answer = _strip_thinking(answer)
                total_elapsed += elapsed
            except Exception as e:
                continue

            # Parse bbox lines: [y1, x1, y2, x2] label
            for line in answer.split("\n"):
                line = line.strip()
                match = _re.search(r'\[(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\]', line)
                if match:
                    y1 = int(match.group(1)) / 1000.0 * ih
                    x1 = int(match.group(2)) / 1000.0 * iw
                    y2 = int(match.group(3)) / 1000.0 * ih
                    x2 = int(match.group(4)) / 1000.0 * iw
                    w = max(0, x2 - x1)
                    h = max(0, y2 - y1)
                    if w > 0 and h > 0:
                        all_annotations.append({
                            "bbox": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                            "category": query,
                            "score": 0.8,
                            "source": "openrouter",
                        })

        return LabelResult(
            annotations=all_annotations,
            elapsed=total_elapsed,
            metadata={"model": self._model()},
        )
