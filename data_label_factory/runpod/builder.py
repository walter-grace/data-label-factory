"""
Build a Hugging Face Datasets-compatible Parquet from an experiment dir.

Same schema as the reference dataset at huggingface.co/datasets/waltgrace/fiber-optic-drones,
so users can publish their own runs and have them load with the identical
`load_dataset()` call.
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Optional


def build_parquet_from_experiment(
    coco_path: Path,
    verified_path: Optional[Path],
    out_path: Path,
) -> Path:
    """Take a COCO JSON (and optional verified.json) and write a Parquet file
    in the canonical data-label-factory schema.

    Schema (struct of lists for bboxes — required for HF Datasets Sequence):
        image_id:    int
        file_name:   str
        bucket:      str
        width:       int
        height:      int
        n_bboxes:    int
        n_approved:  int
        bboxes: {
            annotation_id: list[int]
            category:      list[str]
            x1, y1, x2, y2, area: list[float]
            vlm_verdict:   list[str]
            vlm_reasoning: list[str]
        }

    Note: this builder DOES NOT bundle image bytes (the labels-only schema).
    To produce the full image+bytes variant, use the standalone builder script
    in the auto-research workspace — it needs a working R2 client.
    """
    try:
        from datasets import Dataset, Features, Sequence, Value
    except ImportError:
        raise SystemExit(
            "the `datasets` package is not installed. install it with:\n"
            "    pip install datasets pyarrow"
        )

    coco = json.loads(Path(coco_path).read_text())
    ver = json.loads(Path(verified_path).read_text()) if verified_path else {"annotations": []}

    cat_id_to_name = {c["id"]: c["name"] for c in coco["categories"]}
    ver_by_id = {v["annotation_id"]: v for v in ver["annotations"]}
    img_by_id = {im["id"]: im for im in coco["images"]}

    EMPTY = lambda: {
        "annotation_id": [],
        "category": [],
        "x1": [], "y1": [], "x2": [], "y2": [],
        "area": [],
        "vlm_verdict": [],
        "vlm_reasoning": [],
    }
    bboxes_by_image = defaultdict(EMPTY)
    for ann in coco["annotations"]:
        v = ver_by_id.get(ann["id"], {})
        x, y, w, h = ann["bbox"]
        col = bboxes_by_image[ann["image_id"]]
        col["annotation_id"].append(int(ann["id"]))
        col["category"].append(cat_id_to_name.get(ann["category_id"], "unknown"))
        col["x1"].append(float(x))
        col["y1"].append(float(y))
        col["x2"].append(float(x + w))
        col["y2"].append(float(y + h))
        col["area"].append(float(ann.get("area", w * h)))
        col["vlm_verdict"].append(v.get("verdict", "UNCHECKED"))
        col["vlm_reasoning"].append(v.get("reasoning", ""))

    rows = []
    for img_id, im in sorted(img_by_id.items()):
        bb = bboxes_by_image.get(img_id, EMPTY())
        n = len(bb["annotation_id"])
        n_approved = sum(1 for v in bb["vlm_verdict"] if v == "YES")
        parts = im["file_name"].split("/")
        bucket = "/".join(parts[:2]) if len(parts) >= 3 else parts[0]
        rows.append({
            "image_id":   img_id,
            "file_name":  im["file_name"],
            "bucket":     bucket,
            "width":      im["width"],
            "height":     im["height"],
            "n_bboxes":   n,
            "n_approved": n_approved,
            "bboxes":     bb,
        })

    bbox_features = Sequence({
        "annotation_id": Value("int64"),
        "category":      Value("string"),
        "x1":            Value("float32"),
        "y1":            Value("float32"),
        "x2":            Value("float32"),
        "y2":            Value("float32"),
        "area":          Value("float32"),
        "vlm_verdict":   Value("string"),
        "vlm_reasoning": Value("string"),
    })
    features = Features({
        "image_id":   Value("int64"),
        "file_name":  Value("string"),
        "bucket":     Value("string"),
        "width":      Value("int32"),
        "height":     Value("int32"),
        "n_bboxes":   Value("int32"),
        "n_approved": Value("int32"),
        "bboxes":     bbox_features,
    })

    ds = Dataset.from_list(rows, features=features)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    ds.to_parquet(str(out_path))
    return out_path
