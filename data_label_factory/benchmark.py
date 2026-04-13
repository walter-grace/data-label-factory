"""
benchmark.py — v1 vs v2 comparison for data_label_factory.

Run the same images through multiple labeling backends, compute deterministic
metrics on each, and generate a comparison report.

Usage:
    # Compare two existing experiment COCO files
    data_label_factory benchmark \
        --a experiments/2026-04-13_falcon/label_falcon/drones.coco.json \
        --b experiments/2026-04-13_wilddet3d/label_wilddet3d/drones.coco.json

    # Run a fresh benchmark: label the same images with multiple backends
    data_label_factory benchmark \
        --project projects/drones.yaml \
        --backends falcon,wilddet3d \
        --limit 50

    # Score a single experiment
    data_label_factory benchmark --score experiments/latest/

    # MODEL BENCHMARK — compare VLMs for filter/verify accuracy
    # Run the same filter prompt through multiple OpenRouter models + local Qwen
    data_label_factory benchmark --models \
        --project projects/drones.yaml \
        --model-list "google/gemma-4-26b-a4b-it,meta-llama/llama-4-scout,qwen" \
        --limit 30
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from .metrics import (
    score_coco, score_experiment, match_annotations,
    ComparisonReport, ExperimentScore, verify_bbox_rules,
)


def _print_score(name: str, score: ExperimentScore):
    """Pretty-print an experiment score."""
    print(f"\n  {name}")
    print(f"    images:      {score.total_images}")
    print(f"    annotations: {score.total_annotations}")
    print(f"    pass rate:   {score.pass_rate:.1%}")
    print(f"    mean score:  {score.mean_score:.3f}")
    print(f"    mean area%:  {score.mean_area_ratio:.3f}")
    if score.rule_breakdown:
        print(f"    rules:")
        for rule, rate in sorted(score.rule_breakdown.items()):
            flag = "ok" if rate >= 0.95 else "WARN" if rate >= 0.80 else "FAIL"
            print(f"      {rule:20s} {rate:6.1%}  {flag}")
    if score.per_category:
        print(f"    categories:")
        for cat, cnt in sorted(score.per_category.items(), key=lambda x: -x[1]):
            print(f"      {cat:30s} {cnt:5d}")


def _print_comparison(name_a: str, name_b: str, report: ComparisonReport):
    """Pretty-print a comparison report."""
    print(f"\n  {name_a} vs {name_b}")
    print(f"    matched pairs:   {len(report.matched)}")
    print(f"    only in {name_a}:  {len(report.unmatched_a)}")
    print(f"    only in {name_b}:  {len(report.unmatched_b)}")
    print(f"    precision:       {report.precision:.3f}")
    print(f"    recall:          {report.recall:.3f}")
    print(f"    F1:              {report.f1:.3f}")
    print(f"    mean IoU:        {report.mean_iou:.3f}")
    print(f"    category agree:  {report.category_agreement:.1%}")
    if report.per_category:
        print(f"    per-category:")
        for cat, stats in sorted(report.per_category.items()):
            print(f"      {cat:30s} matched={stats['matched']} "
                  f"only_a={stats['only_a']} only_b={stats['only_b']}")


def cmd_benchmark_compare(args):
    """Compare two COCO files."""
    with open(args.a) as f:
        coco_a = json.load(f)
    with open(args.b) as f:
        coco_b = json.load(f)

    name_a = os.path.basename(os.path.dirname(args.a))
    name_b = os.path.basename(os.path.dirname(args.b))

    print("=" * 70)
    print(f"BENCHMARK: {name_a} vs {name_b}")
    print("=" * 70)

    # Score each independently
    score_a = score_coco(coco_a)
    score_b = score_coco(coco_b)
    _print_score(f"[A] {name_a}", score_a)
    _print_score(f"[B] {name_b}", score_b)

    # Cross-compare on shared images
    imgs_a = {img["file_name"]: img for img in coco_a.get("images", [])}
    imgs_b = {img["file_name"]: img for img in coco_b.get("images", [])}
    shared = set(imgs_a) & set(imgs_b)

    if shared:
        cats_a = {c["id"]: c["name"] for c in coco_a.get("categories", [])}
        cats_b = {c["id"]: c["name"] for c in coco_b.get("categories", [])}

        anns_a_by_img = defaultdict(list)
        for ann in coco_a.get("annotations", []):
            img = imgs_a.get({v["id"]: v for v in coco_a["images"]}.get(ann["image_id"], {}).get("file_name", ""), {})
            # Simpler: build id->filename map
        id_to_fname_a = {img["id"]: img["file_name"] for img in coco_a.get("images", [])}
        id_to_fname_b = {img["id"]: img["file_name"] for img in coco_b.get("images", [])}

        anns_a_by_img = defaultdict(list)
        for ann in coco_a.get("annotations", []):
            fname = id_to_fname_a.get(ann["image_id"], "")
            if fname in shared:
                a = dict(ann)
                a["category"] = cats_a.get(ann.get("category_id"), ann.get("category", ""))
                anns_a_by_img[fname].append(a)

        anns_b_by_img = defaultdict(list)
        for ann in coco_b.get("annotations", []):
            fname = id_to_fname_b.get(ann["image_id"], "")
            if fname in shared:
                b = dict(ann)
                b["category"] = cats_b.get(ann.get("category_id"), ann.get("category", ""))
                anns_b_by_img[fname].append(b)

        # Aggregate comparison across all shared images
        all_matched = []
        all_unmatched_a = []
        all_unmatched_b = []
        for fname in shared:
            report = match_annotations(anns_a_by_img[fname], anns_b_by_img[fname])
            all_matched.extend(report.matched)
            all_unmatched_a.extend(report.unmatched_a)
            all_unmatched_b.extend(report.unmatched_b)

        per_cat = defaultdict(lambda: {"matched": 0, "only_a": 0, "only_b": 0})
        for m in all_matched:
            per_cat[m.ann_a.get("category", "?")]["matched"] += 1
        for a in all_unmatched_a:
            per_cat[a.get("category", "?")]["only_a"] += 1
        for b in all_unmatched_b:
            per_cat[b.get("category", "?")]["only_b"] += 1

        from .metrics import ComparisonReport as CR
        overall = CR(
            matched=all_matched,
            unmatched_a=all_unmatched_a,
            unmatched_b=all_unmatched_b,
            per_category=dict(per_cat),
        )
        print(f"\n  Shared images: {len(shared)}")
        _print_comparison(name_a, name_b, overall)
    else:
        print("\n  No shared images between the two COCO files.")

    # Save report
    report_path = args.output or "benchmark_report.json"
    report = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "file_a": args.a,
        "file_b": args.b,
        "score_a": {
            "total_images": score_a.total_images,
            "total_annotations": score_a.total_annotations,
            "pass_rate": round(score_a.pass_rate, 4),
            "mean_score": round(score_a.mean_score, 4),
            "rule_breakdown": {k: round(v, 4) for k, v in score_a.rule_breakdown.items()},
            "per_category": score_a.per_category,
        },
        "score_b": {
            "total_images": score_b.total_images,
            "total_annotations": score_b.total_annotations,
            "pass_rate": round(score_b.pass_rate, 4),
            "mean_score": round(score_b.mean_score, 4),
            "rule_breakdown": {k: round(v, 4) for k, v in score_b.rule_breakdown.items()},
            "per_category": score_b.per_category,
        },
    }
    if shared:
        report["comparison"] = {
            "shared_images": len(shared),
            "matched": len(overall.matched),
            "only_a": len(overall.unmatched_a),
            "only_b": len(overall.unmatched_b),
            "precision": round(overall.precision, 4),
            "recall": round(overall.recall, 4),
            "f1": round(overall.f1, 4),
            "mean_iou": round(overall.mean_iou, 4),
            "category_agreement": round(overall.category_agreement, 4),
            "per_category": overall.per_category,
        }
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\n  Report saved: {report_path}")


def cmd_benchmark_score(args):
    """Score a single experiment directory."""
    exp_dir = args.score
    if not os.path.isdir(exp_dir):
        print(f"Not a directory: {exp_dir}")
        sys.exit(1)

    print("=" * 70)
    print(f"SCORING: {exp_dir}")
    print("=" * 70)

    scores = score_experiment(exp_dir)
    if not scores:
        print("  No COCO files found.")
        return

    for name, score in scores.items():
        _print_score(name, score)


def cmd_benchmark_run(args):
    """Run a fresh benchmark: label same images with multiple backends."""
    from .project import load_project
    from .providers import create_provider
    from .experiments import make_experiment_dir, write_config, update_latest_symlink

    proj = load_project(args.project)
    backends = [b.strip() for b in args.backends.split(",")]

    img_root = proj.local_image_dir()
    if not os.path.exists(img_root):
        print(f"No images at {img_root}; run gather first.")
        sys.exit(1)

    # Collect images
    images = []
    for root, _, names in os.walk(img_root):
        for n in names:
            if n.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                full = os.path.join(root, n)
                rel = os.path.relpath(full, img_root)
                if "/" not in rel:
                    continue
                images.append((rel, full))
    if args.limit > 0:
        images = images[:args.limit]

    print("=" * 70)
    print(f"BENCHMARK RUN: {proj.project_name}")
    print(f"  images:   {len(images)}")
    print(f"  backends: {backends}")
    print(f"  queries:  {proj.falcon_queries}")
    print("=" * 70)

    exp = make_experiment_dir(f"benchmark-{proj.project_name}")
    write_config(exp, {
        "type": "benchmark",
        "project": proj.project_name,
        "backends": backends,
        "n_images": len(images),
        "queries": proj.falcon_queries,
    })
    update_latest_symlink(exp)

    coco_files = {}

    for backend_name in backends:
        print(f"\n>>> Backend: {backend_name}")
        try:
            provider = create_provider(backend_name)
        except Exception as e:
            print(f"  SKIP: {e}")
            continue

        status = provider.status()
        if not status.get("alive"):
            print(f"  SKIP: {backend_name} not alive — {status.get('info', '')}")
            continue

        # Build COCO
        from PIL import Image as PILImage
        coco = {
            "info": {
                "description": f"benchmark {proj.project_name} via {backend_name}",
                "date_created": datetime.now().isoformat(timespec="seconds"),
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

        for i, (rel, full) in enumerate(images, 1):
            try:
                im = PILImage.open(full)
                iw, ih = im.size
            except Exception:
                continue

            img_id = next_img_id
            next_img_id += 1
            coco["images"].append({
                "id": img_id, "file_name": rel, "width": iw, "height": ih
            })

            result = provider.label_image(full, proj.falcon_queries, image_wh=(iw, ih))
            for ann in result.annotations:
                cat_name = ann.get("category", proj.falcon_queries[0])
                cid = cat_id.get(cat_name)
                if cid is None:
                    # Add dynamic category
                    cid = len(coco["categories"]) + 1
                    coco["categories"].append({"id": cid, "name": cat_name, "supercategory": "object"})
                    cat_id[cat_name] = cid

                coco["annotations"].append({
                    "id": next_ann_id,
                    "image_id": img_id,
                    "category_id": cid,
                    "bbox": ann["bbox"],
                    "area": round(ann["bbox"][2] * ann["bbox"][3], 2),
                    "iscrowd": 0,
                    "score": ann.get("score", 1.0),
                })
                next_ann_id += 1

            if i % 10 == 0 or i == len(images):
                elapsed = time.time() - t0
                rate = i / max(elapsed, 1)
                eta = (len(images) - i) / max(rate, 0.001) / 60
                n_ann = len(coco["annotations"])
                print(f"  [{i:4d}/{len(images)}] anns={n_ann}  ETA {eta:.1f} min")

        # Save COCO
        out_dir = os.path.join(exp, f"label_{backend_name}")
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, f"{proj.project_name}.coco.json")
        with open(out_path, "w") as f:
            json.dump(coco, f, indent=2)
        coco_files[backend_name] = out_path
        print(f"  Saved: {out_path} ({len(coco['annotations'])} annotations)")

    # Score and compare
    if len(coco_files) >= 1:
        print("\n" + "=" * 70)
        print("RESULTS")
        print("=" * 70)

        scores = {}
        for name, path in coco_files.items():
            with open(path) as f:
                coco = json.load(f)
            scores[name] = score_coco(coco)
            _print_score(name, scores[name])

    if len(coco_files) >= 2:
        names = list(coco_files.keys())
        print(f"\n  Cross-comparison:")
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                args_cmp = argparse.Namespace(
                    a=coco_files[names[i]],
                    b=coco_files[names[j]],
                    output=os.path.join(exp, f"compare_{names[i]}_vs_{names[j]}.json"),
                )
                cmd_benchmark_compare(args_cmp)

    print(f"\n  Benchmark experiment: {exp}")


def cmd_benchmark_models(args):
    """MODEL BENCHMARK — compare VLMs for filter/verify accuracy.

    Runs the same filter prompt through multiple models (local Qwen, OpenRouter
    models, etc.) on the same images and compares YES/NO agreement rates.

    This answers: "which VLM is best at filtering images for my dataset?"
    """
    from .project import load_project
    from .providers import create_provider
    from .experiments import make_experiment_dir, write_config, update_latest_symlink

    proj = load_project(args.project)
    model_list = [m.strip() for m in args.model_list.split(",")]

    img_root = proj.local_image_dir()
    if not os.path.exists(img_root):
        print(f"No images at {img_root}; run gather first.")
        sys.exit(1)

    images = []
    for root, _, names in os.walk(img_root):
        for n in names:
            if n.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                full = os.path.join(root, n)
                rel = os.path.relpath(full, img_root)
                if "/" not in rel:
                    continue
                images.append((rel, full))
    if args.limit > 0:
        images = images[:args.limit]

    prompt = proj.prompt("filter")

    print("=" * 70)
    print(f"MODEL BENCHMARK: {proj.project_name}")
    print(f"  images:  {len(images)}")
    print(f"  models:  {model_list}")
    print(f"  prompt:  {prompt[:80]}...")
    print("=" * 70)

    exp = make_experiment_dir(f"model-bench-{proj.project_name}")
    write_config(exp, {
        "type": "model_benchmark",
        "project": proj.project_name,
        "models": model_list,
        "n_images": len(images),
        "prompt": prompt,
    })
    update_latest_symlink(exp)

    # For each model, run filter on all images
    all_results: dict[str, list[dict]] = {}

    for model_spec in model_list:
        # Determine provider: "qwen", "gemma" are local; anything with "/" is OpenRouter
        if model_spec in ("qwen", "gemma"):
            provider_name = model_spec
            model_id = model_spec
            try:
                provider = create_provider(provider_name)
            except Exception as e:
                print(f"\n  SKIP {model_spec}: {e}")
                continue
        else:
            provider_name = "openrouter"
            model_id = model_spec
            try:
                provider = create_provider("openrouter", config={"model": model_id})
            except Exception as e:
                print(f"\n  SKIP {model_spec}: {e}")
                continue

        status = provider.status()
        if not status.get("alive"):
            print(f"\n  SKIP {model_spec}: not alive — {status.get('info', '')}")
            continue

        print(f"\n>>> {model_id}")
        results = []
        counts = {"YES": 0, "NO": 0, "UNKNOWN": 0, "ERROR": 0}
        t0 = time.time()

        for i, (rel, full) in enumerate(images, 1):
            try:
                fr = provider.filter_image(full, prompt)
                verdict = fr.verdict
                raw = fr.raw_answer
                elapsed_img = fr.elapsed
            except Exception as e:
                verdict, raw, elapsed_img = "ERROR", str(e)[:80], 0

            counts[verdict] = counts.get(verdict, 0) + 1
            results.append({
                "image": rel,
                "verdict": verdict,
                "raw_answer": raw[:120],
                "elapsed": round(elapsed_img, 3),
            })

            if i % 10 == 0 or i == len(images):
                elapsed_total = time.time() - t0
                rate = i / max(elapsed_total, 1)
                eta = (len(images) - i) / max(rate, 0.001) / 60
                print(f"  [{i:4d}/{len(images)}] YES={counts['YES']} NO={counts['NO']} "
                      f"ERR={counts.get('ERROR',0)}  {rate:.1f} img/s  ETA {eta:.1f}m")

        elapsed_total = time.time() - t0
        all_results[model_id] = results

        # Save per-model results
        out_dir = os.path.join(exp, f"filter_{model_id.replace('/', '_')}")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "keep_list.json"), "w") as f:
            json.dump({
                "model": model_id,
                "provider": provider_name,
                "project": proj.project_name,
                "counts": counts,
                "elapsed_total": round(elapsed_total, 1),
                "results": results,
            }, f, indent=2)

    # ── Comparison Report ──
    if len(all_results) < 2:
        print("\n  Need at least 2 models to compare.")
        print(f"  Experiment: {exp}")
        return

    print("\n" + "=" * 70)
    print("MODEL COMPARISON")
    print("=" * 70)

    # Build verdict matrix: image → {model: verdict}
    image_names = [r["image"] for r in list(all_results.values())[0]]
    models = list(all_results.keys())

    # Per-model stats
    print(f"\n  {'Model':40s} {'YES':>5s} {'NO':>5s} {'UNK':>5s} {'ERR':>5s} {'YES%':>6s} {'avg_s':>6s}")
    print("  " + "-" * 72)
    model_stats = {}
    for model_id in models:
        results = all_results[model_id]
        yes = sum(1 for r in results if r["verdict"] == "YES")
        no = sum(1 for r in results if r["verdict"] == "NO")
        unk = sum(1 for r in results if r["verdict"] == "UNKNOWN")
        err = sum(1 for r in results if r["verdict"] == "ERROR")
        avg_s = sum(r["elapsed"] for r in results) / max(len(results), 1)
        yes_pct = yes / max(len(results), 1)
        model_stats[model_id] = {"yes": yes, "no": no, "unk": unk, "err": err,
                                  "yes_pct": yes_pct, "avg_s": avg_s}
        short = model_id[-38:] if len(model_id) > 38 else model_id
        print(f"  {short:40s} {yes:5d} {no:5d} {unk:5d} {err:5d} {yes_pct:5.0%} {avg_s:6.2f}")

    # Pairwise agreement
    print(f"\n  Pairwise agreement:")
    for i, m1 in enumerate(models):
        for j, m2 in enumerate(models):
            if j <= i:
                continue
            r1 = all_results[m1]
            r2 = all_results[m2]
            agree = sum(1 for a, b in zip(r1, r2) if a["verdict"] == b["verdict"])
            total = min(len(r1), len(r2))
            pct = agree / max(total, 1)
            s1 = m1[-20:] if len(m1) > 20 else m1
            s2 = m2[-20:] if len(m2) > 20 else m2
            print(f"    {s1} vs {s2}: {agree}/{total} ({pct:.0%})")

    # Disagreement examples (show where models disagree most)
    print(f"\n  Top disagreements:")
    n_shown = 0
    for idx in range(len(image_names)):
        verdicts = {m: all_results[m][idx]["verdict"] for m in models}
        unique = set(verdicts.values()) - {"ERROR", "UNKNOWN"}
        if len(unique) > 1 and n_shown < 10:
            img = image_names[idx]
            verdict_str = "  ".join(f"{m[-15:]}={v}" for m, v in verdicts.items())
            print(f"    {img[:50]:50s} {verdict_str}")
            n_shown += 1

    # Save comparison report
    report = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "project": proj.project_name,
        "n_images": len(images),
        "prompt": prompt,
        "models": model_stats,
    }
    report_path = os.path.join(exp, "model_comparison.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n  Report: {report_path}")
    print(f"  Experiment: {exp}")


def main(argv: list[str] | None = None):
    p = argparse.ArgumentParser(
        prog="data_label_factory benchmark",
        description="Compare labeling backends with deterministic metrics.",
    )
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--compare", nargs=2, metavar=("COCO_A", "COCO_B"),
                       help="Compare two existing COCO files")
    group.add_argument("--score", metavar="EXP_DIR",
                       help="Score a single experiment directory")
    group.add_argument("--run", action="store_true",
                       help="Run a fresh benchmark with multiple backends")
    group.add_argument("--models", action="store_true",
                       help="Model benchmark: compare VLMs for filter/verify accuracy")

    p.add_argument("--project", help="Project YAML (for --run / --models)")
    p.add_argument("--backends", default="falcon",
                   help="Comma-separated backends to benchmark (for --run)")
    p.add_argument("--model-list",
                   default="qwen,google/gemma-4-26b-a4b-it",
                   help="Comma-separated model IDs for --models. "
                        "Use 'qwen'/'gemma' for local, or OpenRouter model IDs "
                        "(e.g. google/gemma-4-26b-a4b-it, meta-llama/llama-4-scout)")
    p.add_argument("--limit", type=int, default=0, help="Max images")
    p.add_argument("--output", help="Output report path (for --compare)")

    args = p.parse_args(argv)

    if args.compare:
        args.a, args.b = args.compare
        cmd_benchmark_compare(args)
    elif args.score:
        cmd_benchmark_score(args)
    elif args.run:
        if not args.project:
            p.error("--project is required with --run")
        cmd_benchmark_run(args)
    elif args.models:
        if not args.project:
            p.error("--project is required with --models")
        cmd_benchmark_models(args)
