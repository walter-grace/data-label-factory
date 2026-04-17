"""
mcp.py — MCP server exposing data-label-factory as tools for AI agents.

An agent (Claude Desktop, Claude Code, etc.) can tell the factory:
  "I need 500 labeled images of fire hydrants"
and the factory handles everything: project creation, gathering, labeling,
verification, and returns the results.

Tools exposed:
  - label_dataset:   Full pipeline — samples + description → labeled COCO dataset
  - create_project:  Auto-generate a project YAML from samples + description
  - run_pipeline:    Run gather → filter → label on an existing project
  - check_status:    Check which backends are alive
  - list_providers:  Show registered providers and capabilities
  - score_results:   Run deterministic metrics on a COCO file
  - benchmark:       Compare two labeling runs

Usage:
    # Run as MCP server (stdio)
    python3 -m data_label_factory.mcp

    # Register in claude_desktop_config.json:
    {
      "mcpServers": {
        "data-label-factory": {
          "command": "python3",
          "args": ["-m", "data_label_factory.mcp"]
        }
      }
    }
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any


def _make_server():
    """Build and return the MCP server with all tools registered."""
    try:
        from mcp.server import Server
        from mcp.server.stdio import run_server
        from mcp.types import Tool, TextContent
    except ImportError:
        raise ImportError(
            "MCP SDK not installed. Run: pip install mcp"
        )

    server = Server("data-label-factory")

    @server.list_tools()
    async def list_tools():
        return [
            Tool(
                name="label_dataset",
                description=(
                    "Create a labeled vision dataset from sample images and a description. "
                    "Analyzes samples, picks optimal backends, gathers more images, "
                    "runs detection/labeling, and returns COCO-format annotations. "
                    "This is the main entry point — give it samples and a description, "
                    "get back a labeled dataset."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "samples_dir": {
                            "type": "string",
                            "description": "Path to directory of sample images",
                        },
                        "description": {
                            "type": "string",
                            "description": 'What to label (e.g. "fire hydrants in urban settings")',
                        },
                        "max_images": {
                            "type": "integer",
                            "description": "Max images to gather and label (default 50)",
                            "default": 50,
                        },
                        "backend": {
                            "type": "string",
                            "description": "Override label backend (falcon, wilddet3d, chandra, flywheel)",
                        },
                    },
                    "required": ["samples_dir", "description"],
                },
            ),
            Tool(
                name="create_project",
                description=(
                    "Auto-generate a project YAML from sample images + description. "
                    "Analyzes content type, picks optimal backends, generates search queries."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "samples_dir": {
                            "type": "string",
                            "description": "Path to directory of sample images",
                        },
                        "description": {
                            "type": "string",
                            "description": 'What to label (e.g. "stop signs")',
                        },
                        "name": {
                            "type": "string",
                            "description": "Project name (optional, auto-generated if empty)",
                        },
                    },
                    "required": ["samples_dir", "description"],
                },
            ),
            Tool(
                name="check_status",
                description="Check which labeling backends are alive and available.",
                inputSchema={"type": "object", "properties": {}},
            ),
            Tool(
                name="list_providers",
                description="List all registered labeling providers and their capabilities.",
                inputSchema={"type": "object", "properties": {}},
            ),
            Tool(
                name="score_results",
                description=(
                    "Run deterministic quality metrics on a COCO annotation file. "
                    "Returns pass rates, area ratios, and per-rule breakdowns."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "coco_path": {
                            "type": "string",
                            "description": "Path to COCO JSON annotation file",
                        },
                    },
                    "required": ["coco_path"],
                },
            ),
            Tool(
                name="benchmark",
                description=(
                    "Compare two COCO annotation files with deterministic metrics. "
                    "Returns IoU agreement, precision/recall, and per-category breakdown."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "coco_a": {"type": "string", "description": "Path to first COCO JSON"},
                        "coco_b": {"type": "string", "description": "Path to second COCO JSON"},
                    },
                    "required": ["coco_a", "coco_b"],
                },
            ),
            Tool(
                name="generate_synthetic",
                description=(
                    "Generate synthetic training data using the flywheel pattern. "
                    "Composites reference images onto random backgrounds with perfect labels."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "refs_dir": {
                            "type": "string",
                            "description": "Directory of reference images (PNGs with alpha)",
                        },
                        "output_dir": {
                            "type": "string",
                            "description": "Output directory for generated dataset",
                        },
                        "n_scenes": {
                            "type": "integer",
                            "description": "Number of scenes to generate (default 100)",
                            "default": 100,
                        },
                    },
                    "required": ["refs_dir", "output_dir"],
                },
            ),
            Tool(
                name="play_flywheel_docs",
                description=(
                    "Play the *document-layout* Flywheel game. Get a challenge "
                    "block from a parsed document and answer YES or NO to a "
                    "structural question (e.g. 'Is this block a section header?'). "
                    "Each challenge returns block_text, bbox, and a page_image_url "
                    "so text-only LLMs AND vision models can play. Honeypot trust "
                    "+ GRPO reward pool mirror the image-mode game."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["challenge", "answer", "docs", "stats", "register"],
                            "description": "Action: get a challenge, submit answer, list documents, check stats, or register",
                        },
                        "agent_name": {
                            "type": "string",
                            "description": "Your agent name",
                        },
                        "challenge_id": {
                            "type": "string",
                            "description": "Challenge ID from a previous challenge (for answer action)",
                        },
                        "answer": {
                            "type": "string",
                            "enum": ["YES", "NO"],
                            "description": "YES or NO (for answer action)",
                        },
                        "custom_endpoint": {
                            "type": "string",
                            "description": "Your custom vision API endpoint URL (for register, optional)",
                        },
                    },
                    "required": ["action"],
                },
            ),
            Tool(
                name="connect_moltbook",
                description=(
                    "Link an agent's Moltbook (https://www.moltbook.com) "
                    "identity to their DLF agent_id. DLF verifies by calling "
                    "Moltbook's /api/v1/agents/me with the agent's API key. "
                    "After linking, DLF scores attribute to the Moltbook "
                    "`molty_name` and achievements can be broadcast to the "
                    "bot social feed."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "agent_id": {
                            "type": "string",
                            "description": "DLF agent ID (same one used on /api/agent endpoints)",
                        },
                        "moltbook_api_key": {
                            "type": "string",
                            "description": "Your Moltbook API key (moltbook_xxx)",
                        },
                    },
                    "required": ["agent_id", "moltbook_api_key"],
                },
            ),
            Tool(
                name="extract_from_template",
                description=(
                    "Apply a saved document-extraction template to a PDF and "
                    "return structured fields (invoice_number, total, date, etc.) "
                    "as a JSON object. Templates live in the marketplace library "
                    "(prebuilt: us-invoice, w2, 1099-nec, receipt, service-agreement) "
                    "or user folder. Use `list_templates` first to discover options."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "template_name": {
                            "type": "string",
                            "description": "Template slug (e.g. 'us-invoice')",
                        },
                        "pdf_path": {
                            "type": "string",
                            "description": "Absolute path to the PDF/DOCX/image",
                        },
                        "library": {
                            "type": "boolean",
                            "default": False,
                            "description": "Force library (true) or user (false) source",
                        },
                    },
                    "required": ["template_name", "pdf_path"],
                },
            ),
            Tool(
                name="list_templates",
                description=(
                    "List all document-extraction templates — library (prebuilt) "
                    "and user-created. Returns names + descriptions + field counts."
                ),
                inputSchema={"type": "object", "properties": {}},
            ),
            Tool(
                name="parse_document",
                description=(
                    "Parse a local document (PDF/DOCX/XLSX/PPTX/image) into "
                    "layout-preserving text + block bboxes. Uses LiteParse "
                    "(fast, local, no GPU) by default; falls back to Chandra "
                    "for heavy OCR. RAM-safe: 50 MB cap, 60 s timeout, OCR "
                    "opt-in. Use when an agent needs to read a document's "
                    "contents or label its structural regions."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the document file",
                        },
                        "backend": {
                            "type": "string",
                            "enum": ["liteparse", "chandra"],
                            "default": "liteparse",
                            "description": "liteparse (fast, local) or chandra (heavy OCR)",
                        },
                        "ocr": {
                            "type": "boolean",
                            "default": False,
                            "description": "Opt-in OCR (RAM-heavy; only needed for scans)",
                        },
                        "queries": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Block types to extract (e.g. ['table','header']). Empty = all.",
                        },
                    },
                    "required": ["path"],
                },
            ),
            Tool(
                name="play_flywheel",
                description=(
                    "Play the Flywheel labeling game. Get a challenge image + target, "
                    "answer YES or NO to verify the AI's prediction. Builds trust score "
                    "and contributes to GRPO training. Agents can play just like humans."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["challenge", "answer", "stats", "register"],
                            "description": "Action: get a challenge, submit answer, check stats, or register",
                        },
                        "agent_name": {
                            "type": "string",
                            "description": "Your agent name (for register action)",
                        },
                        "challenge_id": {
                            "type": "string",
                            "description": "Challenge ID from a previous challenge (for answer action)",
                        },
                        "answer": {
                            "type": "string",
                            "enum": ["YES", "NO"],
                            "description": "Your answer (for answer action)",
                        },
                        "custom_endpoint": {
                            "type": "string",
                            "description": "Your custom vision API endpoint URL (for register action, optional)",
                        },
                    },
                    "required": ["action"],
                },
            ),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list:
        try:
            result = _dispatch(name, arguments)
            return [TextContent(type="text", text=json.dumps(result, indent=2))]
        except Exception as e:
            return [TextContent(
                type="text",
                text=json.dumps({"error": str(e), "traceback": traceback.format_exc()})
            )]

    return server


def _dispatch(name: str, args: dict) -> dict:
    """Route tool calls to implementations."""

    if name == "check_status":
        return _tool_check_status()

    if name == "list_providers":
        return _tool_list_providers()

    if name == "create_project":
        return _tool_create_project(args)

    if name == "label_dataset":
        return _tool_label_dataset(args)

    if name == "score_results":
        return _tool_score_results(args)

    if name == "benchmark":
        return _tool_benchmark(args)

    if name == "generate_synthetic":
        return _tool_generate_synthetic(args)

    if name == "play_flywheel":
        return _tool_play_flywheel(args)

    if name == "parse_document":
        return _tool_parse_document(args)

    if name == "play_flywheel_docs":
        return _tool_play_flywheel_docs(args)

    if name == "extract_from_template":
        return _tool_extract_from_template(args)

    if name == "connect_moltbook":
        return _tool_connect_moltbook(args)

    if name == "list_templates":
        return _tool_list_templates_docs()

    return {"error": f"unknown tool: {name}"}


def _tool_check_status() -> dict:
    from .providers import list_providers, create_provider
    results = {}
    for pname in list_providers():
        try:
            p = create_provider(pname)
            st = p.status()
            results[pname] = {
                "alive": st.get("alive", False),
                "capabilities": sorted(p.capabilities),
                "info": str(st.get("info", ""))[:200],
            }
        except Exception as e:
            results[pname] = {"alive": False, "error": str(e)}
    return {"providers": results}


def _tool_list_providers() -> dict:
    from .providers import list_providers, create_provider
    providers = []
    for pname in list_providers():
        try:
            p = create_provider(pname)
            providers.append({
                "name": pname,
                "capabilities": sorted(p.capabilities),
            })
        except Exception as e:
            providers.append({"name": pname, "error": str(e)})
    return {"providers": providers}


def _tool_create_project(args: dict) -> dict:
    from .auto import auto_project
    samples_dir = args["samples_dir"]
    description = args["description"]
    name = args.get("name", "")
    output = f"projects/{name or description.lower().replace(' ', '-')[:30]}.yaml"

    config = auto_project(
        samples=samples_dir,
        description=description,
        project_name=name,
        output=output,
    )
    return {
        "project_yaml": output,
        "config": config,
        "next_step": f"data_label_factory pipeline --project {output}",
    }


def _tool_label_dataset(args: dict) -> dict:
    from .auto import auto_project
    from .project import load_project
    from .providers import create_provider
    from .experiments import make_experiment_dir, write_config, update_latest_symlink
    from datetime import datetime
    import time

    samples_dir = args["samples_dir"]
    description = args["description"]
    max_images = args.get("max_images", 50)
    backend_override = args.get("backend")

    # Step 1: Auto-create project
    name = description.lower().replace(" ", "-")[:30]
    output_yaml = f"projects/{name}.yaml"
    config = auto_project(
        samples=samples_dir,
        description=description,
        project_name=name,
        output=output_yaml,
        analyze=True,
    )

    # Step 2: Load project and label with best backend
    proj = load_project(output_yaml)
    backend = backend_override or config["backends"]["label"]

    try:
        provider = create_provider(backend)
    except ValueError:
        backend = "falcon"
        provider = create_provider(backend)

    status = provider.status()
    if not status.get("alive"):
        return {
            "error": f"{backend} not available",
            "status": status,
            "project_yaml": output_yaml,
            "suggestion": "Start the backend server, then run: "
                          f"data_label_factory label-v2 --project {output_yaml} --backend {backend}",
        }

    # Step 3: Collect images (from samples dir for now)
    img_root = os.path.expanduser(config["data_root"])
    images = []
    for dirpath, _, filenames in os.walk(img_root):
        for fn in filenames:
            if fn.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, img_root)
                images.append((rel, full))

    if not images:
        return {
            "error": "No images found. Run gather first or add more samples.",
            "data_root": img_root,
            "project_yaml": output_yaml,
        }

    images = images[:max_images]

    # Step 4: Label
    from PIL import Image as PILImage
    exp = make_experiment_dir(f"mcp-label-{name}")
    coco = {
        "info": {
            "description": f"MCP label run: {description}",
            "date_created": datetime.now().isoformat(timespec="seconds"),
            "backend": backend,
        },
        "images": [],
        "annotations": [],
        "categories": [
            {"id": i + 1, "name": q, "supercategory": "object"}
            for i, q in enumerate(proj.falcon_queries)
        ],
    }
    cat_id = {q: i + 1 for i, q in enumerate(proj.falcon_queries)}
    next_img_id, next_ann_id = 1, 1
    t0 = time.time()

    for rel, full in images:
        try:
            im = PILImage.open(full)
            iw, ih = im.size
        except Exception:
            continue

        img_id = next_img_id
        next_img_id += 1
        coco["images"].append({"id": img_id, "file_name": rel, "width": iw, "height": ih})

        result = provider.label_image(full, proj.falcon_queries, image_wh=(iw, ih))
        for ann in result.annotations:
            cat_name = ann.get("category", proj.falcon_queries[0])
            cid = cat_id.get(cat_name)
            if cid is None:
                cid = len(coco["categories"]) + 1
                coco["categories"].append({"id": cid, "name": cat_name, "supercategory": "object"})
                cat_id[cat_name] = cid
            coco["annotations"].append({
                "id": next_ann_id, "image_id": img_id,
                "category_id": cid,
                "bbox": ann["bbox"],
                "area": round(ann["bbox"][2] * ann["bbox"][3], 2),
                "iscrowd": 0,
                "score": ann.get("score", 1.0),
            })
            next_ann_id += 1

    elapsed = time.time() - t0

    # Save
    out_dir = os.path.join(exp, f"label_{backend}")
    os.makedirs(out_dir, exist_ok=True)
    coco_path = os.path.join(out_dir, f"{name}.coco.json")
    with open(coco_path, "w") as f:
        json.dump(coco, f, indent=2)
    write_config(exp, {"tool": "label_dataset", **args, "backend": backend})
    update_latest_symlink(exp)

    # Score
    from .metrics import score_coco
    score = score_coco(coco)

    return {
        "experiment": exp,
        "coco_path": coco_path,
        "project_yaml": output_yaml,
        "backend": backend,
        "images": len(coco["images"]),
        "annotations": len(coco["annotations"]),
        "elapsed_seconds": round(elapsed, 1),
        "quality": {
            "pass_rate": round(score.pass_rate, 4),
            "mean_score": round(score.mean_score, 4),
            "rule_breakdown": {k: round(v, 4) for k, v in score.rule_breakdown.items()},
        },
        "per_category": score.per_category,
    }


def _tool_score_results(args: dict) -> dict:
    from .metrics import score_coco
    coco_path = args["coco_path"]
    with open(coco_path) as f:
        coco = json.load(f)
    score = score_coco(coco)
    return {
        "total_images": score.total_images,
        "total_annotations": score.total_annotations,
        "pass_rate": round(score.pass_rate, 4),
        "mean_score": round(score.mean_score, 4),
        "mean_area_ratio": round(score.mean_area_ratio, 4),
        "rule_breakdown": {k: round(v, 4) for k, v in score.rule_breakdown.items()},
        "per_category": score.per_category,
    }


def _tool_benchmark(args: dict) -> dict:
    from .metrics import score_coco, match_annotations
    from collections import defaultdict

    with open(args["coco_a"]) as f:
        coco_a = json.load(f)
    with open(args["coco_b"]) as f:
        coco_b = json.load(f)

    score_a = score_coco(coco_a)
    score_b = score_coco(coco_b)

    # Cross-compare on shared images
    id_to_fname_a = {img["id"]: img["file_name"] for img in coco_a.get("images", [])}
    id_to_fname_b = {img["id"]: img["file_name"] for img in coco_b.get("images", [])}
    shared = set(id_to_fname_a.values()) & set(id_to_fname_b.values())

    cats_a = {c["id"]: c["name"] for c in coco_a.get("categories", [])}
    cats_b = {c["id"]: c["name"] for c in coco_b.get("categories", [])}

    comparison = {}
    if shared:
        anns_a_by_img = defaultdict(list)
        for ann in coco_a.get("annotations", []):
            fname = id_to_fname_a.get(ann["image_id"], "")
            if fname in shared:
                a = dict(ann)
                a["category"] = cats_a.get(ann.get("category_id"), "")
                anns_a_by_img[fname].append(a)

        anns_b_by_img = defaultdict(list)
        for ann in coco_b.get("annotations", []):
            fname = id_to_fname_b.get(ann["image_id"], "")
            if fname in shared:
                b = dict(ann)
                b["category"] = cats_b.get(ann.get("category_id"), "")
                anns_b_by_img[fname].append(b)

        all_matched, all_ua, all_ub = [], [], []
        for fname in shared:
            report = match_annotations(anns_a_by_img[fname], anns_b_by_img[fname])
            all_matched.extend(report.matched)
            all_ua.extend(report.unmatched_a)
            all_ub.extend(report.unmatched_b)

        n_m = len(all_matched)
        comparison = {
            "shared_images": len(shared),
            "matched": n_m,
            "only_a": len(all_ua),
            "only_b": len(all_ub),
            "precision": round(n_m / max(n_m + len(all_ua), 1), 4),
            "recall": round(n_m / max(n_m + len(all_ub), 1), 4),
            "mean_iou": round(sum(m.iou for m in all_matched) / max(n_m, 1), 4),
        }

    return {
        "a": {
            "path": args["coco_a"],
            "images": score_a.total_images,
            "annotations": score_a.total_annotations,
            "pass_rate": round(score_a.pass_rate, 4),
        },
        "b": {
            "path": args["coco_b"],
            "images": score_b.total_images,
            "annotations": score_b.total_annotations,
            "pass_rate": round(score_b.pass_rate, 4),
        },
        "comparison": comparison,
    }


def _tool_generate_synthetic(args: dict) -> dict:
    from .providers import create_provider
    provider = create_provider("flywheel", config={"refs_dir": args["refs_dir"]})
    return provider.generate_dataset(
        refs_dir=args["refs_dir"],
        output_dir=args["output_dir"],
        n_scenes=args.get("n_scenes", 100),
    )


def _tool_parse_document(args: dict) -> dict:
    """Parse a document via the liteparse / chandra provider."""
    from .providers import create_provider

    path = args.get("path")
    if not path or not os.path.exists(path):
        return {"error": f"file not found: {path!r}"}

    backend = args.get("backend", "liteparse")
    if backend not in ("liteparse", "chandra"):
        return {"error": f"backend must be liteparse or chandra, got {backend!r}"}

    ocr = bool(args.get("ocr", False))
    queries = args.get("queries") or []

    try:
        if backend == "liteparse":
            provider = create_provider("liteparse", config={"ocr": ocr})
            st = provider.status()
            if not st.get("alive"):
                return {"error": f"liteparse unavailable: {st.get('info')}"}
            if queries:
                # Structural labeling mode
                lr = provider.label_image(path, queries)
                return {
                    "backend": "liteparse",
                    "annotations": lr.annotations,
                    "metadata": lr.metadata,
                    "elapsed_ms": round(lr.elapsed * 1000, 1),
                }
            # Raw parse mode
            result = provider.parse(path, ocr=ocr)
            # Truncate text to keep MCP response reasonable
            text = result.get("text", "")
            return {
                "backend": "liteparse",
                "text_preview": text[:2000] + ("..." if len(text) > 2000 else ""),
                "text_length": len(text),
                "pages": [
                    {"page": p.get("page"), "block_count": len(p.get("blocks") or [])}
                    for p in result.get("pages", [])
                ],
                "elapsed_ms": result.get("elapsed_ms"),
            }

        # chandra path
        provider = create_provider("chandra")
        lr = provider.label_image(path, queries or ["text", "table", "header"])
        return {
            "backend": "chandra",
            "annotations": lr.annotations,
            "metadata": lr.metadata,
            "elapsed_ms": round(lr.elapsed * 1000, 1),
        }
    except Exception as e:
        return {"error": f"parse failed: {e}"}


def _tool_connect_moltbook(args: dict) -> dict:
    """Link an agent's Moltbook identity to their DLF agent."""
    from . import moltbook as mb

    agent_id = (args.get("agent_id") or "").strip()
    api_key = (args.get("moltbook_api_key") or "").strip()
    if not agent_id or not api_key:
        return {"error": "agent_id and moltbook_api_key are required"}

    ok, profile, msg = mb.verify_identity(api_key)
    if not ok or profile is None:
        return {"error": f"verify failed: {msg}"}

    link = mb.link_identity(agent_id, profile, api_key)
    return {"linked": True, **link}


def _tool_list_templates_docs() -> dict:
    """Enumerate library + user templates for agents to pick from."""
    from .doc_template import list_templates
    return {
        "library": [t.summary() for t in list_templates(library=True)],
        "user": [t.summary() for t in list_templates(library=False)],
    }


def _tool_extract_from_template(args: dict) -> dict:
    """Apply a saved template to a PDF/DOCX. Returns structured fields.

    Agent-callable entry point — mirrors /api/template-extract but skips
    the HTTP layer for local invocation.
    """
    from .doc_template import Template
    from .providers import create_provider

    template_name = args.get("template_name")
    pdf_path = args.get("pdf_path")
    library = bool(args.get("library", False))
    if not template_name or not pdf_path:
        return {"error": "template_name and pdf_path are required"}
    if not os.path.exists(pdf_path):
        return {"error": f"file not found: {pdf_path!r}"}

    tpl = Template.load(template_name, library=library)
    if tpl is None and not library:
        tpl = Template.load(template_name, library=True)
    if tpl is None:
        return {"error": f"template not found: {template_name!r}"}

    try:
        provider = create_provider("liteparse")
        st = provider.status()
        if not st.get("alive"):
            return {"error": f"liteparse unavailable: {st.get('info')}"}
        parsed = provider.parse(pdf_path, ocr=False)
        fields = tpl.apply(parsed)
        return {
            "template": tpl.name,
            "file": pdf_path,
            "fields": fields,
            "page_count": len(parsed.get("pages", [])),
            "elapsed_ms": parsed.get("elapsed_ms"),
        }
    except Exception as e:
        return {"error": f"extract failed: {e}"}


def _tool_play_flywheel_docs(args: dict) -> dict:
    """Play the document-layout Flywheel game via the Next.js Agent API.

    Mirror of _tool_play_flywheel but for doc challenges. Uses the SAME
    trust/reward infrastructure so text-only and vision agents both earn
    the same honeypot credits.
    """
    import urllib.request

    api_base = os.environ.get("DLF_WEB_URL", "http://localhost:3030")
    action = args.get("action", "challenge")
    agent_name = args.get("agent_name", "mcp-doc-agent")

    if action == "register":
        # Shared registration with image-mode — it's the same Agent pool.
        payload = json.dumps({
            "name": agent_name,
            "type": "llm",
            "custom_endpoint": args.get("custom_endpoint"),
        }).encode()
        req = urllib.request.Request(
            f"{api_base}/api/agent?action=register",
            data=payload,
            headers={"Content-Type": "application/json", "x-agent-id": agent_name},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    if action == "docs":
        req = urllib.request.Request(
            f"{api_base}/api/agent?action=doc-docs&agent_id={agent_name}",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    if action == "challenge":
        req = urllib.request.Request(
            f"{api_base}/api/agent?action=doc-challenge&agent_id={agent_name}",
            headers={"x-agent-id": agent_name},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
        return {
            **data,
            "instructions": (
                "You see a block of text from a document. The block_text field "
                "is the text content. The page_image_url field is the full "
                f"rendered page (vision agents can crop bbox={data.get('bbox')} "
                "from it for a region view). Decide whether this block is a "
                f"{data.get('question_field', 'header')}. Reply YES or NO by "
                "calling play_flywheel_docs with action='answer', challenge_id, "
                "and answer."
            ),
        }

    if action == "answer":
        challenge_id = args.get("challenge_id")
        answer = (args.get("answer") or "").upper()
        if not challenge_id or answer not in ("YES", "NO"):
            return {"error": "Provide challenge_id and answer (YES or NO)"}
        payload = json.dumps({"challenge_id": challenge_id, "answer": answer}).encode()
        req = urllib.request.Request(
            f"{api_base}/api/agent?action=doc-answer",
            data=payload,
            headers={"Content-Type": "application/json", "x-agent-id": agent_name},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    if action == "stats":
        # Reuse image-mode stats — it's a shared agent profile.
        req = urllib.request.Request(
            f"{api_base}/api/agent?action=stats&agent_id={agent_name}",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    return {"error": f"Unknown action: {action}. Use: challenge, answer, docs, stats, register"}


def _tool_play_flywheel(args: dict) -> dict:
    """Play the Flywheel labeling game via the Next.js Agent API."""
    import urllib.request

    api_base = os.environ.get("DLF_WEB_URL", "http://localhost:3030")
    action = args.get("action", "challenge")
    agent_name = args.get("agent_name", "mcp-agent")

    if action == "register":
        payload = json.dumps({
            "name": agent_name,
            "type": "llm",
            "custom_endpoint": args.get("custom_endpoint"),
        }).encode()
        req = urllib.request.Request(
            f"{api_base}/api/agent?action=register",
            data=payload,
            headers={"Content-Type": "application/json", "x-agent-id": agent_name},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    if action == "challenge":
        req = urllib.request.Request(
            f"{api_base}/api/agent?action=challenge&agent_id={agent_name}",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        return {
            **data,
            "instructions": (
                f"Look at the image at {data.get('image_url', '')} and answer: "
                f"{data.get('question', '')} Reply with YES or NO using the "
                f"play_flywheel tool with action='answer'."
            ),
        }

    if action == "answer":
        challenge_id = args.get("challenge_id")
        answer = args.get("answer", "").upper()
        if not challenge_id or answer not in ("YES", "NO"):
            return {"error": "Provide challenge_id and answer (YES or NO)"}
        payload = json.dumps({"challenge_id": challenge_id, "answer": answer}).encode()
        req = urllib.request.Request(
            f"{api_base}/api/agent?action=answer",
            data=payload,
            headers={"Content-Type": "application/json", "x-agent-id": agent_name},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    if action == "stats":
        req = urllib.request.Request(
            f"{api_base}/api/agent?action=stats&agent_id={agent_name}",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    return {"error": f"Unknown action: {action}. Use: challenge, answer, register, stats"}


def main():
    import asyncio
    try:
        from mcp.server.stdio import run_server
    except ImportError:
        # Fallback: print tools as JSON for testing
        print(json.dumps({
            "tools": [
                "label_dataset", "create_project", "check_status",
                "list_providers", "score_results", "benchmark",
                "generate_synthetic",
            ],
            "note": "MCP SDK not installed. Run: pip install mcp",
        }, indent=2))
        return

    server = _make_server()
    asyncio.run(run_server(server))


if __name__ == "__main__":
    main()
