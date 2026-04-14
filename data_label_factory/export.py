"""
export.py — Convert COCO annotations to YOLO training format.

The final step before training: takes the pipeline's COCO JSON output
and produces a YOLO-ready dataset with data.yaml.

Usage:
    # Convert a pipeline experiment to YOLO format
    data_label_factory export --experiment experiments/latest/ --output yolo_dataset/

    # Or specify a COCO file directly
    data_label_factory export --coco path/to/stop-signs.coco.json --images ~/data-label-factory/stop-signs --output yolo_dataset/
"""

from __future__ import annotations

import json
import os
import shutil
import random
from pathlib import Path


def coco_to_yolo(
    coco_path: str,
    image_root: str,
    output_dir: str,
    val_split: float = 0.1,
    copy_images: bool = True,
) -> dict:
    """Convert COCO annotations to YOLO format.

    Args:
        coco_path: Path to COCO JSON file
        image_root: Root directory where images live (file_name in COCO is relative to this)
        output_dir: Output directory for YOLO dataset
        val_split: Fraction of images for validation (default 0.1)
        copy_images: Whether to copy images to output dir (default True)

    Returns:
        Summary dict with paths and stats
    """
    with open(coco_path) as f:
        coco = json.load(f)

    images = {img["id"]: img for img in coco.get("images", [])}
    annotations = coco.get("annotations", [])
    categories = coco.get("categories", [])

    # Build category mapping: COCO cat_id → YOLO class_id (0-indexed)
    cat_id_to_yolo = {}
    cat_names = {}
    for i, cat in enumerate(categories):
        cat_id_to_yolo[cat["id"]] = i
        cat_names[i] = cat["name"]

    # Group annotations by image
    anns_by_image = {}
    for ann in annotations:
        anns_by_image.setdefault(ann["image_id"], []).append(ann)

    # Create output dirs
    out = Path(output_dir)
    train_img = out / "images" / "train"
    train_lbl = out / "labels" / "train"
    val_img = out / "images" / "val"
    val_lbl = out / "labels" / "val"
    for d in [train_img, train_lbl, val_img, val_lbl]:
        d.mkdir(parents=True, exist_ok=True)

    # Split images
    img_ids = list(images.keys())
    random.shuffle(img_ids)
    n_val = max(1, int(len(img_ids) * val_split))
    val_ids = set(img_ids[:n_val])
    train_ids = set(img_ids[n_val:])

    stats = {"train": 0, "val": 0, "annotations": 0, "skipped": 0}

    for img_id, img_info in images.items():
        is_val = img_id in val_ids
        img_dir = val_img if is_val else train_img
        lbl_dir = val_lbl if is_val else train_lbl

        iw = img_info.get("width", 1)
        ih = img_info.get("height", 1)
        fname = img_info.get("file_name", "")
        src_path = os.path.join(image_root, fname)

        if not os.path.exists(src_path):
            stats["skipped"] += 1
            continue

        # Copy image
        ext = os.path.splitext(fname)[1] or ".jpg"
        safe_name = fname.replace("/", "_").replace("\\", "_")
        dst_img = img_dir / safe_name
        if copy_images:
            shutil.copy2(src_path, dst_img)

        # Write YOLO label file
        stem = os.path.splitext(safe_name)[0]
        label_lines = []
        for ann in anns_by_image.get(img_id, []):
            cls_id = cat_id_to_yolo.get(ann.get("category_id"), 0)
            x, y, w, h = ann["bbox"]  # COCO: [x, y, w, h] in pixels
            # Convert to YOLO: [cx, cy, w, h] normalized 0-1
            cx = (x + w / 2) / iw
            cy = (y + h / 2) / ih
            nw = w / iw
            nh = h / ih
            # Clamp to [0, 1]
            cx = max(0, min(1, cx))
            cy = max(0, min(1, cy))
            nw = max(0, min(1, nw))
            nh = max(0, min(1, nh))
            label_lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
            stats["annotations"] += 1

        with open(lbl_dir / f"{stem}.txt", "w") as f:
            f.write("\n".join(label_lines))

        if is_val:
            stats["val"] += 1
        else:
            stats["train"] += 1

    # Write data.yaml
    import yaml
    data_yaml = {
        "path": str(out.resolve()),
        "train": "images/train",
        "val": "images/val",
        "nc": len(cat_names),
        "names": cat_names,
    }
    yaml_path = out / "data.yaml"
    with open(yaml_path, "w") as f:
        yaml.dump(data_yaml, f, default_flow_style=False)

    summary = {
        "output_dir": str(out),
        "data_yaml": str(yaml_path),
        "train_images": stats["train"],
        "val_images": stats["val"],
        "total_annotations": stats["annotations"],
        "skipped": stats["skipped"],
        "classes": cat_names,
        "nc": len(cat_names),
    }

    print(f"  YOLO dataset: {out}")
    print(f"  Train: {stats['train']} images, Val: {stats['val']} images")
    print(f"  Annotations: {stats['annotations']}")
    print(f"  Classes ({len(cat_names)}): {list(cat_names.values())}")
    print(f"  data.yaml: {yaml_path}")

    # Print training command
    print(f"\n  Training command:")
    print(f"    yolo detect train \\")
    print(f"      model=yolo11n.pt \\")
    print(f"      data={yaml_path} \\")
    print(f"      epochs=50 imgsz=640 batch=16 \\")
    print(f"      project=runs name={out.name}")

    return summary


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(
        prog="data_label_factory export",
        description="Convert COCO annotations to YOLO training format.",
    )
    p.add_argument("--coco", help="Path to COCO JSON file")
    p.add_argument("--experiment", help="Experiment directory (auto-finds COCO file)")
    p.add_argument("--images", help="Image root directory")
    p.add_argument("--output", default="yolo_dataset", help="Output directory")
    p.add_argument("--val-split", type=float, default=0.1, help="Validation split (default 0.1)")
    p.add_argument("--no-copy", action="store_true", help="Don't copy images (symlink instead)")
    args = p.parse_args(argv)

    coco_path = args.coco
    image_root = args.images

    if not coco_path and args.experiment:
        # Find COCO file in experiment
        exp_dir = args.experiment
        if exp_dir == "latest":
            from .experiments import list_experiments
            exps = list_experiments()
            if exps:
                exp_dir = exps[0]["path"]
        for dirpath, _, filenames in os.walk(exp_dir):
            for fn in filenames:
                if fn.endswith(".coco.json"):
                    coco_path = os.path.join(dirpath, fn)
                    break
        if not coco_path:
            print(f"No COCO file found in {exp_dir}")
            return

    if not coco_path:
        p.error("--coco or --experiment required")

    if not image_root:
        # Try to guess from COCO info
        with open(coco_path) as f:
            coco = json.load(f)
        target = coco.get("info", {}).get("target_object", "")
        project = coco.get("info", {}).get("description", "").split("for ")[-1].split(" via")[0]
        image_root = os.path.expanduser(f"~/data-label-factory/{project}")
        if not os.path.exists(image_root):
            print(f"  Image root not found: {image_root}")
            print(f"  Specify with --images")
            return

    print(f"Converting COCO → YOLO")
    print(f"  COCO: {coco_path}")
    print(f"  Images: {image_root}")
    print(f"  Output: {args.output}")
    coco_to_yolo(coco_path, image_root, args.output,
                 val_split=args.val_split, copy_images=not args.no_copy)
