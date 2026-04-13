"""Chandra OCR 2 provider — document/text labeling with spatial annotations.

Chandra is a 5B OCR model that returns text bounding boxes, table structures,
and layout regions. It can run on Apple Silicon (via vllm-metal or HF) or GPU.

Use cases in the pipeline:
  - filter: High-confidence OCR presence → YES (text-heavy image), NO (no text)
  - label:  Text region bboxes as COCO annotations (paragraphs, tables, headers)
  - verify: Cross-check text content against expected patterns

Install: pip install chandra-ocr
         pip install chandra-ocr[hf]    # for HuggingFace backend
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from . import Provider, FilterResult, LabelResult, VerifyResult, register_provider


@register_provider("chandra")
class ChandraProvider(Provider):
    """Chandra OCR 2 (datalab-to/chandra-ocr-2) for text/document labeling."""

    @property
    def name(self) -> str:
        return "chandra"

    def _get_manager(self):
        """Lazy-init the inference manager."""
        if not hasattr(self, "_manager"):
            try:
                from chandra.model import InferenceManager
            except ImportError:
                raise ImportError(
                    "chandra-ocr not installed. Run: pip install chandra-ocr[hf]"
                )
            method = self.config.get("method", "hf")  # "hf" or "vllm"
            self._manager = InferenceManager(method=method)
        return self._manager

    def _get_hf_model(self):
        """Lazy-init the HF model for direct usage without InferenceManager."""
        if not hasattr(self, "_hf_model"):
            try:
                from transformers import AutoModelForImageTextToText, AutoProcessor
                import torch
            except ImportError:
                raise ImportError(
                    "transformers not installed. Run: pip install chandra-ocr[hf]"
                )
            model_id = self.config.get("model_id", "datalab-to/chandra-ocr-2")
            dtype = torch.bfloat16 if torch.backends.mps.is_available() else torch.float16
            device_map = "auto"
            self._hf_model = AutoModelForImageTextToText.from_pretrained(
                model_id, torch_dtype=dtype, device_map=device_map
            )
            self._hf_model.eval()
            self._hf_model.processor = AutoProcessor.from_pretrained(model_id)
            self._hf_model.processor.tokenizer.padding_side = "left"
        return self._hf_model

    def status(self) -> dict[str, Any]:
        try:
            import chandra
            return {"alive": True, "info": {"package": "chandra-ocr", "installed": True}}
        except ImportError:
            return {"alive": False, "info": "chandra-ocr not installed"}

    def _ocr_image(self, image_path: str) -> dict:
        """Run OCR on an image, return parsed result with text + bboxes."""
        from PIL import Image

        img = Image.open(image_path).convert("RGB")

        try:
            # Try the high-level InferenceManager API first
            from chandra.model import InferenceManager
            from chandra.model.schema import BatchInputItem
            from chandra.output import parse_markdown

            manager = self._get_manager()
            batch = [BatchInputItem(image=img, prompt_type="ocr_layout")]
            result = manager.generate(batch)[0]

            return {
                "markdown": getattr(result, "markdown", ""),
                "raw": getattr(result, "raw", ""),
                "blocks": getattr(result, "blocks", []),
                "image_wh": img.size,
            }
        except (ImportError, AttributeError):
            # Fallback: use HF transformers directly
            from chandra.model.hf import generate_hf
            from chandra.model.schema import BatchInputItem

            model = self._get_hf_model()
            batch = [BatchInputItem(image=img, prompt_type="ocr_layout")]
            result = generate_hf(batch, model)[0]

            return {
                "markdown": getattr(result, "markdown", str(result)),
                "raw": getattr(result, "raw", str(result)),
                "blocks": getattr(result, "blocks", []),
                "image_wh": img.size,
            }

    def filter_image(self, image_path: str, prompt: str) -> FilterResult:
        """Filter based on OCR text presence and confidence.

        If the image contains substantive text (>20 chars extracted), YES.
        This is useful for filtering document-heavy datasets.
        """
        t0 = time.time()
        try:
            result = self._ocr_image(image_path)
            text = result.get("markdown", "") or result.get("raw", "")
            elapsed = time.time() - t0

            # Heuristic: substantive text = likely a document/text-heavy image
            text_len = len(text.strip())
            min_chars = self.config.get("min_text_chars", 20)

            if text_len >= min_chars:
                return FilterResult(
                    verdict="YES",
                    raw_answer=f"OCR extracted {text_len} chars: {text[:80]}...",
                    elapsed=elapsed,
                    confidence=min(1.0, text_len / 200),
                )
            else:
                return FilterResult(
                    verdict="NO",
                    raw_answer=f"OCR extracted only {text_len} chars",
                    elapsed=elapsed,
                    confidence=max(0.0, 1.0 - text_len / 20),
                )
        except Exception as e:
            return FilterResult(verdict="ERROR", raw_answer=str(e),
                                elapsed=time.time() - t0, confidence=0)

    def label_image(self, image_path: str, queries: list[str],
                    image_wh: tuple[int, int] | None = None) -> LabelResult:
        """Extract text regions as COCO bounding box annotations.

        Each text block/region from Chandra becomes an annotation with:
          - bbox in COCO format [x, y, w, h] (pixel coords)
          - category: the block type (text, table, header, etc.)
          - text: the extracted text content
          - score: OCR confidence
        """
        t0 = time.time()
        try:
            result = self._ocr_image(image_path)
            elapsed = time.time() - t0
        except Exception as e:
            return LabelResult(annotations=[], elapsed=time.time() - t0,
                               metadata={"error": str(e)})

        iw, ih = image_wh or result.get("image_wh", (1, 1))
        annotations = []
        blocks = result.get("blocks", [])

        for block in blocks:
            bbox_raw = block.get("bbox") or block.get("bounding_box")
            if not bbox_raw:
                continue

            # Chandra returns [x1, y1, x2, y2] normalized 0-1
            if isinstance(bbox_raw, (list, tuple)) and len(bbox_raw) == 4:
                x1, y1, x2, y2 = bbox_raw
                # If normalized (all values 0-1), scale to pixels
                if all(0 <= v <= 1.0 for v in bbox_raw):
                    x1, y1, x2, y2 = x1 * iw, y1 * ih, x2 * iw, y2 * ih
                w = max(0, x2 - x1)
                h = max(0, y2 - y1)
            else:
                continue

            block_type = block.get("type", "text")
            text_content = ""
            for line in block.get("lines", []):
                if isinstance(line, dict):
                    text_content += line.get("text", "") + " "
                elif isinstance(line, str):
                    text_content += line + " "

            # Match against queries if provided (e.g. ["table", "header"])
            category = block_type
            if queries:
                matched = any(q.lower() in block_type.lower() for q in queries)
                if not matched and text_content.strip():
                    matched = any(q.lower() in text_content.lower() for q in queries)
                if not matched:
                    continue
                category = next((q for q in queries if q.lower() in block_type.lower()), queries[0])

            annotations.append({
                "bbox": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                "category": category,
                "score": float(block.get("conf", block.get("confidence", 0.8))),
                "text": text_content.strip()[:200],
                "source": "chandra",
            })

        # If no structured blocks, create a single annotation from the full text
        if not blocks and result.get("markdown", "").strip():
            annotations.append({
                "bbox": [0, 0, round(iw, 2), round(ih, 2)],
                "category": "document",
                "score": 0.5,
                "text": result["markdown"][:200],
                "source": "chandra",
            })

        return LabelResult(
            annotations=annotations,
            elapsed=elapsed,
            metadata={
                "total_text_length": len(result.get("markdown", "")),
                "block_count": len(blocks),
            },
        )

    def verify_bbox(self, image_path: str, bbox: list[float],
                    query: str, prompt: str = "") -> VerifyResult:
        """Verify a bbox by running OCR on the crop and checking for expected content."""
        from PIL import Image

        t0 = time.time()
        try:
            img = Image.open(image_path).convert("RGB")
            x, y, w, h = bbox
            crop = img.crop((int(x), int(y), int(x + w), int(y + h)))

            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                crop.save(f, format="PNG")
                crop_path = f.name

            try:
                result = self._ocr_image(crop_path)
                text = (result.get("markdown", "") or result.get("raw", "")).strip()
            finally:
                os.unlink(crop_path)

            elapsed = time.time() - t0

            if query.lower() in ("text", "document", "paragraph"):
                verdict = "YES" if len(text) > 10 else "NO"
            elif query.lower() == "table":
                verdict = "YES" if "|" in text or "table" in text.lower() else "NO"
            else:
                verdict = "YES" if query.lower() in text.lower() else "UNSURE"

            return VerifyResult(
                verdict=verdict,
                raw_answer=f"OCR text ({len(text)} chars): {text[:100]}",
                elapsed=elapsed,
                confidence=0.7 if verdict == "YES" else 0.3,
            )
        except Exception as e:
            return VerifyResult(verdict="ERROR", raw_answer=str(e),
                                elapsed=time.time() - t0)
