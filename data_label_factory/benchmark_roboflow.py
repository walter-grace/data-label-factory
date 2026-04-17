"""benchmark_roboflow — Head-to-head: LiteParse block detection vs Roboflow ground truth.

Dataset: Invoice-NER-detection (883 imgs @ 640x640, YOLO labels).
Classes: 0 = paragraph, 1 = table.

What we measure:
    - For every Roboflow GT box, does LiteParse return at least one block
      whose bbox overlaps it with IoU >= threshold? → recall.
    - For every LiteParse block, does a GT box match? → precision.
    - Per-class (paragraph vs table) and overall.

Usage:
    python3 -m data_label_factory.benchmark_roboflow \\
        --dataset /tmp/dlf-roboflow \\
        --limit 20 --iou 0.5 --ocr
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any


CLASS_NAMES = {0: "paragraph", 1: "table"}


def load_yolo_labels(label_path: Path, img_w: int, img_h: int) -> list[tuple[int, float, float, float, float]]:
    """Parse a YOLO txt file into [(cls, x1, y1, x2, y2)] pixel bboxes."""
    boxes = []
    if not label_path.exists():
        return boxes
    for line in label_path.read_text().splitlines():
        parts = line.strip().split()
        if len(parts) != 5:
            continue
        cls = int(parts[0])
        cx, cy, w, h = (float(p) for p in parts[1:])
        x1 = (cx - w / 2) * img_w
        y1 = (cy - h / 2) * img_h
        x2 = (cx + w / 2) * img_w
        y2 = (cy + h / 2) * img_h
        boxes.append((cls, x1, y1, x2, y2))
    return boxes


def bbox_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    a_area = (ax2 - ax1) * (ay2 - ay1)
    b_area = (bx2 - bx1) * (by2 - by1)
    union = a_area + b_area - inter
    return inter / union if union > 0 else 0.0


def _cluster_words_into_regions(lit_boxes: list[tuple], texts: list[str]) -> list[dict]:
    """Cluster word-boxes into candidate region bboxes + detected type.

    Uses the same clustering logic as doc_template.word_boxes_to_table_value —
    rows from y-proximity, then classifies as table vs paragraph based on
    column-alignment across rows.
    """
    from .doc_template import cluster_words_to_rows, cluster_rows_to_table

    blocks = [
        {"bbox": list(bb), "text": t}
        for bb, t in zip(lit_boxes, texts)
    ]
    rows = cluster_words_to_rows(blocks)
    if not rows:
        return []

    # Group rows that are close AND sharing column structure into clusters.
    # cluster_words_to_rows returns rows of items with pre-computed `cy`/`x1`/`x2`
    # and the original block at item["block"].
    row_centers = []
    for r in rows:
        if r:
            row_centers.append(sum(it["cy"] for it in r) / len(r))
    gaps = sorted(row_centers[i + 1] - row_centers[i] for i in range(len(row_centers) - 1))
    median_gap = gaps[len(gaps) // 2] if gaps else 0
    break_threshold = max(20.0, median_gap * 2.5)

    clusters: list[list[list[dict]]] = []
    current: list[list[dict]] = [rows[0]]
    for i in range(1, len(rows)):
        if row_centers[i] - row_centers[i - 1] > break_threshold:
            clusters.append(current)
            current = []
        current.append(rows[i])
    if current:
        clusters.append(current)

    out = []
    for cluster_rows in clusters:
        flat = [it for row in cluster_rows for it in row]
        if not flat:
            continue
        # Pull the original block bboxes (items carry them under item["block"])
        flat_blocks = [it["block"] for it in flat]
        xs1 = [b["bbox"][0] for b in flat_blocks]
        ys1 = [b["bbox"][1] for b in flat_blocks]
        xs2 = [b["bbox"][2] for b in flat_blocks]
        ys2 = [b["bbox"][3] for b in flat_blocks]
        region_bbox = (min(xs1), min(ys1), max(xs2), max(ys2))
        meta = cluster_rows_to_table(cluster_rows)
        out.append({
            "bbox": region_bbox,
            "type": meta["type"],
            "row_count": meta.get("row_count", len(cluster_rows)),
            "col_count": meta.get("col_count", 1),
            "word_count": len(flat),
        })
    return out


def run_benchmark(
    dataset_dir: Path,
    limit: int = 20,
    iou_thresh: float = 0.5,
    ocr: bool = True,
    verbose: bool = False,
) -> dict[str, Any]:
    """Parse each image, compare LiteParse output to YOLO ground truth."""
    from .providers import create_provider
    from PIL import Image

    images_dir = dataset_dir / "train" / "images"
    labels_dir = dataset_dir / "train" / "labels"
    if not images_dir.exists():
        raise SystemExit(f"not found: {images_dir}")

    # Ensure backend available
    provider = create_provider("liteparse", config={"ocr": ocr, "timeout_sec": 120})
    st = provider.status()
    if not st.get("alive"):
        raise SystemExit(f"liteparse unavailable: {st.get('info')}")

    all_images = sorted(images_dir.glob("*.jpg"))
    image_files = all_images if limit <= 0 else all_images[:limit]
    print(f"▶ Benchmarking {len(image_files)} images  (ocr={ocr}, iou>={iou_thresh})")

    # Per-class tallies — two complementary metrics:
    #   coverage: what % of the GT region is covered by lit word boxes inside
    #             it. Tells us lit's ability to *read* the region.
    #   region-IoU: after clustering lit words into regions, IoU with GT.
    #             Tells us lit's ability to *delineate* the region.
    gt_total: dict[int, int] = {0: 0, 1: 0}
    gt_detected: dict[int, int] = {0: 0, 1: 0}     # coverage >= iou_thresh
    gt_region_matched: dict[int, int] = {0: 0, 1: 0}   # region IoU >= iou_thresh
    coverage_per_class: dict[int, list[float]] = {0: [], 1: []}
    region_iou_per_class: dict[int, list[float]] = {0: [], 1: []}
    words_per_class: dict[int, list[int]] = {0: [], 1: []}
    lit_blocks_total = 0
    lit_blocks_inside_gt = 0
    clustered_region_counts = {"paragraph": 0, "table": 0}
    elapsed_per_doc: list[float] = []
    failures: list[str] = []

    for i, img_path in enumerate(image_files):
        label_path = labels_dir / (img_path.stem + ".txt")
        img = Image.open(img_path)
        iw, ih = img.size

        gt_boxes = load_yolo_labels(label_path, iw, ih)
        if not gt_boxes:
            if verbose:
                print(f"  [{i+1:3d}] {img_path.name}  ← no labels, skipping")
            continue

        for cls, _, _, _, _ in gt_boxes:
            gt_total[cls] = gt_total.get(cls, 0) + 1

        t0 = time.time()
        try:
            parsed = provider.parse(str(img_path), ocr=ocr)
        except Exception as e:
            failures.append(f"{img_path.name}: {e}")
            continue
        elapsed_per_doc.append(time.time() - t0)

        # Rescale lit's coords (PDF points, 72 DPI equivalent) back to image
        # pixels. lit internally treats a 640px JPG as a 307.2pt page — we
        # apply image_px / page_pts to undo that.
        lit_boxes: list[tuple[float, float, float, float]] = []
        lit_texts: list[str] = []
        for page in parsed.get("pages", []):
            pw = page.get("width") or 1
            ph = page.get("height") or 1
            sx = iw / pw if pw else 1.0
            sy = ih / ph if ph else 1.0
            for b in page.get("blocks", []):
                bbox = b.get("bbox") or []
                if len(bbox) == 4:
                    x1, y1, x2, y2 = bbox
                    lit_boxes.append((x1 * sx, y1 * sy, x2 * sx, y2 * sy))
                    lit_texts.append(b.get("text") or "")

        # Cluster lit's per-word boxes into candidate regions (B: table/paragraph)
        regions = _cluster_words_into_regions(lit_boxes, lit_texts)
        for r in regions:
            clustered_region_counts[r["type"]] = clustered_region_counts.get(r["type"], 0) + 1

        lit_blocks_total += len(lit_boxes)

        # For each GT region, compute coverage = (GT area ∩ ⋃ lit_boxes_centroid_inside_gt) / GT area.
        # Intuition: how much of the paragraph/table region did we actually read?
        for (cls, x1, y1, x2, y2) in gt_boxes:
            gt_area = max(0, x2 - x1) * max(0, y2 - y1)
            if gt_area <= 0:
                continue
            # Lit word boxes whose centroid falls inside this GT region
            inside = [
                lb for lb in lit_boxes
                if (lb[0] + lb[2]) / 2 >= x1 and (lb[0] + lb[2]) / 2 <= x2
                and (lb[1] + lb[3]) / 2 >= y1 and (lb[1] + lb[3]) / 2 <= y2
            ]
            words_per_class[cls].append(len(inside))
            # Clip each lit box to GT and sum — approximate union coverage
            # (some overlap among word boxes is negligible since lit emits per-word)
            covered_area = 0.0
            for lb in inside:
                cx1 = max(lb[0], x1); cy1 = max(lb[1], y1)
                cx2 = min(lb[2], x2); cy2 = min(lb[3], y2)
                if cx2 > cx1 and cy2 > cy1:
                    covered_area += (cx2 - cx1) * (cy2 - cy1)
            coverage = min(1.0, covered_area / gt_area)
            coverage_per_class[cls].append(coverage)
            if coverage >= iou_thresh:
                gt_detected[cls] = gt_detected.get(cls, 0) + 1

            # B: region-IoU metric — does any clustered region match this GT?
            best_region_iou = 0.0
            for r in regions:
                iou = bbox_iou((x1, y1, x2, y2), r["bbox"])
                if iou > best_region_iou:
                    best_region_iou = iou
            region_iou_per_class[cls].append(best_region_iou)
            if best_region_iou >= iou_thresh:
                gt_region_matched[cls] = gt_region_matched.get(cls, 0) + 1

        # For each lit block, is its centroid inside some GT region?
        for lb in lit_boxes:
            cx = (lb[0] + lb[2]) / 2
            cy = (lb[1] + lb[3]) / 2
            for (_, x1, y1, x2, y2) in gt_boxes:
                if x1 <= cx <= x2 and y1 <= cy <= y2:
                    lit_blocks_inside_gt += 1
                    break

        if verbose:
            matched_this_doc = 0
            for cls, x1, y1, x2, y2 in gt_boxes:
                best = max(
                    (bbox_iou((x1, y1, x2, y2), lb) for lb in lit_boxes),
                    default=0.0,
                )
                if best >= iou_thresh:
                    matched_this_doc += 1
            print(f"  [{i+1:3d}/{len(image_files)}] {img_path.name}  "
                  f"gt={len(gt_boxes)} lit={len(lit_boxes)} matched={matched_this_doc}")

    # ── Report ──
    total_gt = sum(gt_total.values())
    total_detected = sum(gt_detected.values())
    detection_rate = total_detected / total_gt if total_gt > 0 else 0.0
    word_precision = lit_blocks_inside_gt / lit_blocks_total if lit_blocks_total > 0 else 0.0
    avg_elapsed = sum(elapsed_per_doc) / len(elapsed_per_doc) if elapsed_per_doc else 0.0

    report: dict[str, Any] = {
        "dataset": str(dataset_dir),
        "images_processed": len(image_files),
        "ocr": ocr,
        "coverage_threshold": iou_thresh,
        "failures": len(failures),
        "failure_details": failures[:5],
        "per_class": {},
        "overall": {
            "gt_regions": total_gt,
            "gt_detected": total_detected,
            "detection_rate": round(detection_rate, 3),
            "lit_words": lit_blocks_total,
            "lit_words_in_gt": lit_blocks_inside_gt,
            "word_precision": round(word_precision, 3),
            "avg_parse_sec": round(avg_elapsed, 2),
        },
    }
    for cls, name in CLASS_NAMES.items():
        total = gt_total.get(cls, 0)
        detected = gt_detected.get(cls, 0)
        region_matched = gt_region_matched.get(cls, 0)
        covs = coverage_per_class.get(cls, [])
        region_ious = region_iou_per_class.get(cls, [])
        words = words_per_class.get(cls, [])
        report["per_class"][name] = {
            "gt_count": total,
            "detected_by_coverage": detected,
            "coverage_detection_rate": round(detected / total, 3) if total else 0.0,
            "region_matched": region_matched,
            "region_detection_rate": round(region_matched / total, 3) if total else 0.0,
            "avg_coverage": round(sum(covs) / len(covs), 3) if covs else 0.0,
            "avg_region_iou": round(sum(region_ious) / len(region_ious), 3) if region_ious else 0.0,
            "avg_words_per_region": round(sum(words) / len(words), 1) if words else 0.0,
        }

    report["clustered_regions"] = clustered_region_counts

    return report


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dataset", required=True, help="Roboflow dataset dir")
    p.add_argument("--limit", type=int, default=20, help="Image count (0 or negative = all)")
    p.add_argument("--iou", type=float, default=0.5, help="IoU threshold for a match")
    p.add_argument("--ocr", action="store_true", help="Enable OCR (required for JPG invoices)")
    p.add_argument("--verbose", "-v", action="store_true")
    p.add_argument("--output", help="Write JSON report to this path")
    args = p.parse_args()

    report = run_benchmark(
        dataset_dir=Path(args.dataset),
        limit=args.limit,
        iou_thresh=args.iou,
        ocr=args.ocr,
        verbose=args.verbose,
    )

    print()
    print("=" * 64)
    print("LiteParse vs Roboflow Invoice-NER — Detection Benchmark")
    print("=" * 64)
    print(f"Images processed:       {report['images_processed']}  (OCR={report['ocr']})")
    print(f"Coverage threshold:     {report['coverage_threshold']}  "
          f"(GT region 'detected' when ≥{int(report['coverage_threshold']*100)}% covered by lit words)")
    if report["failures"]:
        print(f"Failures:               {report['failures']} / {report['images_processed']}")
    print()
    print("Per-class detection")
    print(f"  {'class':10s}  {'gt':>4s}  {'cov':>6s}  {'region':>6s}  {'avgIoU':>7s}  {'avgCov':>7s}  words")
    for name, s in report["per_class"].items():
        print(f"  {name:10s}  "
              f"{s['gt_count']:4d}  "
              f"{s['coverage_detection_rate']:>6.1%}  "
              f"{s['region_detection_rate']:>6.1%}  "
              f"{s['avg_region_iou']:>7.3f}  "
              f"{s['avg_coverage']:>7.1%}  "
              f"{s['avg_words_per_region']}")
    print()
    regs = report.get("clustered_regions", {})
    print(f"Clustered regions (lit words → candidate regions):")
    print(f"  paragraphs={regs.get('paragraph', 0)}  tables={regs.get('table', 0)}")
    print()
    o = report["overall"]
    print(f"Overall coverage-detection: {o['detection_rate']:.1%}  "
          f"({o['gt_detected']} / {o['gt_regions']})")
    print(f"Lit word-box precision:     {o['word_precision']:.1%}  "
          f"({o['lit_words_in_gt']} / {o['lit_words']} inside a GT region)")
    print(f"Avg parse time:             {o['avg_parse_sec']}s / image")
    print("=" * 64)

    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2))
        print(f"\nReport → {args.output}")


if __name__ == "__main__":
    main()
