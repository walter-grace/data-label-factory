"""
metrics.py — deterministic verification metrics for bounding box quality.

Inspired by ParseBench's rule-based evaluation: no LLM-as-judge, all metrics
are reproducible and measurable. Use these to auto-verify COCO labels instead
of relying solely on VLM YES/NO classification.

Usage:
    from data_label_factory.metrics import (
        compute_iou, verify_bbox_rules, compare_label_sets, score_experiment
    )

    # Single bbox quality check
    report = verify_bbox_rules(bbox, image_wh=(1920, 1080))

    # Compare two labeling backends on the same images
    comparison = compare_label_sets(falcon_coco, wilddet3d_coco)

    # Score an entire experiment dir
    summary = score_experiment("experiments/2026-04-13_label-falcon/")
"""

from __future__ import annotations

import json
import math
import os
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any


# ============================================================
# Core IoU
# ============================================================

def compute_iou(box_a: list[float], box_b: list[float]) -> float:
    """IoU between two COCO-format boxes [x, y, w, h]."""
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b

    ax2, ay2 = ax + aw, ay + ah
    bx2, by2 = bx + bw, by + bh

    ix = max(0, min(ax2, bx2) - max(ax, bx))
    iy = max(0, min(ay2, by2) - max(ay, by))
    intersection = ix * iy

    union = aw * ah + bw * bh - intersection
    if union <= 0:
        return 0.0
    return intersection / union


def compute_ioa(box_inner: list[float], box_outer: list[float]) -> float:
    """Intersection over Area of box_inner (how much of inner is inside outer)."""
    ax, ay, aw, ah = box_inner
    bx, by, bw, bh = box_outer

    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    intersection = ix * iy

    area_inner = aw * ah
    if area_inner <= 0:
        return 0.0
    return intersection / area_inner


# ============================================================
# Per-bbox rule-based verification
# ============================================================

@dataclass
class RuleResult:
    name: str
    passed: bool
    detail: str = ""


@dataclass
class BboxVerification:
    """Result of running all rules on a single bbox."""
    bbox: list[float]
    rules: list[RuleResult] = field(default_factory=list)

    @property
    def pass_rate(self) -> float:
        if not self.rules:
            return 0.0
        return sum(1 for r in self.rules if r.passed) / len(self.rules)

    @property
    def passed(self) -> bool:
        return all(r.passed for r in self.rules)

    @property
    def failed_rules(self) -> list[str]:
        return [r.name for r in self.rules if not r.passed]


def verify_bbox_rules(bbox: list[float], image_wh: tuple[int, int],
                      category: str = "", score: float = 1.0,
                      config: dict | None = None) -> BboxVerification:
    """Run deterministic quality rules on a single COCO bbox [x, y, w, h].

    Rules:
      1. non_degenerate: w > 0 and h > 0
      2. within_image: bbox doesn't extend beyond image boundaries
      3. min_area: bbox area >= threshold (default 100 px^2)
      4. max_area_ratio: bbox area <= fraction of image (default 0.95)
      5. min_dimension: both w and h >= threshold (default 5 px)
      6. aspect_ratio: w/h within bounds (default 0.02 to 50)
      7. edge_margin: center not within N px of image edge (default 3)
      8. score_threshold: detection score >= threshold (default 0.1)
    """
    cfg = config or {}
    x, y, w, h = bbox
    iw, ih = image_wh
    area = w * h
    img_area = iw * ih
    cx, cy = x + w / 2, y + h / 2
    rules = []

    # 1. Non-degenerate
    rules.append(RuleResult(
        "non_degenerate", w > 0 and h > 0,
        f"w={w:.1f} h={h:.1f}"
    ))

    # 2. Within image bounds (allow small overflow)
    margin = cfg.get("bounds_margin", 5)
    in_bounds = (x >= -margin and y >= -margin and
                 x + w <= iw + margin and y + h <= ih + margin)
    rules.append(RuleResult(
        "within_image", in_bounds,
        f"bbox=[{x:.0f},{y:.0f},{x+w:.0f},{y+h:.0f}] img={iw}x{ih}"
    ))

    # 3. Minimum area
    min_area = cfg.get("min_area", 100)
    rules.append(RuleResult(
        "min_area", area >= min_area,
        f"area={area:.0f} min={min_area}"
    ))

    # 4. Maximum area ratio (reject full-image boxes)
    max_ratio = cfg.get("max_area_ratio", 0.95)
    ratio = area / max(img_area, 1)
    rules.append(RuleResult(
        "max_area_ratio", ratio <= max_ratio,
        f"ratio={ratio:.3f} max={max_ratio}"
    ))

    # 5. Minimum dimension
    min_dim = cfg.get("min_dimension", 5)
    rules.append(RuleResult(
        "min_dimension", w >= min_dim and h >= min_dim,
        f"w={w:.1f} h={h:.1f} min={min_dim}"
    ))

    # 6. Aspect ratio
    ar_min = cfg.get("aspect_ratio_min", 0.02)
    ar_max = cfg.get("aspect_ratio_max", 50.0)
    ar = w / max(h, 0.001)
    rules.append(RuleResult(
        "aspect_ratio", ar_min <= ar <= ar_max,
        f"ratio={ar:.2f} range=[{ar_min},{ar_max}]"
    ))

    # 7. Edge margin (center not too close to edge)
    edge_margin = cfg.get("edge_margin", 3)
    in_margin = (cx >= edge_margin and cy >= edge_margin and
                 cx <= iw - edge_margin and cy <= ih - edge_margin)
    rules.append(RuleResult(
        "edge_margin", in_margin,
        f"center=({cx:.0f},{cy:.0f}) margin={edge_margin}"
    ))

    # 8. Score threshold
    score_min = cfg.get("score_threshold", 0.1)
    rules.append(RuleResult(
        "score_threshold", score >= score_min,
        f"score={score:.3f} min={score_min}"
    ))

    return BboxVerification(bbox=bbox, rules=rules)


# ============================================================
# Cross-backend comparison
# ============================================================

@dataclass
class MatchResult:
    """A matched pair of annotations from two backends."""
    ann_a: dict
    ann_b: dict
    iou: float
    category_match: bool


@dataclass
class ComparisonReport:
    """Comparison of two label sets on the same images."""
    matched: list[MatchResult] = field(default_factory=list)
    unmatched_a: list[dict] = field(default_factory=list)  # in A but not B
    unmatched_b: list[dict] = field(default_factory=list)  # in B but not A
    per_category: dict[str, dict] = field(default_factory=dict)

    @property
    def precision(self) -> float:
        """How many of A's detections have a match in B."""
        total_a = len(self.matched) + len(self.unmatched_a)
        return len(self.matched) / max(total_a, 1)

    @property
    def recall(self) -> float:
        """How many of B's detections are matched by A."""
        total_b = len(self.matched) + len(self.unmatched_b)
        return len(self.matched) / max(total_b, 1)

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / max(p + r, 1e-9)

    @property
    def mean_iou(self) -> float:
        if not self.matched:
            return 0.0
        return sum(m.iou for m in self.matched) / len(self.matched)

    @property
    def category_agreement(self) -> float:
        if not self.matched:
            return 0.0
        return sum(1 for m in self.matched if m.category_match) / len(self.matched)


def match_annotations(anns_a: list[dict], anns_b: list[dict],
                      iou_threshold: float = 0.5) -> ComparisonReport:
    """Match annotations from two backends using greedy IoU matching.

    Both lists should be COCO-style dicts with 'bbox' and 'category' fields.
    """
    used_b = set()
    matched = []

    # Greedy matching: for each ann in A, find best IoU match in B
    for a in anns_a:
        best_iou = 0.0
        best_j = -1
        for j, b in enumerate(anns_b):
            if j in used_b:
                continue
            iou = compute_iou(a["bbox"], b["bbox"])
            if iou > best_iou:
                best_iou = iou
                best_j = j

        if best_iou >= iou_threshold and best_j >= 0:
            used_b.add(best_j)
            b = anns_b[best_j]
            cat_a = a.get("category", "").lower()
            cat_b = b.get("category", "").lower()
            matched.append(MatchResult(
                ann_a=a, ann_b=b, iou=best_iou,
                category_match=(cat_a == cat_b or cat_a in cat_b or cat_b in cat_a),
            ))

    unmatched_a = [a for i, a in enumerate(anns_a) if not any(
        m.ann_a is a for m in matched
    )]
    unmatched_b = [b for j, b in enumerate(anns_b) if j not in used_b]

    # Per-category stats
    per_cat: dict[str, dict] = defaultdict(lambda: {"matched": 0, "only_a": 0, "only_b": 0})
    for m in matched:
        cat = m.ann_a.get("category", "unknown")
        per_cat[cat]["matched"] += 1
    for a in unmatched_a:
        per_cat[a.get("category", "unknown")]["only_a"] += 1
    for b in unmatched_b:
        per_cat[b.get("category", "unknown")]["only_b"] += 1

    return ComparisonReport(
        matched=matched,
        unmatched_a=unmatched_a,
        unmatched_b=unmatched_b,
        per_category=dict(per_cat),
    )


# ============================================================
# Experiment-level scoring
# ============================================================

@dataclass
class ExperimentScore:
    """Aggregate quality metrics for an experiment's label output."""
    total_images: int = 0
    total_annotations: int = 0
    pass_rate: float = 0.0           # fraction of bboxes passing all rules
    mean_score: float = 0.0          # mean detection confidence
    mean_area_ratio: float = 0.0     # mean bbox area / image area
    rule_breakdown: dict[str, float] = field(default_factory=dict)  # per-rule pass rates
    per_category: dict[str, int] = field(default_factory=dict)


def score_coco(coco: dict, config: dict | None = None) -> ExperimentScore:
    """Score a COCO annotation dict using deterministic rules."""
    images = {img["id"]: img for img in coco.get("images", [])}
    annotations = coco.get("annotations", [])
    categories = {cat["id"]: cat["name"] for cat in coco.get("categories", [])}

    if not annotations:
        return ExperimentScore(total_images=len(images))

    rule_counts: dict[str, int] = defaultdict(int)
    rule_totals: dict[str, int] = defaultdict(int)
    cat_counts: dict[str, int] = defaultdict(int)
    total_pass = 0
    total_score = 0.0
    total_area_ratio = 0.0

    for ann in annotations:
        img = images.get(ann["image_id"], {})
        iw = img.get("width", 1)
        ih = img.get("height", 1)
        bbox = ann["bbox"]
        score = ann.get("score", 1.0)
        cat_name = categories.get(ann.get("category_id"), ann.get("category", "unknown"))

        vr = verify_bbox_rules(bbox, (iw, ih), category=cat_name, score=score, config=config)
        if vr.passed:
            total_pass += 1

        total_score += score
        total_area_ratio += (bbox[2] * bbox[3]) / max(iw * ih, 1)
        cat_counts[cat_name] += 1

        for rule in vr.rules:
            rule_totals[rule.name] += 1
            if rule.passed:
                rule_counts[rule.name] += 1

    n = len(annotations)
    rule_breakdown = {
        name: rule_counts[name] / max(rule_totals[name], 1)
        for name in rule_totals
    }

    return ExperimentScore(
        total_images=len(images),
        total_annotations=n,
        pass_rate=total_pass / max(n, 1),
        mean_score=total_score / max(n, 1),
        mean_area_ratio=total_area_ratio / max(n, 1),
        rule_breakdown=rule_breakdown,
        per_category=dict(cat_counts),
    )


def score_experiment(experiment_dir: str, config: dict | None = None) -> dict[str, ExperimentScore]:
    """Score all COCO files in an experiment directory.

    Returns a dict mapping label source name (e.g. 'label_falcon') to its score.
    """
    results = {}
    for entry in os.listdir(experiment_dir):
        full = os.path.join(experiment_dir, entry)
        if not os.path.isdir(full):
            continue
        for fname in os.listdir(full):
            if fname.endswith(".coco.json"):
                coco_path = os.path.join(full, fname)
                with open(coco_path) as f:
                    coco = json.load(f)
                results[entry] = score_coco(coco, config)
    return results
