"""LiteParse provider — local document parsing for AI agents.

LiteParse (https://github.com/llamaindex/liteparse) is a layout-preserving
document parser that runs entirely locally. No GPU, no Python deps: it ships
as a Node CLI + library. Supports PDF / DOCX / XLSX / PPTX / PNG / JPG / TIFF.

Unlike chandra (heavy 5B OCR model), LiteParse is designed for real-time agent
pipelines. Output is plain text that preserves spatial layout via grid
projection — LLMs can read the table structure directly without VLM parsing.

Install:
    npm i -g @llamaindex/liteparse          # the `lit` CLI on PATH
    brew install libreoffice                # DOCX / XLSX / PPTX conversion
    brew install imagemagick                # TIFF / heavy image preproc

RAM safety on Mac Mini (16 GB):
    - Defaults to OCR OFF. OCR is the heaviest path (Tesseract.js).
    - `lit` defaults to `--num-workers = CPUs - 1` (too many). We force 1.
    - Hard file-size cap: 50 MB. Large PDFs get rejected upstream.
    - Hard timeout: 60 s. Kills runaway subprocess.
    - Single subprocess per call. No parallel spawns. The caller is
      responsible for throttling concurrent requests.
    - Optional `max_pages` cap as defense-in-depth for giant docs.

Usage in the registry (same shape as chandra):
    filter: YES if extracted text length >= min_chars, else NO.
    label:  text blocks as COCO annotations (paragraph / table / header).
    verify: OCR the bbox crop, check text content.

    from data_label_factory.providers import create_provider
    p = create_provider("liteparse")
    result = p.label_image("report.pdf", ["table", "header"])
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from . import Provider, FilterResult, LabelResult, VerifyResult, register_provider


# ── RAM-safe defaults (override via config) ─────────────────────────────
DEFAULT_MAX_FILE_MB = 50      # reject files bigger than this before spawn
DEFAULT_TIMEOUT_SEC = 60      # kill subprocess if it runs longer
DEFAULT_MIN_TEXT_CHARS = 20   # threshold for filter() YES
SUPPORTED_EXTS = {".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".tiff", ".tif"}


def _normalize_lit_json(raw: dict) -> dict:
    """Normalize lit's JSON shape into a uniform structure.

    lit emits:
        {"pages": [
            {"page": 1, "width": 612, "height": 792,
             "text": "...",
             "textItems": [{"text","x","y","width","height","fontSize","confidence"}],
             "boundingBoxes": [{"x1","y1","x2","y2"}]}
        ]}

    We normalize to:
        {"text": "...concatenated across pages...",
         "pages": [
             {"page", "width", "height", "text",
              "blocks": [{"type","bbox":[x1,y1,x2,y2],"text","confidence"}]}
         ],
         "_raw": {...original textItems preserved for advanced callers...}}
    """
    pages_out = []
    all_text = []
    for page in raw.get("pages", []) or []:
        page_text = page.get("text", "") or ""
        all_text.append(page_text)

        items = page.get("textItems", []) or []
        blocks = []
        for it in items:
            x = it.get("x", 0)
            y = it.get("y", 0)
            w = it.get("width", 0)
            h = it.get("height", 0)
            size = it.get("fontSize", 0)
            # Crude heuristic: font size >= 20 → header, else paragraph
            btype = "header" if size and size >= 20 else "paragraph"
            blocks.append({
                "type": btype,
                "bbox": [x, y, x + w, y + h],
                "text": it.get("text", ""),
                "confidence": it.get("confidence", 1.0),
                "font_size": size,
            })

        pages_out.append({
            "page": page.get("page"),
            "width": page.get("width"),
            "height": page.get("height"),
            "text": page_text,
            "blocks": blocks,
        })

    return {
        "text": "\n\n".join(t for t in all_text if t),
        "pages": pages_out,
    }


@register_provider("liteparse")
class LiteParseProvider(Provider):
    """LiteParse — local, lightweight, layout-preserving document parser."""

    @property
    def name(self) -> str:
        return "liteparse"

    # ── status ─────────────────────────────────────────────────────────

    def status(self) -> dict[str, Any]:
        """Check that the `lit` CLI is installed and runnable."""
        bin_path = shutil.which(self.config.get("bin", "lit"))
        if not bin_path:
            return {
                "alive": False,
                "info": "lit CLI not found. Install: npm i -g @llamaindex/liteparse",
            }
        try:
            out = subprocess.run(
                [bin_path, "--version"],
                capture_output=True, text=True, timeout=5,
            )
            version = (out.stdout or out.stderr).strip() or "unknown"
        except Exception as e:
            return {"alive": False, "info": f"lit --version failed: {e}"}

        # Optional system deps (for DOCX/XLSX/PPTX and TIFF)
        optional = {
            "libreoffice": bool(shutil.which("libreoffice") or shutil.which("soffice")),
            "imagemagick": bool(shutil.which("magick") or shutil.which("convert")),
            "tesseract":   bool(shutil.which("tesseract")),  # optional — bundled via tesseract.js
        }

        return {
            "alive": True,
            "info": {
                "bin": bin_path,
                "version": version,
                "optional": optional,
                "ram_safety": {
                    "max_file_mb": self.config.get("max_file_mb", DEFAULT_MAX_FILE_MB),
                    "timeout_sec": self.config.get("timeout_sec", DEFAULT_TIMEOUT_SEC),
                    "ocr_default": self.config.get("ocr", False),
                },
            },
        }

    # ── core: shell out to `lit parse --json` ──────────────────────────

    def _run_parse(self, path: str, ocr: bool | None = None) -> dict:
        """Invoke `lit parse <file> --json`. Returns parsed dict or raises."""
        if not os.path.exists(path):
            raise FileNotFoundError(f"file not found: {path}")

        size_mb = os.path.getsize(path) / (1024 * 1024)
        max_mb = self.config.get("max_file_mb", DEFAULT_MAX_FILE_MB)
        if size_mb > max_mb:
            raise ValueError(
                f"file too large ({size_mb:.1f} MB > {max_mb} MB cap). "
                f"Split the document or raise max_file_mb in provider config."
            )

        ext = Path(path).suffix.lower()
        if ext not in SUPPORTED_EXTS:
            raise ValueError(
                f"unsupported extension {ext!r}. "
                f"LiteParse supports: {', '.join(sorted(SUPPORTED_EXTS))}"
            )

        use_ocr = self.config.get("ocr", False) if ocr is None else ocr
        bin_path = shutil.which(self.config.get("bin", "lit"))
        if not bin_path:
            raise RuntimeError(
                "lit CLI not on PATH. Install: npm i -g @llamaindex/liteparse"
            )

        # `lit parse` flags:
        #   --format json      — JSON output (we parse it)
        #   --no-ocr           — OCR is ON by default in lit; we invert so OCR is opt-in
        #   --num-workers 1    — RAM-safety on Mac Mini (default is CPU-1, which can spike)
        #   -q                 — suppress progress noise on stderr
        #   --max-pages N      — cap pages processed (defense-in-depth vs huge PDFs)
        cmd = [bin_path, "parse", path, "--format", "json", "-q"]
        if not use_ocr:
            cmd.append("--no-ocr")
        workers = int(self.config.get("num_workers", 1))
        cmd.extend(["--num-workers", str(workers)])
        max_pages = self.config.get("max_pages")
        if max_pages:
            cmd.extend(["--max-pages", str(int(max_pages))])

        timeout = self.config.get("timeout_sec", DEFAULT_TIMEOUT_SEC)
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                # Keep env minimal — don't leak OPENROUTER_API_KEY etc. to lit
                env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")},
            )
        except subprocess.TimeoutExpired:
            raise TimeoutError(
                f"lit parse timed out after {timeout}s on {path!r}. "
                f"Large/complex doc? Raise timeout_sec in provider config."
            )

        if proc.returncode != 0:
            raise RuntimeError(
                f"lit parse exited {proc.returncode}: {(proc.stderr or proc.stdout)[:500]}"
            )

        try:
            raw = json.loads(proc.stdout)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"lit parse returned non-JSON output: {proc.stdout[:200]!r} ({e})"
            )

        return _normalize_lit_json(raw)

    # ── pipeline API ───────────────────────────────────────────────────

    def filter_image(self, image_path: str, prompt: str) -> FilterResult:
        """YES if the document contains substantive extractable text."""
        t0 = time.time()
        try:
            # OCR opt-in: `prompt` can request it via '[ocr]' prefix
            ocr = "[ocr]" in prompt.lower()
            parsed = self._run_parse(image_path, ocr=ocr)
            elapsed = time.time() - t0

            text = parsed.get("text") or parsed.get("markdown") or ""
            text_len = len(text.strip())
            min_chars = self.config.get("min_text_chars", DEFAULT_MIN_TEXT_CHARS)

            if text_len >= min_chars:
                return FilterResult(
                    verdict="YES",
                    raw_answer=f"LiteParse extracted {text_len} chars: {text[:80]}...",
                    elapsed=elapsed,
                    confidence=min(1.0, text_len / 200),
                )
            return FilterResult(
                verdict="NO",
                raw_answer=f"LiteParse extracted only {text_len} chars",
                elapsed=elapsed,
                confidence=max(0.0, 1.0 - text_len / 20),
            )
        except Exception as e:
            return FilterResult(
                verdict="ERROR", raw_answer=str(e),
                elapsed=time.time() - t0, confidence=0,
            )

    def label_image(self, image_path: str, queries: list[str],
                    image_wh: tuple[int, int] | None = None) -> LabelResult:
        """Extract layout blocks as COCO annotations.

        LiteParse JSON shape (expected):
            {
              "text": "...",
              "pages": [
                {"page": 1, "width": 612, "height": 792,
                 "blocks": [
                    {"type": "paragraph", "bbox": [x1,y1,x2,y2], "text": "..."},
                    {"type": "table",     "bbox": [...],         "text": "..."},
                 ]}
              ]
            }
        """
        t0 = time.time()
        try:
            # If any query hints at OCR (scanned / image / handwritten), turn it on
            ocr_hints = {"ocr", "scanned", "handwritten", "image"}
            ocr = any(q.lower() in ocr_hints for q in queries)
            parsed = self._run_parse(image_path, ocr=ocr)
        except Exception as e:
            return LabelResult(
                annotations=[], elapsed=time.time() - t0,
                metadata={"error": str(e)},
            )

        elapsed = time.time() - t0
        annotations: list[dict] = []

        for page in parsed.get("pages", []):
            pw = page.get("width") or (image_wh[0] if image_wh else 1)
            ph = page.get("height") or (image_wh[1] if image_wh else 1)
            page_num = page.get("page", 1)

            for block in page.get("blocks", []) or []:
                bbox = block.get("bbox") or block.get("bounding_box")
                if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
                    continue
                x1, y1, x2, y2 = bbox
                # Normalize to pixels if values look normalized (all 0..1)
                if all(0 <= v <= 1.0 for v in bbox):
                    x1, y1, x2, y2 = x1 * pw, y1 * ph, x2 * pw, y2 * ph

                w = max(0, x2 - x1)
                h = max(0, y2 - y1)
                block_type = (block.get("type") or "text").lower()
                text_content = (block.get("text") or "").strip()

                # Query filtering: match by block type OR text content
                if queries:
                    matched = any(q.lower() in block_type for q in queries)
                    if not matched and text_content:
                        matched = any(q.lower() in text_content.lower() for q in queries)
                    if not matched:
                        continue
                    category = next(
                        (q for q in queries if q.lower() in block_type),
                        queries[0],
                    )
                else:
                    category = block_type

                annotations.append({
                    "bbox": [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)],
                    "category": category,
                    "score": float(block.get("confidence", 0.9)),
                    "text": text_content[:200],
                    "page": page_num,
                    "source": "liteparse",
                })

        # Fallback: if no structured blocks, emit one doc-level annotation
        if not annotations and (parsed.get("text") or "").strip():
            iw, ih = image_wh or (1, 1)
            annotations.append({
                "bbox": [0, 0, round(iw, 2), round(ih, 2)],
                "category": "document",
                "score": 0.5,
                "text": parsed["text"][:200],
                "page": 1,
                "source": "liteparse",
            })

        return LabelResult(
            annotations=annotations,
            elapsed=elapsed,
            metadata={
                "total_text_length": len(parsed.get("text") or ""),
                "page_count": len(parsed.get("pages") or []),
                "block_count": len(annotations),
            },
        )

    def verify_bbox(self, image_path: str, bbox: list[float],
                    query: str, prompt: str = "") -> VerifyResult:
        """Verify a bbox by parsing the crop and checking text content."""
        from PIL import Image
        import tempfile

        t0 = time.time()
        try:
            img = Image.open(image_path).convert("RGB")
            x, y, w, h = bbox
            crop = img.crop((int(x), int(y), int(x + w), int(y + h)))

            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                crop.save(f, format="PNG")
                crop_path = f.name

            try:
                # OCR on by default for bbox verification — the crop is usually
                # an image that wasn't originally text-extractable.
                parsed = self._run_parse(crop_path, ocr=True)
                text = (parsed.get("text") or parsed.get("markdown") or "").strip()
            finally:
                os.unlink(crop_path)

            elapsed = time.time() - t0
            q = query.lower()

            if q in ("text", "document", "paragraph"):
                verdict = "YES" if len(text) > 10 else "NO"
            elif q == "table":
                verdict = "YES" if ("|" in text or "\t" in text or "table" in text.lower()) else "NO"
            else:
                verdict = "YES" if q in text.lower() else "UNSURE"

            return VerifyResult(
                verdict=verdict,
                raw_answer=f"LiteParse text ({len(text)} chars): {text[:100]}",
                elapsed=elapsed,
                confidence=0.7 if verdict == "YES" else 0.3,
            )
        except Exception as e:
            return VerifyResult(
                verdict="ERROR", raw_answer=str(e),
                elapsed=time.time() - t0,
            )

    # ── convenience: expose raw parse for non-COCO callers ─────────────

    def parse(self, path: str, ocr: bool = False) -> dict:
        """Raw parse — returns LiteParse JSON directly. Used by serve.py / CLI."""
        t0 = time.time()
        parsed = self._run_parse(path, ocr=ocr)
        return {
            **parsed,
            "elapsed_ms": round((time.time() - t0) * 1000, 1),
        }
