"""
serve.py — REST API server for data-label-factory.

The web UI frontend calls this server to run the labeling pipeline.
Wraps the same logic as the MCP tools but over HTTP.

Usage:
    python3 -m data_label_factory.serve --port 8400

Endpoints:
    GET  /api/providers          — list registered providers + status
    POST /api/auto               — create project from samples + description
    POST /api/filter             — filter a single image
    POST /api/label              — label a single image
    POST /api/verify             — verify a bbox crop
    POST /api/score              — score a COCO annotation file
    POST /api/upload             — upload sample images
    GET  /api/experiments        — list experiments
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

try:
    from fastapi import FastAPI, UploadFile, File, Form, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, FileResponse
    from fastapi.staticfiles import StaticFiles
except ImportError:
    raise ImportError("FastAPI required: pip install fastapi uvicorn python-multipart")

app = FastAPI(title="data-label-factory", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path(os.environ.get("DLF_UPLOAD_DIR", "/tmp/dlf-uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _get_provider(backend: str):
    """Create a provider, raising 400 for unknown backend names."""
    from .providers import create_provider, list_providers
    try:
        return create_provider(backend)
    except ValueError:
        available = ", ".join(list_providers())
        raise HTTPException(400, f"Unknown backend {backend!r}. Available: {available}")


def _validate_image(tmp_path: str):
    """Validate the uploaded file is a readable image, raising 400 if not."""
    from PIL import Image
    try:
        img = Image.open(tmp_path)
        img.verify()
        # Re-open after verify (verify can close the file)
        img = Image.open(tmp_path)
        return img.size
    except Exception:
        os.unlink(tmp_path)
        raise HTTPException(400, "Invalid image file. Upload a valid JPEG, PNG, or WebP.")


# ─── Providers ──────────────────────────────────────────────

@app.get("/api/providers")
def get_providers():
    from .providers import list_providers, create_provider
    results = []
    for name in list_providers():
        try:
            p = create_provider(name)
            st = p.status()
            results.append({
                "name": name,
                "alive": st.get("alive", False),
                "capabilities": sorted(p.capabilities),
                "info": str(st.get("info", ""))[:200],
            })
        except Exception as e:
            results.append({"name": name, "alive": False, "error": str(e)})
    return {"providers": results}


# ─── Auto project ──────────────────────────────────────────

@app.post("/api/auto")
async def auto_project(
    description: str = Form(...),
    samples: list[UploadFile] = File(default=[]),
):
    """Create a project from uploaded samples + description."""
    # Save uploaded files
    session_id = f"session_{int(time.time())}"
    session_dir = UPLOAD_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    saved_paths = []
    for f in samples:
        dest = session_dir / f.filename
        with open(dest, "wb") as out:
            out.write(await f.read())
        saved_paths.append(str(dest))

    from .auto import auto_project as _auto, detect_content_type
    content_type = detect_content_type(description)

    try:
        config = _auto(
            samples=str(session_dir) if saved_paths else [],
            description=description,
            output="",
            analyze=False,  # skip VLM analysis for speed in web UI
        )
    except Exception as e:
        raise HTTPException(500, str(e))

    return {
        "session_id": session_id,
        "content_type": content_type,
        "config": config,
        "n_samples": len(saved_paths),
        "sample_dir": str(session_dir),
    }


# ─── Gather (DDG image search → download → return) ───────
#
# The /go page can call this so users just type "fire hydrants"
# and we search + download images, ready for the filter/label pipeline.

@app.post("/api/gather")
async def gather_images(payload: dict):
    """Search DDG for images matching a description, download up to N.

    Body: { query: "fire hydrants", max_images: 10 }
    Returns: { images: [{filename, path, url, source}], count, query }

    RAM-safe: sequential downloads, max 30 images per request.
    """
    from .gather import ddg_search

    query = (payload or {}).get("query", "").strip()
    if not query:
        raise HTTPException(400, "query required")

    max_images = min(int((payload or {}).get("max_images", 10)), 30)
    session_id = f"gather_{int(time.time())}_{query[:20].replace(' ', '_')}"
    session_dir = UPLOAD_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    # Search DDG
    try:
        results = ddg_search(query, max_results=max_images)
    except Exception as e:
        raise HTTPException(502, f"DDG search failed: {e}")

    # Download images sequentially (RAM-safe)
    downloaded = []
    for r in results[:max_images]:
        img_url = r.get("url", "")
        if not img_url:
            continue
        try:
            import urllib.request as _ur
            headers = {"User-Agent": "data-label-factory/0.2"}
            req = _ur.Request(img_url, headers=headers)
            with _ur.urlopen(req, timeout=10) as resp:
                content_type = resp.headers.get("Content-Type", "")
                if "image" not in content_type and not img_url.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                    continue
                data = resp.read(5 * 1024 * 1024)  # cap at 5MB per image
                ext = ".jpg"
                if "png" in content_type:
                    ext = ".png"
                elif "webp" in content_type:
                    ext = ".webp"
                fname = f"img_{len(downloaded):04d}{ext}"
                fpath = session_dir / fname
                fpath.write_bytes(data)
                downloaded.append({
                    "filename": fname,
                    "path": str(fpath),
                    "url": img_url,
                    "source": r.get("source", "duckduckgo"),
                    "title": r.get("title", ""),
                })
        except Exception:
            continue

    return {
        "query": query,
        "count": len(downloaded),
        "session_id": session_id,
        "session_dir": str(session_dir),
        "images": downloaded,
    }


# ─── Label by server path (no upload needed) ─────────────
#
# Used by /go after DDG gather — images are already on disk,
# no need to re-upload them.

@app.post("/api/label-path")
async def label_by_path(payload: dict):
    """Label an image already on the server's filesystem.

    Body: { path: "/tmp/dlf-uploads/gather_.../img_0001.jpg",
            queries: "tiger", backend: "openrouter" }
    Returns: same shape as POST /api/label
    """
    img_path = (payload or {}).get("path", "").strip()
    queries = (payload or {}).get("queries", "object")
    backend = (payload or {}).get("backend", "openrouter")

    if not img_path or not os.path.exists(img_path):
        raise HTTPException(400, f"file not found: {img_path!r}")

    # Security: only allow paths inside our upload dir
    if not os.path.abspath(img_path).startswith(str(UPLOAD_DIR)):
        raise HTTPException(403, "path outside upload directory")

    provider = _get_provider(backend)

    from PIL import Image as _PILImage
    try:
        img = _PILImage.open(img_path)
        iw, ih = img.size
    except Exception:
        raise HTTPException(400, "invalid image file")

    try:
        query_list = [q.strip() for q in queries.split(",")]
        result = provider.label_image(img_path, query_list, image_wh=(iw, ih))

        from .metrics import verify_bbox_rules
        scored = []
        for ann in result.annotations:
            vr = verify_bbox_rules(ann["bbox"], (iw, ih), score=ann.get("score", 1.0))
            scored.append({**ann, "pass_rate": round(vr.pass_rate, 2), "failed_rules": vr.failed_rules})

        return {
            "annotations": scored,
            "elapsed": round(result.elapsed, 2),
            "backend": backend,
            "image_size": [iw, ih],
            "n_detections": len(scored),
            "path": img_path,
        }
    except Exception as e:
        raise HTTPException(500, str(e))


# ─── Filter ────────────────────────────────────────────────

@app.post("/api/filter")
async def filter_image(
    image: UploadFile = File(...),
    prompt: str = Form(default="Does this image show the target object? Answer YES or NO."),
    backend: str = Form(default="openrouter"),
):
    """Filter a single image via a VLM backend."""
    provider = _get_provider(backend)

    # Save temp file
    suffix = Path(image.filename).suffix or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOAD_DIR)) as f:
        f.write(await image.read())
        tmp_path = f.name

    _validate_image(tmp_path)

    try:
        result = provider.filter_image(tmp_path, prompt)
        return {
            "verdict": result.verdict,
            "raw_answer": result.raw_answer,
            "elapsed": round(result.elapsed, 2),
            "confidence": result.confidence,
            "backend": backend,
        }
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        os.unlink(tmp_path)


# ─── Label ─────────────────────────────────────────────────

@app.post("/api/label")
async def label_image(
    image: UploadFile = File(...),
    queries: str = Form(default="object"),
    backend: str = Form(default="falcon"),
):
    """Label a single image — returns COCO-style bboxes."""
    provider = _get_provider(backend)

    suffix = Path(image.filename).suffix or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOAD_DIR)) as f:
        f.write(await image.read())
        tmp_path = f.name

    iw, ih = _validate_image(tmp_path)

    try:
        query_list = [q.strip() for q in queries.split(",")]
        result = provider.label_image(tmp_path, query_list, image_wh=(iw, ih))

        # Also run metrics on the annotations
        from .metrics import verify_bbox_rules
        scored_anns = []
        for ann in result.annotations:
            vr = verify_bbox_rules(ann["bbox"], (iw, ih), score=ann.get("score", 1.0))
            scored_anns.append({
                **ann,
                "pass_rate": round(vr.pass_rate, 2),
                "failed_rules": vr.failed_rules,
            })

        return {
            "annotations": scored_anns,
            "elapsed": round(result.elapsed, 2),
            "backend": backend,
            "image_size": [iw, ih],
            "n_detections": len(scored_anns),
        }
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        os.unlink(tmp_path)


# ─── Ask (free-form VLM question) ─────────────────────────

@app.post("/api/ask")
async def ask_image(
    image: UploadFile = File(...),
    question: str = Form(default="What do you see in this image?"),
    backend: str = Form(default="openrouter"),
):
    """Ask a free-form question about an image via any VLM backend."""
    provider = _get_provider(backend)

    suffix = Path(image.filename).suffix or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOAD_DIR)) as f:
        f.write(await image.read())
        tmp_path = f.name

    _validate_image(tmp_path)

    try:
        # Use _call for richer answers (more tokens than filter's 32)
        if hasattr(provider, '_call'):
            call_result = provider._call(tmp_path, question, max_tokens=256)
            # Some providers return (text, elapsed), others (text, elapsed, usage)
            if len(call_result) == 3:
                answer, elapsed, _ = call_result
            else:
                answer, elapsed = call_result
        else:
            result = provider.filter_image(tmp_path, question)
            answer = result.raw_answer
            elapsed = result.elapsed

        # Strip thinking tokens
        if hasattr(provider, '_strip_thinking'):
            from .providers.gemma import _strip_thinking
            answer = _strip_thinking(answer)
        elif 'thought' in answer.lower()[:20]:
            import re
            answer = re.sub(r'^(?:thought\s*\n?\s*)+', '', answer, flags=re.IGNORECASE).strip()

        return {
            "answer": answer,
            "elapsed": round(elapsed, 2),
            "backend": backend,
            "question": question,
        }
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        os.unlink(tmp_path)


# ─── Verify ────────────────────────────────────────────────

@app.post("/api/verify")
async def verify_bbox(
    image: UploadFile = File(...),
    bbox: str = Form(...),  # JSON: [x, y, w, h]
    query: str = Form(default="object"),
    backend: str = Form(default="openrouter"),
):
    """Verify a single bbox crop."""
    provider = _get_provider(backend)

    suffix = Path(image.filename).suffix or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOAD_DIR)) as f:
        f.write(await image.read())
        tmp_path = f.name

    _validate_image(tmp_path)

    try:
        try:
            bbox_list = json.loads(bbox)
        except (json.JSONDecodeError, TypeError):
            raise HTTPException(400, f"Invalid bbox JSON: {bbox!r}. Expected [x, y, w, h].")
        result = provider.verify_bbox(tmp_path, bbox_list, query)
        return {
            "verdict": result.verdict,
            "raw_answer": result.raw_answer,
            "elapsed": round(result.elapsed, 2),
            "confidence": result.confidence,
            "backend": backend,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        os.unlink(tmp_path)


# ─── Score ─────────────────────────────────────────────────

@app.post("/api/score")
async def score_coco(coco_file: UploadFile = File(...)):
    """Score a COCO annotation file with deterministic metrics."""
    from .metrics import score_coco as _score
    content = await coco_file.read()
    coco = json.loads(content)
    score = _score(coco)
    return {
        "total_images": score.total_images,
        "total_annotations": score.total_annotations,
        "pass_rate": round(score.pass_rate, 4),
        "mean_score": round(score.mean_score, 4),
        "mean_area_ratio": round(score.mean_area_ratio, 4),
        "rule_breakdown": {k: round(v, 4) for k, v in score.rule_breakdown.items()},
        "per_category": score.per_category,
    }


# ─── Batch pipeline ───────────────────────────────────────

@app.post("/api/pipeline")
async def run_pipeline(
    description: str = Form(...),
    backend: str = Form(default="openrouter"),
    samples: list[UploadFile] = File(default=[]),
):
    """Full pipeline: upload samples → auto project → filter → return results."""
    from .auto import detect_content_type, CONTENT_PROFILES

    session_id = f"pipeline_{int(time.time())}"
    session_dir = UPLOAD_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    # Save uploads
    saved = []
    for f in samples:
        dest = session_dir / f.filename
        with open(dest, "wb") as out:
            out.write(await f.read())
        saved.append({"name": f.filename, "path": str(dest)})

    content_type = detect_content_type(description)
    profile = CONTENT_PROFILES.get(content_type, CONTENT_PROFILES["generic"])

    # Use the recommended filter backend or override
    filter_backend = backend if backend != "auto" else profile["filter_backend"]
    provider = _get_provider(filter_backend)

    prompt = (
        f"Look at this image. Does it show a {description}? "
        "Answer with exactly one word: YES or NO."
    )

    results = []
    t0 = time.time()
    for item in saved:
        try:
            fr = provider.filter_image(item["path"], prompt)
            results.append({
                "name": item["name"],
                "verdict": fr.verdict,
                "raw_answer": fr.raw_answer,
                "elapsed": round(fr.elapsed, 2),
                "confidence": fr.confidence,
            })
        except Exception as e:
            results.append({
                "name": item["name"],
                "verdict": "ERROR",
                "raw_answer": str(e)[:100],
                "elapsed": 0,
                "confidence": 0,
            })

    elapsed_total = time.time() - t0
    counts = {}
    for r in results:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1

    return {
        "session_id": session_id,
        "content_type": content_type,
        "backend": filter_backend,
        "prompt": prompt,
        "n_images": len(saved),
        "elapsed_total": round(elapsed_total, 1),
        "counts": counts,
        "results": results,
    }


# ─── Parse (document parsing via liteparse / chandra) ─────
#
# RAM-safety on Mac Mini is enforced at *three* layers:
#   1. FastAPI reject files > MAX_PARSE_MB up front (avoid writing to disk).
#   2. The provider config caps file size again before spawning lit CLI.
#   3. The provider sets a subprocess timeout.
# This is deliberate belt + suspenders — OCR can be RAM-expensive.

MAX_PARSE_MB = int(os.environ.get("DLF_MAX_PARSE_MB", "50"))
PARSE_SUPPORTED = {".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".tiff", ".tif"}


@app.post("/api/parse")
async def parse_document(
    file: UploadFile = File(...),
    backend: str = Form(default="liteparse"),
    ocr: bool = Form(default=False),
    timeout_sec: int = Form(default=60),
):
    """Parse a document and return layout-preserving text + block bboxes.

    Body: multipart/form-data with `file` field.
    Query/form params:
        backend:     "liteparse" (default) or "chandra"
        ocr:         opt-in OCR (RAM-heavy — defaults to off)
        timeout_sec: kill subprocess after this many seconds
    """
    if backend not in ("liteparse", "chandra"):
        raise HTTPException(
            400, f"backend must be liteparse or chandra, got {backend!r}"
        )

    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix not in PARSE_SUPPORTED:
        raise HTTPException(
            400,
            f"unsupported file type {suffix!r}. "
            f"Supported: {', '.join(sorted(PARSE_SUPPORTED))}",
        )

    # Stream the body to disk, enforcing size cap as we go.
    max_bytes = MAX_PARSE_MB * 1024 * 1024
    total = 0
    with tempfile.NamedTemporaryFile(
        suffix=suffix, delete=False, dir=str(UPLOAD_DIR),
    ) as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                f.close()
                os.unlink(f.name)
                raise HTTPException(
                    413,
                    f"file too large ({total / 1024 / 1024:.1f} MB > "
                    f"{MAX_PARSE_MB} MB cap). Split the document or raise "
                    f"DLF_MAX_PARSE_MB env.",
                )
            f.write(chunk)
        tmp_path = f.name

    try:
        if backend == "liteparse":
            provider = _get_provider("liteparse")
            provider.config.update({
                "ocr": bool(ocr),
                "timeout_sec": int(timeout_sec),
                "max_file_mb": MAX_PARSE_MB,
            })
            st = provider.status()
            if not st.get("alive"):
                raise HTTPException(503, f"liteparse unavailable: {st.get('info')}")
            result = provider.parse(tmp_path, ocr=bool(ocr))
            return {
                "backend": "liteparse",
                "file": file.filename,
                "text": result.get("text", ""),
                "pages": result.get("pages", []),
                "elapsed_ms": result.get("elapsed_ms"),
                "size_mb": round(total / 1024 / 1024, 2),
            }

        # backend == "chandra" — reuse existing label_image path
        provider = _get_provider("chandra")
        lr = provider.label_image(
            tmp_path, queries=["text", "table", "header"],
        )
        return {
            "backend": "chandra",
            "file": file.filename,
            "annotations": lr.annotations,
            "metadata": lr.metadata,
            "elapsed_ms": round(lr.elapsed * 1000, 1),
            "size_mb": round(total / 1024 / 1024, 2),
        }
    except HTTPException:
        raise
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e))
    except TimeoutError as e:
        raise HTTPException(504, str(e))
    except RuntimeError as e:
        # Subprocess failed — almost always malformed input (corrupt PDF, etc.).
        # Pick the first informative line out of the stack trace.
        lines = [l.strip() for l in str(e).splitlines() if l.strip()]
        msg = next((l for l in lines if l.startswith("Error:")), lines[0] if lines else str(e))
        raise HTTPException(422, f"could not parse document: {msg[:200]}")
    except Exception as e:
        raise HTTPException(500, f"parse failed: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ─── Document templates (marketplace + user) ──────────────
#
# The marketplace lives at `data_label_factory/templates/library/*.yaml`
# and ships with the repo. User-edited templates (from the editor)
# land in `projects/templates/user/*.yaml`. Both directories follow the
# same YAML shape — see `data_label_factory/doc_template.py` for the
# canonical schema.
#
# These endpoints only *list* and *read* — mutations are handled by
# the dedicated /api/template routes (separate agent).

_LIBRARY_DIR = Path(__file__).resolve().parent / "templates" / "library"
_USER_TEMPLATE_DIR = Path("projects") / "templates" / "user"


def _template_dir(library: bool) -> Path:
    return _LIBRARY_DIR if library else _USER_TEMPLATE_DIR


def _template_summary(data: dict, path: Path) -> dict:
    """Strip field bodies down to a count, keep the metadata header."""
    fields = data.get("fields") or []
    return {
        "name": data.get("name") or path.stem,
        "display_name": data.get("display_name") or data.get("name") or path.stem,
        "description": data.get("description") or "",
        "doc_type": data.get("doc_type") or "document",
        "field_count": len(fields),
        "page_size": data.get("page_size") or [612, 792],
        "source": data.get("source") or ("marketplace" if "library" in str(path) else "user"),
    }


@app.get("/api/templates")
def list_templates(library: bool = True):
    """List document-extraction templates.

    library=true (default) reads the shipped marketplace library.
    library=false reads the user's own saved templates.

    Returns summary entries — not full field definitions — because the
    library page only needs the card data. Fetch the full YAML via
    `/api/template/{name}` when the user picks one.
    """
    try:
        import yaml
    except ImportError:
        raise HTTPException(500, "PyYAML missing on server")

    dir_path = _template_dir(library)
    if not dir_path.exists():
        return {"templates": [], "source": "marketplace" if library else "user"}

    templates: list[dict] = []
    for yml in sorted(dir_path.glob("*.yaml")):
        try:
            with yml.open("r", encoding="utf-8") as fh:
                data = yaml.safe_load(fh) or {}
            if not isinstance(data, dict):
                continue
            templates.append(_template_summary(data, yml))
        except Exception as e:
            # Corrupt YAML shouldn't brick the whole list — log-and-skip.
            print(f"[templates] skipping {yml.name}: {e}")
            continue

    return {
        "templates": templates,
        "source": "marketplace" if library else "user",
    }


@app.get("/api/template/{name}")
def get_template(name: str, library: bool = True):
    """Return the full template YAML (as JSON) for a single template."""
    # Path-traversal safe — templates are flat files keyed by name
    if "/" in name or ".." in name or "\\" in name:
        raise HTTPException(400, "invalid template name")

    try:
        import yaml
    except ImportError:
        raise HTTPException(500, "PyYAML missing on server")

    path = _template_dir(library) / f"{name}.yaml"
    if not path.exists():
        raise HTTPException(404, f"template not found: {name!r}")

    try:
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
    except Exception as e:
        raise HTTPException(500, f"could not parse template {name!r}: {e}")

    if not isinstance(data, dict):
        raise HTTPException(500, f"template {name!r} is not a mapping")

    data.setdefault("name", name)
    data.setdefault("source", "marketplace" if library else "user")
    return data


# ─── Flywheel doc-labeling challenges ─────────────────────
#
# Serves the document-mode Flywheel game. Agents and humans hit
# `/api/doc-challenges` to get candidate blocks, POST their answer to
# `/api/doc-answer`. Honeypot trust + reward pool flows the same way
# image-mode Flywheel does. See data_label_factory/flywheel_docs.py.


@app.get("/api/doc-challenges")
def doc_challenges(limit: int = 20, doc_id: Optional[str] = None):
    """List doc-labeling challenges. Default: first 20 across all docs."""
    from .flywheel_docs import list_challenges
    challenges = list_challenges(doc_id=doc_id)[:limit]
    return {
        "count": len(challenges),
        "challenges": [c.to_public() for c in challenges],
    }


@app.get("/api/doc-challenge")
def doc_challenge_one(agent_id: str = "anonymous", honeypot_rate: float = 0.3):
    """Sample a single challenge with the given honeypot rate.

    Agent-facing: returns block_text + bbox + page_image_url so both
    text-only LLMs and vision models can answer.
    """
    from .flywheel_docs import sample_challenge
    c = sample_challenge(honeypot_rate=honeypot_rate)
    return {
        "agent_id": agent_id,
        **c.to_public(),
    }


@app.get("/api/doc-docs")
def doc_docs():
    """Enumerate documents currently in the challenge pool."""
    from .flywheel_docs import list_docs
    return {"docs": list_docs()}


@app.get("/api/doc-truth/{challenge_id}")
def doc_truth(challenge_id: str):
    """Return ground-truth for a challenge (honeypot-only).

    Used by the Next.js agent-proxy to grade answers. Real challenges
    (ground_truth=None) are accepted as-is by the reward pool.

    Separated from doc-challenge so that the public challenge endpoint
    never leaks ground-truth to agents.
    """
    from .flywheel_docs import get_challenge
    c = get_challenge(challenge_id)
    if not c:
        raise HTTPException(404, f"unknown challenge: {challenge_id!r}")
    return {
        "challenge_id": c.id,
        "is_honeypot": c.ground_truth is not None,
        "ground_truth": c.ground_truth,
        "question_field": c.question_field,
        "block_text": c.block_text,
    }


@app.get("/api/doc-page/{doc_id}/{filename}")
def doc_page(doc_id: str, filename: str):
    """Serve a rendered page image from the flywheel dir.

    Path-traversal safe — we reject any filename that contains `..`
    or path separators.
    """
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(400, "invalid filename")
    if not filename.endswith(".png"):
        raise HTTPException(400, "only .png supported")

    from .flywheel_docs import FLYWHEEL_DIR
    path = FLYWHEEL_DIR / doc_id / filename
    if not path.exists():
        raise HTTPException(404, f"page not found: {doc_id}/{filename}")
    return FileResponse(str(path), media_type="image/png")


# ─── Cluster-before-label intake ───────────────────────────
#
# Users drop a folder of mixed PDFs; we parse each with LiteParse,
# fingerprint the layout, and group them by similarity. The UI shows
# "34 invoices, 12 W-2s, 6 receipts" — the user picks a cluster, then
# builds a template from ONE representative doc in that cluster.

CLUSTER_MAX_FILES = 50   # hard ceiling per request (RAM safety)
_CLUSTER_JOBS: dict[str, dict] = {}   # in-memory cluster-result store


@app.post("/api/cluster")
async def cluster_documents(files: list[UploadFile] = File(...)):
    """Parse and cluster multiple documents by layout similarity.

    Body: multipart/form-data with one or more `files[]` entries.
    Each file is saved, parsed via LiteParse sequentially (no
    concurrency — matches the RAM-safe pattern for 16 GB Mac Mini),
    fingerprinted, and then clustered agglomeratively.

    Returns a job id + per-cluster summary. The full cluster result
    is also stored in-memory and is retrievable via
    GET /api/cluster/{cluster_job_id}.
    """
    import uuid
    from .doc_cluster import cluster_docs

    if not files:
        raise HTTPException(400, "no files uploaded")
    if len(files) > CLUSTER_MAX_FILES:
        raise HTTPException(
            413,
            f"too many files ({len(files)} > {CLUSTER_MAX_FILES}). "
            f"Split the batch.",
        )

    # Spin up one LiteParse provider and reuse it across the whole batch.
    provider = _get_provider("liteparse")
    provider.config.update({
        "ocr": False,
        "timeout_sec": 60,
        "max_file_mb": MAX_PARSE_MB,
    })
    st = provider.status()
    if not st.get("alive"):
        raise HTTPException(503, f"liteparse unavailable: {st.get('info')}")

    parsed_docs: list[dict] = []
    doc_ids: list[str] = []
    filenames: list[str] = []
    per_doc_errors: list[dict] = []

    max_bytes = MAX_PARSE_MB * 1024 * 1024

    for idx, up in enumerate(files):
        filename = up.filename or f"upload_{idx}"
        suffix = Path(filename).suffix.lower()
        if suffix not in PARSE_SUPPORTED:
            per_doc_errors.append({
                "filename": filename,
                "error": f"unsupported file type {suffix!r}",
            })
            continue

        # Stream to disk with per-file size cap.
        total = 0
        tmp_path: Optional[str] = None
        too_big = False
        try:
            with tempfile.NamedTemporaryFile(
                suffix=suffix, delete=False, dir=str(UPLOAD_DIR),
            ) as f:
                while True:
                    chunk = await up.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        too_big = True
                        break
                    f.write(chunk)
                tmp_path = f.name
            if too_big:
                raise ValueError(
                    f"file too large "
                    f"({total / 1024 / 1024:.1f} MB > {MAX_PARSE_MB} MB)"
                )

            # Sequential parse — no concurrency on purpose (RAM safety)
            result = provider.parse(tmp_path, ocr=False)
            parsed_docs.append(result)
            doc_ids.append(f"doc_{idx}")
            filenames.append(filename)
        except (FileNotFoundError, ValueError, TimeoutError, RuntimeError) as e:
            per_doc_errors.append({"filename": filename, "error": str(e)[:200]})
        except Exception as e:
            per_doc_errors.append(
                {"filename": filename, "error": f"{type(e).__name__}: {e}"[:200]}
            )
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    if not parsed_docs:
        raise HTTPException(
            422,
            f"no documents parsed successfully. errors: {per_doc_errors[:5]}",
        )

    clusters = cluster_docs(parsed_docs, doc_ids=doc_ids)
    id_to_filename = dict(zip(doc_ids, filenames))

    public_clusters = []
    for c in clusters:
        sample_filenames = [
            id_to_filename.get(did, did) for did in c["doc_ids"][:5]
        ]
        public_clusters.append({
            "cluster_id": c["cluster_id"],
            "doc_ids": c["doc_ids"],
            "doc_count": c["doc_count"],
            "suggested_name": c["suggested_name"],
            "sample_filenames": sample_filenames,
        })

    job_id = uuid.uuid4().hex[:12]
    stored = {
        "job_id": job_id,
        "created_at": datetime.now().isoformat(),
        "total_docs": len(parsed_docs),
        "cluster_count": len(clusters),
        "clusters": clusters,
        "filenames": id_to_filename,
        "errors": per_doc_errors,
    }
    _CLUSTER_JOBS[job_id] = stored

    # Cap the in-memory store so it doesn't grow forever.
    if len(_CLUSTER_JOBS) > 64:
        oldest = min(_CLUSTER_JOBS, key=lambda k: _CLUSTER_JOBS[k]["created_at"])
        _CLUSTER_JOBS.pop(oldest, None)

    return {
        "job_id": job_id,
        "cluster_count": len(clusters),
        "total_docs": len(parsed_docs),
        "clusters": public_clusters,
        "errors": per_doc_errors,
    }


@app.get("/api/cluster/{cluster_job_id}")
def get_cluster(cluster_job_id: str):
    """Retrieve a previously-computed cluster result by job id."""
    job = _CLUSTER_JOBS.get(cluster_job_id)
    if not job:
        raise HTTPException(404, f"unknown cluster job: {cluster_job_id!r}")

    id_to_filename = job.get("filenames") or {}
    public_clusters = []
    for c in job["clusters"]:
        public_clusters.append({
            "cluster_id": c["cluster_id"],
            "doc_ids": c["doc_ids"],
            "doc_count": c["doc_count"],
            "suggested_name": c["suggested_name"],
            "centroid_features": c.get("centroid_features", {}),
            "sample_filenames": [
                id_to_filename.get(did, did) for did in c["doc_ids"][:5]
            ],
        })
    return {
        "job_id": job["job_id"],
        "created_at": job["created_at"],
        "total_docs": job["total_docs"],
        "cluster_count": job["cluster_count"],
        "clusters": public_clusters,
        "errors": job.get("errors", []),
    }


# ─── Templates (document-extraction templates) ────────────
#
# CRUD for user-created templates + apply-to-batch extraction.
# Library templates are served read-only (seeded in
# data_label_factory/templates/library/). User templates live under
# projects/templates/user/ and can be saved / updated / deleted.


@app.get("/api/template")
def template_list(library: bool = True):
    """List templates. Set library=false for user-created only."""
    from .doc_template import list_templates
    lib = list_templates(library=True) if library else []
    user = list_templates(library=False)
    return {
        "library": [t.summary() for t in lib],
        "user":    [t.summary() for t in user],
    }


@app.post("/api/template")
async def template_save(payload: dict):
    """Create or update a user template.

    Body shape: {name, display_name, description, doc_type, page_size,
                 fields: [{name, label, bbox, type, required, anchor_text, page}],
                 anchor_fields, source}
    """
    from .doc_template import Template
    if not payload.get("name"):
        raise HTTPException(400, "missing required field: name")
    try:
        t = Template.from_dict(payload)
        t.source = "user"
        path = t.save()
    except Exception as e:
        raise HTTPException(400, f"invalid template payload: {e}")
    return {"saved": True, "name": t.name, "path": str(path), "field_count": len(t.fields)}


@app.post("/api/template-extract")
async def template_extract(
    template_name: str = Form(...),
    library: bool = Form(default=False),
    file: UploadFile = File(...),
):
    """Apply a template to a single PDF/DOCX/image.

    Returns `{ fields: {field_name: {value, raw_text, bbox_used, confidence}} }`
    per the template's field list. For batch use, agents/UI should call this
    N times (or use the MCP `extract_from_template` tool).
    """
    from .doc_template import Template

    tpl = Template.load(template_name, library=library)
    if tpl is None and not library:
        tpl = Template.load(template_name, library=True)
    if tpl is None:
        raise HTTPException(404, f"template not found: {template_name!r}")

    # Reuse the parse pipeline (same size caps + timeout + OCR policy)
    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix not in PARSE_SUPPORTED:
        raise HTTPException(400, f"unsupported file type {suffix!r}")

    max_bytes = MAX_PARSE_MB * 1024 * 1024
    total = 0
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOAD_DIR)) as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk: break
            total += len(chunk)
            if total > max_bytes:
                f.close(); os.unlink(f.name)
                raise HTTPException(413, f"file too large")
            f.write(chunk)
        tmp_path = f.name

    try:
        provider = _get_provider("liteparse")
        st = provider.status()
        if not st.get("alive"):
            raise HTTPException(503, f"liteparse unavailable: {st.get('info')}")
        parsed = provider.parse(tmp_path, ocr=False)
        fields = tpl.apply(parsed)
        return {
            "template": tpl.name,
            "file": file.filename,
            "fields": fields,
            "page_count": len(parsed.get("pages", [])),
            "elapsed_ms": parsed.get("elapsed_ms"),
        }
    except HTTPException:
        raise
    except RuntimeError as e:
        lines = [l.strip() for l in str(e).splitlines() if l.strip()]
        msg = next((l for l in lines if l.startswith("Error:")), lines[0] if lines else str(e))
        raise HTTPException(422, f"could not parse document: {msg[:200]}")
    except Exception as e:
        raise HTTPException(500, f"extract failed: {e}")
    finally:
        try: os.unlink(tmp_path)
        except OSError: pass


# ─── Moltbook identity integration ────────────────────────
#
# Two flows:
#   POST /api/moltbook/connect  — verify an agent's Moltbook API key
#                                  and link it to their DLF agent_id
#   GET  /api/moltbook/status   — DLF-side integration health
#   POST /api/moltbook/celebrate — post an achievement (DLF system agent)
#
# The user's Moltbook API key is only sent to our backend (not the
# browser). We verify once then store the link on disk. Future calls
# use the stored key for broadcasting.


@app.post("/api/moltbook/connect")
async def moltbook_connect(payload: dict):
    """Verify a Moltbook API key and link it to a DLF agent.

    Body: { dlf_agent_id, api_key }
    Returns: { linked, molty_name, verified, api_key_hint } on success.
    """
    from . import moltbook as mb

    dlf_agent_id = (payload or {}).get("dlf_agent_id", "").strip()
    api_key = (payload or {}).get("api_key", "").strip()
    if not dlf_agent_id:
        raise HTTPException(400, "dlf_agent_id required")
    if not api_key:
        raise HTTPException(400, "api_key required")

    ok, profile, msg = mb.verify_identity(api_key)
    if not ok or profile is None:
        raise HTTPException(400, f"Moltbook verification failed: {msg}")

    link = mb.link_identity(dlf_agent_id, profile, api_key)
    return {"linked": True, **link}


@app.post("/api/moltbook/disconnect")
async def moltbook_disconnect(payload: dict):
    """Remove a Moltbook link."""
    from . import moltbook as mb
    aid = (payload or {}).get("dlf_agent_id", "").strip()
    if not aid:
        raise HTTPException(400, "dlf_agent_id required")
    removed = mb.unlink_identity(aid)
    return {"removed": removed, "dlf_agent_id": aid}


@app.get("/api/moltbook/status")
def moltbook_status():
    from . import moltbook as mb
    return mb.status()


@app.get("/api/moltbook/links")
def moltbook_links():
    """List all linked identities (no api_keys in response)."""
    from . import moltbook as mb
    return {"links": mb.list_linked_identities()}


@app.post("/api/moltbook/swarm")
async def moltbook_swarm(payload: dict):
    """Post a labeling job to Moltbook — request the agent swarm to help.

    Body: { query: "tigers", image_count: 15, play_url?: "..." }
    """
    from . import moltbook as mb
    query = (payload or {}).get("query", "").strip()
    count = int((payload or {}).get("image_count", 0))
    play_url = (payload or {}).get("play_url", "")
    if not query or count <= 0:
        raise HTTPException(400, "query and image_count required")
    return mb.request_swarm_help(query=query, image_count=count, play_url=play_url or "https://data-label-factory.app/play")


@app.post("/api/moltbook/celebrate")
async def moltbook_celebrate(payload: dict):
    """Post an achievement on behalf of a linked DLF agent.

    Body: { dlf_agent_id, event_type, details }
    Rate-limited client-side (1 post / 30 min per system agent).
    """
    from . import moltbook as mb
    aid = (payload or {}).get("dlf_agent_id", "").strip()
    event_type = (payload or {}).get("event_type", "").strip()
    details = (payload or {}).get("details") or {}
    if not aid or not event_type:
        raise HTTPException(400, "dlf_agent_id and event_type required")
    return mb.celebrate_milestone(aid, event_type, details)


# ─── Benchmark results (Roboflow) ─────────────────────────
#
# ─── Page rendering (lit screenshot → PNG) ────────────────

@app.post("/api/render-page")
async def render_page(
    file: UploadFile = File(...),
    page: int = Form(default=1),
    dpi: int = Form(default=150),
):
    """Upload a doc, render page to PNG via lit screenshot. Returns image/png."""
    import shutil as _shutil
    import subprocess as _sp

    lit_bin = _shutil.which("lit")
    if not lit_bin:
        raise HTTPException(503, "lit CLI not found")

    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix not in PARSE_SUPPORTED:
        raise HTTPException(400, f"unsupported file type {suffix!r}")

    max_bytes = MAX_PARSE_MB * 1024 * 1024
    total = 0
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOAD_DIR)) as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                f.close(); os.unlink(f.name)
                raise HTTPException(413, "file too large")
            f.write(chunk)
        tmp_path = f.name

    out_dir = tempfile.mkdtemp(prefix="dlf-render-", dir=str(UPLOAD_DIR))
    try:
        cmd = [lit_bin, "screenshot", tmp_path, "--output-dir", out_dir,
               "--format", "png", "--dpi", str(dpi), "--target-pages", str(page), "-q"]
        proc = _sp.run(cmd, capture_output=True, text=True, timeout=60,
                       env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")})
        if proc.returncode != 0:
            raise HTTPException(422, f"render failed: {(proc.stderr or proc.stdout)[:300]}")
        pngs = sorted(Path(out_dir).glob("*.png"))
        if not pngs:
            raise HTTPException(500, "no PNG produced")
        return FileResponse(str(pngs[0]), media_type="image/png")
    except _sp.TimeoutExpired:
        raise HTTPException(504, "render timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"render error: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ─── Benchmark results ────────────────────────────────────
# Reads the JSON produced by `python3 -m data_label_factory.benchmark_roboflow`.

@app.get("/api/benchmark/roboflow")
def benchmark_roboflow():
    """Return the latest Roboflow Invoice-NER benchmark report."""
    candidates = [
        Path("/tmp/dlf_roboflow_full.json"),
        Path(os.environ.get("DLF_BENCHMARK_PATH", "/tmp/dlf_roboflow_full.json")),
    ]
    for p in candidates:
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:
                continue
    raise HTTPException(404, "no benchmark report available — run `python3 -m data_label_factory.benchmark_roboflow --dataset PATH --ocr`")


# ─── Cloud storage integration ─────────────────────────────
#
# Proxy routes for Google Drive, Dropbox, and Bitbucket file access.
# OAuth tokens are stored server-side via storage_tokens.py.
# The browser only sees "connected: true/false" + file listings.
#
# Required env vars per provider:
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
#   DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET
#   BITBUCKET_CLIENT_ID, BITBUCKET_CLIENT_SECRET
#
# Document types we allow:
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".tiff"}
STORAGE_PAGE_SIZE = 50  # max files per listing request


def _storage_list_gdrive(access_token: str, folder_id: Optional[str] = None) -> list[dict]:
    """List files from Google Drive using the v3 API."""
    # Build query: documents only, in a specific folder if given
    mime_filters = " or ".join(
        f"mimeType='{m}'"
        for m in [
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "image/png", "image/jpeg", "image/tiff",
            "application/vnd.google-apps.folder",
        ]
    )
    q = f"({mime_filters}) and trashed=false"
    if folder_id:
        q += f" and '{folder_id}' in parents"

    url = (
        f"https://www.googleapis.com/drive/v3/files"
        f"?q={urllib.parse.quote(q)}"
        f"&fields=files(id,name,mimeType,size,modifiedTime,parents)"
        f"&pageSize={STORAGE_PAGE_SIZE}"
        f"&orderBy=modifiedTime desc"
    )
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {access_token}",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
    except Exception as e:
        raise HTTPException(502, f"Google Drive API error: {e}")

    items = []
    for f in data.get("files", []):
        is_folder = f.get("mimeType") == "application/vnd.google-apps.folder"
        item: dict[str, Any] = {
            "id": f["id"],
            "name": f.get("name", ""),
            "path": f"/{f.get('name', '')}",
        }
        if is_folder:
            item["type"] = "folder"
        else:
            item["type"] = "file"
            item["size"] = int(f.get("size", 0))
            item["mimeType"] = f.get("mimeType", "")
            item["modifiedAt"] = f.get("modifiedTime", "")
        items.append(item)
    return items


def _storage_download_gdrive(access_token: str, file_id: str) -> str:
    """Download a file from Google Drive, save to tmp, return path."""
    # First get metadata for the filename
    meta_url = f"https://www.googleapis.com/drive/v3/files/{file_id}?fields=name,mimeType"
    meta_req = urllib.request.Request(meta_url, headers={
        "Authorization": f"Bearer {access_token}",
    })
    try:
        with urllib.request.urlopen(meta_req, timeout=10) as r:
            meta = json.loads(r.read())
    except Exception as e:
        raise HTTPException(502, f"Google Drive metadata error: {e}")

    name = meta.get("name", f"gdrive_{file_id}")
    dl_url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
    dl_req = urllib.request.Request(dl_url, headers={
        "Authorization": f"Bearer {access_token}",
    })
    try:
        with urllib.request.urlopen(dl_req, timeout=60) as r:
            content = r.read()
    except Exception as e:
        raise HTTPException(502, f"Google Drive download error: {e}")

    tmp_path = os.path.join(tempfile.gettempdir(), f"dlf_storage_{int(time.time())}_{name}")
    with open(tmp_path, "wb") as fh:
        fh.write(content)
    return tmp_path


def _storage_list_dropbox(access_token: str, folder_id: Optional[str] = None) -> list[dict]:
    """List files from Dropbox using the v2 API."""
    path = folder_id or ""
    body = json.dumps({
        "path": path,
        "limit": STORAGE_PAGE_SIZE,
        "include_media_info": False,
    }).encode()
    req = urllib.request.Request(
        "https://api.dropboxapi.com/2/files/list_folder",
        data=body,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"Dropbox API error: {e.code}")
    except Exception as e:
        raise HTTPException(502, f"Dropbox API error: {e}")

    items = []
    for entry in data.get("entries", []):
        tag = entry.get(".tag", "")
        name = entry.get("name", "")
        ext = os.path.splitext(name)[1].lower()

        if tag == "folder":
            items.append({
                "id": entry.get("id", entry.get("path_lower", "")),
                "name": name,
                "path": entry.get("path_display", ""),
                "type": "folder",
            })
        elif tag == "file" and ext in ALLOWED_EXTENSIONS:
            items.append({
                "id": entry.get("id", entry.get("path_lower", "")),
                "name": name,
                "path": entry.get("path_display", ""),
                "type": "file",
                "size": int(entry.get("size", 0)),
                "mimeType": "",  # Dropbox doesn't return MIME
                "modifiedAt": entry.get("server_modified", ""),
            })
    return items


def _storage_download_dropbox(access_token: str, file_id: str) -> str:
    """Download a file from Dropbox, save to tmp, return path."""
    # Dropbox uses the path or id in a JSON header
    req = urllib.request.Request(
        "https://content.dropboxapi.com/2/files/download",
        data=b"",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Dropbox-API-Arg": json.dumps({"path": file_id}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            meta_str = r.headers.get("Dropbox-API-Result", "{}")
            meta = json.loads(meta_str)
            content = r.read()
    except Exception as e:
        raise HTTPException(502, f"Dropbox download error: {e}")

    name = meta.get("name", f"dropbox_{int(time.time())}")
    tmp_path = os.path.join(tempfile.gettempdir(), f"dlf_storage_{int(time.time())}_{name}")
    with open(tmp_path, "wb") as fh:
        fh.write(content)
    return tmp_path


def _storage_list_bitbucket(access_token: str, folder_id: Optional[str] = None) -> list[dict]:
    """List files from Bitbucket repositories.

    folder_id format: "{workspace}/{repo_slug}" or "{workspace}/{repo_slug}/src/{branch}/{path}"
    If empty, lists the user's repositories (as folders).
    """
    if not folder_id:
        # List user's repositories
        url = f"https://api.bitbucket.org/2.0/repositories?role=member&pagelen={STORAGE_PAGE_SIZE}"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {access_token}",
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.loads(r.read())
        except Exception as e:
            raise HTTPException(502, f"Bitbucket API error: {e}")

        return [
            {
                "id": f"{repo.get('full_name', '')}",
                "name": repo.get("name", ""),
                "path": f"/{repo.get('full_name', '')}",
                "type": "folder",
            }
            for repo in data.get("values", [])[:STORAGE_PAGE_SIZE]
        ]
    else:
        # List files in a repo path
        parts = folder_id.strip("/").split("/")
        if len(parts) < 2:
            raise HTTPException(400, "Bitbucket folder_id must be workspace/repo or workspace/repo/path")
        workspace, repo = parts[0], parts[1]
        sub_path = "/".join(parts[2:]) if len(parts) > 2 else ""

        url = f"https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/src/main/{sub_path}?pagelen={STORAGE_PAGE_SIZE}"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {access_token}",
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.loads(r.read())
        except Exception as e:
            raise HTTPException(502, f"Bitbucket API error: {e}")

        items = []
        for entry in data.get("values", []):
            etype = entry.get("type", "")
            name = entry.get("path", "").rsplit("/", 1)[-1]
            ext = os.path.splitext(name)[1].lower()
            full_path = entry.get("path", "")

            if etype == "commit_directory":
                items.append({
                    "id": f"{workspace}/{repo}/{full_path}",
                    "name": name,
                    "path": f"/{workspace}/{repo}/{full_path}",
                    "type": "folder",
                })
            elif etype == "commit_file" and ext in ALLOWED_EXTENSIONS:
                items.append({
                    "id": f"{workspace}/{repo}/{full_path}",
                    "name": name,
                    "path": f"/{workspace}/{repo}/{full_path}",
                    "type": "file",
                    "size": int(entry.get("size", 0)),
                    "mimeType": "",
                    "modifiedAt": "",
                })
        return items


def _storage_download_bitbucket(access_token: str, file_id: str) -> str:
    """Download a file from Bitbucket, save to tmp, return path."""
    parts = file_id.strip("/").split("/")
    if len(parts) < 3:
        raise HTTPException(400, "Invalid Bitbucket file_id")
    workspace, repo = parts[0], parts[1]
    file_path = "/".join(parts[2:])

    url = f"https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/src/main/{file_path}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {access_token}",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            content = r.read()
    except Exception as e:
        raise HTTPException(502, f"Bitbucket download error: {e}")

    name = parts[-1]
    tmp_path = os.path.join(tempfile.gettempdir(), f"dlf_storage_{int(time.time())}_{name}")
    with open(tmp_path, "wb") as fh:
        fh.write(content)
    return tmp_path


# Dispatch tables
_STORAGE_LIST = {
    "gdrive": _storage_list_gdrive,
    "dropbox": _storage_list_dropbox,
    "bitbucket": _storage_list_bitbucket,
}
_STORAGE_DOWNLOAD = {
    "gdrive": _storage_download_gdrive,
    "dropbox": _storage_download_dropbox,
    "bitbucket": _storage_download_bitbucket,
}


@app.get("/api/storage/{provider}/files")
def storage_list_files(provider: str, user_id: str = "", folder_id: str = ""):
    """List files for a connected cloud storage provider."""
    from . import storage_tokens as st

    if provider not in st.VALID_PROVIDERS:
        raise HTTPException(400, f"Unknown provider: {provider}")
    if not user_id:
        raise HTTPException(400, "user_id required")

    tokens = st.get_token(user_id, provider)
    if not tokens:
        raise HTTPException(401, f"Not connected to {provider}")

    access_token = tokens.get("access_token", "")
    if not access_token:
        raise HTTPException(401, f"No access token for {provider}")

    list_fn = _STORAGE_LIST.get(provider)
    if not list_fn:
        raise HTTPException(400, f"Unsupported provider: {provider}")

    items = list_fn(access_token, folder_id or None)
    return {"items": items, "provider": provider, "folder_id": folder_id}


@app.post("/api/storage/{provider}/download")
async def storage_download_file(provider: str, payload: dict):
    """Download a file from cloud storage and return the local path.

    Body: { user_id, file_id }
    Returns: { path, filename }
    """
    from . import storage_tokens as st

    if provider not in st.VALID_PROVIDERS:
        raise HTTPException(400, f"Unknown provider: {provider}")

    user_id = (payload or {}).get("user_id", "").strip()
    file_id = (payload or {}).get("file_id", "").strip()
    if not user_id or not file_id:
        raise HTTPException(400, "user_id and file_id required")

    tokens = st.get_token(user_id, provider)
    if not tokens:
        raise HTTPException(401, f"Not connected to {provider}")

    access_token = tokens.get("access_token", "")
    dl_fn = _STORAGE_DOWNLOAD.get(provider)
    if not dl_fn:
        raise HTTPException(400, f"Unsupported provider: {provider}")

    tmp_path = dl_fn(access_token, file_id)
    filename = os.path.basename(tmp_path)
    return {"path": tmp_path, "filename": filename}


@app.get("/api/storage/connected")
def storage_connected(user_id: str = ""):
    """Return which providers are connected for a user."""
    from . import storage_tokens as st

    if not user_id:
        raise HTTPException(400, "user_id required")
    providers = st.list_connected(user_id)
    return {
        "connected": [
            {"provider": p, "connected": True}
            for p in providers
        ]
    }


@app.post("/api/storage/{provider}/token")
async def storage_save_token(provider: str, payload: dict):
    """Store OAuth tokens after callback exchange. Called by the Next.js callback route.

    Body: { user_id, tokens: { access_token, refresh_token?, ... } }
    INTERNAL ONLY — not exposed to the browser.
    """
    from . import storage_tokens as st

    if provider not in st.VALID_PROVIDERS:
        raise HTTPException(400, f"Unknown provider: {provider}")

    user_id = (payload or {}).get("user_id", "").strip()
    tokens = (payload or {}).get("tokens")
    if not user_id or not tokens:
        raise HTTPException(400, "user_id and tokens required")

    st.save_token(user_id, provider, tokens)
    return {"saved": True, "provider": provider}


@app.delete("/api/storage/{provider}/disconnect")
def storage_disconnect(provider: str, user_id: str = ""):
    """Remove stored tokens for a provider."""
    from . import storage_tokens as st

    if provider not in st.VALID_PROVIDERS:
        raise HTTPException(400, f"Unknown provider: {provider}")
    if not user_id:
        raise HTTPException(400, "user_id required")

    removed = st.delete_token(user_id, provider)
    return {"removed": removed, "provider": provider}


# ─── Experiments ───────────────────────────────────────────

@app.get("/api/experiments")
def list_experiments_api():
    from .experiments import list_experiments
    return {"experiments": list_experiments()}


# ─── Communities ──────────────────────────────────────────

@app.get("/api/communities")
def list_communities_api():
    from .community import list_communities, community_stats
    return {"communities": list_communities(), "stats": community_stats()}


@app.post("/api/community/auto-post")
def auto_post_labeling_api(body: dict):
    from .community import auto_post_labeling_job
    query = body.get("query", "")
    image_count = body.get("image_count", 0)
    if not query:
        raise HTTPException(400, "query is required")
    return auto_post_labeling_job(
        query=query,
        image_count=image_count,
        agent_id=body.get("agent_id", "system"),
        cross_post=body.get("cross_post", False),
    )


@app.get("/api/community/{slug}")
def get_community_api(slug: str):
    from .community import get_community, get_posts
    c = get_community(slug)
    if not c:
        raise HTTPException(404, f"Community '{slug}' not found")
    posts = get_posts(slug, limit=50)
    return {"community": c, "posts": posts}


@app.post("/api/community")
def create_community_api(body: dict):
    from .community import create_community
    slug = body.get("slug", "").strip().lower().replace(" ", "-")
    name = body.get("name", "").strip()
    if not slug or not name:
        raise HTTPException(400, "slug and name are required")
    result = create_community(
        slug=slug, name=name,
        description=body.get("description", ""),
        icon=body.get("icon", "tag"),
        color=body.get("color", "#3b82f6"),
        tags=body.get("tags", []),
    )
    if "error" in result:
        raise HTTPException(409, result["error"])
    return result


@app.post("/api/community/{slug}/join")
def join_community_api(slug: str, body: dict):
    from .community import join_community
    agent_id = body.get("agent_id", "anonymous")
    if not join_community(slug, agent_id):
        raise HTTPException(404, "Community not found")
    return {"ok": True, "slug": slug, "agent_id": agent_id}


@app.post("/api/community/{slug}/leave")
def leave_community_api(slug: str, body: dict):
    from .community import leave_community
    agent_id = body.get("agent_id", "anonymous")
    if not leave_community(slug, agent_id):
        raise HTTPException(404, "Community not found")
    return {"ok": True, "slug": slug, "agent_id": agent_id}


@app.post("/api/community/{slug}/post")
def create_post_api(slug: str, body: dict):
    from .community import create_post
    author = body.get("author", "anonymous")
    title = body.get("title", "").strip()
    post_body = body.get("body", "").strip()
    if not title:
        raise HTTPException(400, "title is required")
    result = create_post(
        community_slug=slug,
        author=author,
        title=title,
        body=post_body,
        post_type=body.get("post_type", "discussion"),
        metadata=body.get("metadata"),
        cross_post_moltbook=body.get("cross_post_moltbook", False),
    )
    if "error" in result:
        raise HTTPException(404, result["error"])
    return result


@app.post("/api/community/{slug}/post/{post_id}/react")
def react_to_post_api(slug: str, post_id: str, body: dict):
    from .community import react_to_post
    reaction = body.get("reaction", "fire")
    result = react_to_post(slug, post_id, reaction)
    if not result:
        raise HTTPException(404, "Post not found or invalid reaction")
    return result


@app.post("/api/community/{slug}/post/{post_id}/comment")
def comment_on_post_api(slug: str, post_id: str, body: dict):
    from .community import add_comment
    author = body.get("author", "anonymous")
    text = body.get("text", "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    result = add_comment(slug, post_id, author, text)
    if not result:
        raise HTTPException(404, "Post not found")
    return result


# ─── Health ────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok", "version": "0.2.0", "timestamp": datetime.now().isoformat()}


# ─── Main ──────────────────────────────────────────────────

def main():
    import argparse
    import uvicorn

    p = argparse.ArgumentParser(prog="data_label_factory.serve")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8400)
    args = p.parse_args()

    print(f"data-label-factory API server on http://{args.host}:{args.port}")
    print(f"  Docs: http://localhost:{args.port}/docs")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
