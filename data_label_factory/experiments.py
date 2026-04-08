"""
experiments.py — dated experiment folder convention.

Every pipeline run goes into experiments/<YYYY-MM-DD_HHMMSS>_<name>/
with a README + config.json so we can compare runs over time.

Layout:
    experiments/
    ├── 2026-04-07_193000_first-yt-batch/
    │   ├── README.md         ← what this run was, parameters, observations
    │   ├── config.json       ← exact CLI args
    │   ├── gather/           ← gather_v2 outputs (images go to drone-dataset-v2/)
    │   │   ├── manifest.json
    │   │   └── stats.json
    │   ├── filter_qwen/      ← run_qwen_filter outputs
    │   │   ├── keep_list.json
    │   │   └── stats.json
    │   ├── label_falcon/     ← pod_label outputs (from RunPod)
    │   │   ├── coco.json
    │   │   └── stats.json
    │   ├── verify_qwen/      ← verify_vlm outputs (from RunPod)
    │   │   ├── verified.json
    │   │   └── stats.json
    │   └── reviews/          ← human verdicts from the web UI
    │       └── reviews.json
    └── latest -> 2026-04-07_193000_first-yt-batch/   ← symlink to most recent

The drone-dataset-v2/ images themselves are SHARED across experiments —
each experiment writes labels/filters/verifications referencing those images,
not copies of them.
"""

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path


def make_experiment_dir(name: str = "", base: str = "experiments") -> str:
    """Create a fresh experiment dir with a timestamp + optional name suffix.
    Returns the absolute path."""
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    safe_name = name.strip().replace(" ", "-").replace("/", "_") if name else ""
    folder = f"{ts}_{safe_name}" if safe_name else ts
    full = os.path.abspath(os.path.join(base, folder))
    os.makedirs(full, exist_ok=True)

    # Create the standard subdirs
    for sub in ("gather", "filter_qwen", "label_falcon", "verify_qwen", "reviews"):
        os.makedirs(os.path.join(full, sub), exist_ok=True)

    return full


def write_readme(experiment_dir: str, name: str, description: str, params: dict):
    """Write a small markdown README capturing what this experiment is."""
    readme_path = os.path.join(experiment_dir, "README.md")
    lines = [
        f"# Experiment: {name or os.path.basename(experiment_dir)}",
        "",
        f"**Started:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"**Path:** `{experiment_dir}`",
        "",
        "## Description",
        "",
        description or "(no description)",
        "",
        "## Parameters",
        "",
        "```json",
        json.dumps(params, indent=2),
        "```",
        "",
        "## Pipeline stages",
        "",
        "1. **gather/** — image gathering manifest",
        "2. **filter_qwen/** — image-level Qwen YES/NO filter results",
        "3. **label_falcon/** — Falcon Perception bbox grounding (COCO format)",
        "4. **verify_qwen/** — per-bbox Qwen verification",
        "5. **reviews/** — human verdicts from the web UI",
        "",
    ]
    with open(readme_path, "w") as f:
        f.write("\n".join(lines))


def write_config(experiment_dir: str, config: dict):
    """Write the exact config used for this experiment."""
    with open(os.path.join(experiment_dir, "config.json"), "w") as f:
        json.dump(config, f, indent=2)


def update_latest_symlink(experiment_dir: str, base: str = "experiments"):
    """Update the experiments/latest symlink to point at this experiment."""
    base_abs = os.path.abspath(base)
    link = os.path.join(base_abs, "latest")
    target = os.path.basename(experiment_dir)  # relative symlink
    if os.path.islink(link):
        os.unlink(link)
    elif os.path.exists(link):
        # Don't clobber a real directory
        return
    try:
        os.symlink(target, link)
    except OSError:
        pass  # symlinks can fail on some filesystems


def list_experiments(base: str = "experiments") -> list:
    """List all experiment directories in chronological order (newest first)."""
    if not os.path.exists(base):
        return []
    out = []
    for entry in sorted(os.listdir(base), reverse=True):
        if entry == "latest":
            continue
        full = os.path.join(base, entry)
        if not os.path.isdir(full):
            continue
        readme = os.path.join(full, "README.md")
        config = os.path.join(full, "config.json")
        cfg = {}
        if os.path.exists(config):
            try:
                cfg = json.load(open(config))
            except Exception:
                pass
        out.append({
            "name": entry,
            "path": full,
            "config": cfg,
            "has_readme": os.path.exists(readme),
        })
    return out


if __name__ == "__main__":
    # CLI: list experiments or make one
    import argparse
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd")

    p_new = sub.add_parser("new", help="Create a new dated experiment folder")
    p_new.add_argument("--name", default="", help="Optional human-readable suffix")
    p_new.add_argument("--description", default="")

    p_list = sub.add_parser("list", help="List existing experiments")

    args = p.parse_args()
    if args.cmd == "new":
        path = make_experiment_dir(args.name)
        write_readme(path, args.name, args.description, {})
        update_latest_symlink(path)
        print(path)
    elif args.cmd == "list":
        for e in list_experiments():
            print(f"  {e['name']}")
    else:
        p.print_help()
