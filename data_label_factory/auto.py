"""
auto.py — Smart project creation from samples + description.

The core v2 experience: a user says "label these as X", gives a few sample
images, and the factory figures out the best project config and backends.

Usage:
    # CLI
    data_label_factory auto \
        --samples ~/my-samples/ \
        --description "fire hydrants in urban settings" \
        --output projects/fire-hydrants.yaml

    # Python
    from data_label_factory.auto import auto_project
    project = auto_project(
        samples=["img1.jpg", "img2.jpg"],
        description="fiber optic drones with cable spools",
    )

How it works:
    1. Analyze sample images via available VLMs to understand the domain
    2. Pick the best backends per stage based on content type
    3. Generate search queries for the gather stage
    4. Create a complete project YAML ready to run
"""

from __future__ import annotations

import json
import os
import time
import yaml
from datetime import datetime
from pathlib import Path
from typing import Any


# ── Content type detection ──────────────────────────────────────

CONTENT_PROFILES = {
    "document": {
        "keywords": ["text", "document", "form", "receipt", "invoice", "table",
                     "pdf", "paper", "letter", "report", "handwriting", "ocr"],
        "filter_backend": "chandra",
        "label_backend": "chandra",
        "verify_backend": "qwen",
        "gather_queries_hint": "scanned {target}, {target} photograph, {target} closeup",
    },
    "object": {
        "keywords": ["car", "dog", "cat", "drone", "bird", "person", "sign",
                     "hydrant", "bottle", "phone", "building", "animal",
                     "vehicle", "tool", "equipment", "furniture"],
        "filter_backend": "qwen",
        "label_backend": "falcon",
        "verify_backend": "qwen",
        "gather_queries_hint": "{target} photo, {target} outdoor, {target} closeup",
    },
    "card": {
        "keywords": ["card", "playing card", "trading card", "poker", "blackjack",
                     "yu-gi-oh", "yugioh", "pokemon", "magic the gathering", "deck"],
        "filter_backend": "qwen",
        "label_backend": "falcon",
        "verify_backend": "qwen",
        "gather_queries_hint": "{target} card photo, {target} cards spread",
        "synthetic": True,
    },
    "3d_scene": {
        "keywords": ["3d", "depth", "scene", "room", "outdoor", "street",
                     "driving", "autonomous", "lidar", "stereo"],
        "filter_backend": "qwen",
        "label_backend": "wilddet3d",
        "verify_backend": "qwen",
        "gather_queries_hint": "{target} photo, {target} outdoor scene",
    },
    "generic": {
        "keywords": [],
        "filter_backend": "qwen",
        "label_backend": "falcon",
        "verify_backend": "qwen",
        "gather_queries_hint": "{target} photo, {target} closeup, {target} example",
    },
}


def detect_content_type(description: str, sample_analysis: str = "") -> str:
    """Classify the labeling task into a content profile."""
    text = (description + " " + sample_analysis).lower()
    best_type = "generic"
    best_score = 0

    for ctype, profile in CONTENT_PROFILES.items():
        if ctype == "generic":
            continue
        score = sum(1 for kw in profile["keywords"] if kw in text)
        if score > best_score:
            best_score = score
            best_type = ctype

    return best_type


def analyze_samples_with_vlm(sample_paths: list[str], description: str) -> dict:
    """Use available VLM to analyze sample images and extract domain info."""
    from .providers import create_provider

    # Try qwen first (fastest), then gemma
    for backend in ("qwen", "gemma"):
        try:
            provider = create_provider(backend)
            if not provider.status().get("alive"):
                continue
        except Exception:
            continue

        prompt = (
            f"I want to build a dataset of images showing: {description}\n"
            f"Look at this sample image. In 2-3 sentences, describe:\n"
            f"1. What objects/elements are visible\n"
            f"2. What search queries would find similar images\n"
            f"3. What negative examples (things to exclude) would help\n"
            f"Be specific and concise."
        )

        analyses = []
        for path in sample_paths[:5]:  # analyze up to 5 samples
            try:
                result = provider.filter_image(path, prompt)
                analyses.append(result.raw_answer)
            except Exception:
                continue

        if analyses:
            return {
                "backend_used": backend,
                "analyses": analyses,
                "combined": " ".join(analyses),
            }

    return {"backend_used": "none", "analyses": [], "combined": ""}


def generate_queries(description: str, target_object: str,
                     content_type: str, vlm_analysis: str = "") -> dict:
    """Generate bucket queries for the gather stage."""
    profile = CONTENT_PROFILES.get(content_type, CONTENT_PROFILES["generic"])
    hint = profile["gather_queries_hint"].format(target=target_object)

    # Base positive queries from description
    words = [w.strip() for w in description.split() if len(w.strip()) > 2]
    positive_queries = [
        description,
        target_object,
        f"{target_object} photo",
        f"{target_object} closeup",
        f"{target_object} high quality",
    ]
    # Add hint-based queries
    for q in hint.split(", "):
        if q not in positive_queries:
            positive_queries.append(q)

    # Extract additional queries from VLM analysis
    if vlm_analysis:
        # Simple extraction: look for quoted phrases or comma-separated suggestions
        for line in vlm_analysis.split("\n"):
            if "search" in line.lower() or "query" in line.lower():
                parts = line.split('"')
                for i in range(1, len(parts), 2):
                    if len(parts[i]) > 3:
                        positive_queries.append(parts[i])

    # Negative / background queries
    negative_queries = [
        f"not {target_object}",
        "empty background",
        "plain surface",
    ]

    buckets = {
        f"positive/clear_view": {"queries": positive_queries[:8]},
        f"negative/other_objects": {"queries": negative_queries[:4]},
        f"background/empty": {"queries": ["blue sky clouds", "empty room", "plain wall"]},
    }

    return buckets


def generate_falcon_queries(target_object: str, description: str) -> list[str]:
    """Generate Falcon Perception queries for the label stage."""
    queries = [target_object]
    # Add component parts if description mentions them
    words = description.lower().split()
    for w in words:
        if w not in target_object.lower() and len(w) > 3 and w not in (
            "with", "that", "this", "from", "into", "have", "been",
            "show", "shows", "showing", "image", "images", "photo",
        ):
            queries.append(w)
    return queries[:5]  # cap at 5 queries


def auto_project(
    samples: list[str] | str,
    description: str,
    project_name: str = "",
    output: str = "",
    analyze: bool = True,
) -> dict:
    """Create a complete project config from samples + description.

    Args:
        samples: Path to directory of sample images, or list of image paths
        description: What the user wants to label (e.g. "fire hydrants")
        project_name: Optional name (auto-generated from description if empty)
        output: Optional path to write YAML (returns dict if empty)
        analyze: Whether to use VLM to analyze samples (slower but better)

    Returns:
        Complete project config dict (also written to output if specified)
    """
    # Resolve sample paths
    if isinstance(samples, str):
        samples_dir = os.path.expanduser(samples)
        if os.path.isdir(samples_dir):
            sample_paths = [
                os.path.join(samples_dir, f) for f in os.listdir(samples_dir)
                if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
            ]
        else:
            sample_paths = [samples_dir]
    else:
        sample_paths = [os.path.expanduser(s) for s in samples]

    # Derive target object from description
    target_object = description.strip().rstrip(".")
    if not project_name:
        project_name = target_object.lower().replace(" ", "-")[:30]

    print(f"[auto] Creating project: {project_name}")
    print(f"[auto] Target: {target_object}")
    print(f"[auto] Samples: {len(sample_paths)} images")

    # Analyze samples with VLM if available
    vlm_analysis = ""
    if analyze and sample_paths:
        print(f"[auto] Analyzing samples with VLM...")
        analysis = analyze_samples_with_vlm(sample_paths, description)
        vlm_analysis = analysis.get("combined", "")
        if vlm_analysis:
            print(f"[auto] Analysis ({analysis['backend_used']}): {vlm_analysis[:200]}...")

    # Detect content type
    content_type = detect_content_type(description, vlm_analysis)
    profile = CONTENT_PROFILES[content_type]
    print(f"[auto] Content type: {content_type}")
    print(f"[auto] Backends: filter={profile['filter_backend']}, "
          f"label={profile['label_backend']}, verify={profile['verify_backend']}")

    # Generate queries
    buckets = generate_queries(description, target_object, content_type, vlm_analysis)
    falcon_queries = generate_falcon_queries(target_object, description)

    # Build project config
    config = {
        "project_name": project_name,
        "target_object": target_object,
        "description": (
            f"Auto-generated project for labeling {target_object}. "
            f"Content type: {content_type}. "
            f"Created {datetime.now().strftime('%Y-%m-%d %H:%M')}."
        ),
        "data_root": f"~/data-label-factory/{project_name}",
        "buckets": buckets,
        "falcon_queries": falcon_queries,
        "backends": {
            "filter": profile["filter_backend"],
            "label": profile["label_backend"],
            "verify": profile["verify_backend"],
        },
    }

    # Add synthetic config if applicable
    if profile.get("synthetic"):
        config["synthetic"] = {
            "enabled": True,
            "type": "flywheel",
            "note": "This domain supports synthetic data generation via flywheel",
        }

    # Copy samples to data_root
    data_root = os.path.expanduser(config["data_root"])
    samples_dest = os.path.join(data_root, "samples")
    os.makedirs(samples_dest, exist_ok=True)
    import shutil
    for sp in sample_paths:
        if os.path.exists(sp):
            shutil.copy2(sp, samples_dest)
    print(f"[auto] Copied {len(sample_paths)} samples to {samples_dest}")

    # Write YAML if output specified
    if output:
        output = os.path.expanduser(output)
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        with open(output, "w") as f:
            yaml.dump(config, f, default_flow_style=False, sort_keys=False)
        print(f"[auto] Saved project: {output}")

    print(f"[auto] Ready! Run: data_label_factory pipeline --project {output or '<path>'}")
    return config


def main(argv: list[str] | None = None):
    import argparse
    p = argparse.ArgumentParser(
        prog="data_label_factory auto",
        description=(
            "Create a labeling project automatically from sample images + description. "
            "The factory analyzes your samples, picks the best backends, generates "
            "search queries, and creates a ready-to-run project YAML."
        ),
    )
    p.add_argument("--samples", required=True,
                   help="Directory of sample images or a single image path")
    p.add_argument("--description", required=True,
                   help='What to label (e.g. "fire hydrants in urban settings")')
    p.add_argument("--name", default="",
                   help="Project name (auto-generated from description if empty)")
    p.add_argument("--output", default="",
                   help="Output YAML path (default: projects/<name>.yaml)")
    p.add_argument("--no-analyze", action="store_true",
                   help="Skip VLM analysis of samples (faster, less accurate)")

    args = p.parse_args(argv)

    output = args.output
    if not output:
        name = args.name or args.description.lower().replace(" ", "-")[:30]
        output = f"projects/{name}.yaml"

    auto_project(
        samples=args.samples,
        description=args.description,
        project_name=args.name,
        output=output,
        analyze=not args.no_analyze,
    )
