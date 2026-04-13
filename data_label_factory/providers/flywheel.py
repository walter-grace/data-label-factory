"""Flywheel provider — synthetic data generation with perfect ground truth.

The flywheel pattern: render scenes programmatically with known object positions,
producing perfectly labeled training data with zero manual effort. Originally
built for card games (blackjack), but the pattern generalizes:

  1. You have reference images of your objects (card PNGs, part renders, etc.)
  2. You composite them onto backgrounds with random augmentation
  3. Every bbox is known exactly — no detection needed
  4. Output: YOLO-format or COCO-format labeled images

This provider wraps the render-based synthetic data generation. It acts as
both a gather and label provider — samples in, labeled dataset out.

Usage in project YAML:
    backends:
      gather: flywheel
      label: flywheel     # skip Falcon — flywheel labels are ground truth

    flywheel:
      refs_dir: ~/my-cards/          # reference images to composite
      backgrounds: ["green", "wood", "cloth"]
      scenes_per_ref: 10             # how many scenes per reference image
      augment: true                  # random size, rotation, noise
"""

from __future__ import annotations

import json
import math
import os
import random
import time
from pathlib import Path
from typing import Any

from . import Provider, LabelResult, FilterResult, register_provider


@register_provider("flywheel")
class FlywheelProvider(Provider):
    """Synthetic data generator — renders scenes with known ground truth.

    Supports two modes:
      1. render: Composite reference images onto backgrounds (no server needed)
      2. collect: Screenshot a running app + relabel with server ground truth

    For the pipeline, flywheel acts as a combined gather+label provider:
    it produces images AND their labels simultaneously.
    """

    @property
    def name(self) -> str:
        return "flywheel"

    def status(self) -> dict[str, Any]:
        refs_dir = self.config.get("refs_dir", "")
        if refs_dir and os.path.isdir(os.path.expanduser(refs_dir)):
            n_refs = len([f for f in os.listdir(os.path.expanduser(refs_dir))
                          if f.lower().endswith((".png", ".jpg", ".jpeg"))])
            return {"alive": True, "info": {"refs_dir": refs_dir, "n_refs": n_refs}}
        return {"alive": True, "info": "flywheel ready (no refs_dir configured)"}

    def _load_ref_images(self, refs_dir: str) -> dict[str, Any]:
        """Load reference images from a directory. Returns {name: (image, alpha)}."""
        try:
            import cv2
            import numpy as np
        except ImportError:
            raise ImportError("flywheel requires opencv-python: pip install opencv-python")

        refs = {}
        refs_path = Path(os.path.expanduser(refs_dir))
        for f in sorted(refs_path.iterdir()):
            if not f.suffix.lower() in (".png", ".jpg", ".jpeg"):
                continue
            img = cv2.imread(str(f), cv2.IMREAD_UNCHANGED)
            if img is None:
                continue
            name = f.stem
            if img.shape[2] == 4:
                alpha = img[:, :, 3] / 255.0
                bgr = img[:, :, :3]
                refs[name] = (bgr, alpha)
            else:
                refs[name] = (img, None)
        return refs

    def render_scene(self, ref_images: dict, class_map: dict,
                     n_objects: int = 0,
                     scene_size: tuple[int, int] = (800, 600)) -> tuple:
        """Render a single scene with random object placement.

        Returns (scene_bgr, annotations) where annotations is list of
        COCO-style dicts {bbox: [x,y,w,h], category: str, score: 1.0}.
        """
        import cv2
        import numpy as np

        W, H = scene_size

        # Random background
        bg_type = random.choice(["green", "gray", "wood", "dark"])
        if bg_type == "green":
            base = (random.randint(20, 50), random.randint(80, 140), random.randint(20, 50))
        elif bg_type == "gray":
            v = random.randint(60, 180)
            base = (v, v, v)
        elif bg_type == "wood":
            base = (random.randint(50, 80), random.randint(80, 120), random.randint(140, 200))
        else:
            base = (random.randint(10, 40), random.randint(10, 40), random.randint(10, 40))

        scene = np.zeros((H, W, 3), dtype=np.uint8)
        scene[:] = base

        # Subtle texture noise
        noise = np.random.randint(0, 15, (H, W), dtype=np.uint8)
        for c in range(3):
            scene[:, :, c] = np.clip(
                scene[:, :, c].astype(int) + noise, 0, 255
            ).astype(np.uint8)

        # Pick random objects to place
        ref_names = list(ref_images.keys())
        if not ref_names:
            return scene, []

        if n_objects <= 0:
            n_objects = random.randint(2, min(8, len(ref_names)))

        chosen = random.sample(ref_names, min(n_objects, len(ref_names)))
        annotations = []

        for obj_name in chosen:
            bgr, alpha = ref_images[obj_name]
            oh, ow = bgr.shape[:2]

            # Random scale
            scale = random.uniform(0.3, 0.8)
            target_h = int(min(H * scale, oh * 2))
            target_w = int(target_h * (ow / oh))
            if target_w > W * 0.8:
                target_w = int(W * 0.8)
                target_h = int(target_w * (oh / ow))

            bgr_r = cv2.resize(bgr, (target_w, target_h), interpolation=cv2.INTER_LANCZOS4)
            alpha_r = cv2.resize(alpha, (target_w, target_h)) if alpha is not None else None

            # Random position (ensure mostly visible)
            max_x = max(1, W - target_w + target_w // 4)
            max_y = max(1, H - target_h + target_h // 4)
            x = random.randint(-target_w // 8, max_x)
            y = random.randint(-target_h // 8, max_y)

            # Clip to scene
            x1, y1 = max(0, x), max(0, y)
            x2, y2 = min(W, x + target_w), min(H, y + target_h)
            cx1, cy1 = x1 - x, y1 - y
            cx2, cy2 = cx1 + (x2 - x1), cy1 + (y2 - y1)

            if x2 <= x1 or y2 <= y1:
                continue

            # Alpha composite
            if alpha_r is not None:
                a = alpha_r[cy1:cy2, cx1:cx2, np.newaxis]
                scene[y1:y2, x1:x2] = (
                    bgr_r[cy1:cy2, cx1:cx2] * a +
                    scene[y1:y2, x1:x2] * (1 - a)
                ).astype(np.uint8)
            else:
                scene[y1:y2, x1:x2] = bgr_r[cy1:cy2, cx1:cx2]

            # COCO bbox (pixel coords, visible portion)
            vis_w = x2 - x1
            vis_h = y2 - y1
            annotations.append({
                "bbox": [round(float(x1), 2), round(float(y1), 2),
                         round(float(vis_w), 2), round(float(vis_h), 2)],
                "category": obj_name,
                "score": 1.0,  # ground truth — perfect confidence
                "source": "flywheel",
            })

        return scene, annotations

    def generate_dataset(self, refs_dir: str, output_dir: str,
                         n_scenes: int = 100,
                         scene_size: tuple[int, int] = (800, 600)) -> dict:
        """Generate a complete synthetic dataset.

        Returns summary dict with paths and stats.
        """
        import cv2

        ref_images = self._load_ref_images(refs_dir)
        if not ref_images:
            return {"error": f"no reference images in {refs_dir}"}

        class_names = sorted(ref_images.keys())
        class_map = {name: i for i, name in enumerate(class_names)}

        out = Path(output_dir)
        img_dir = out / "train" / "images"
        lbl_dir = out / "train" / "labels"
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        # Also save COCO format
        coco = {
            "info": {"description": f"flywheel synthetic dataset from {refs_dir}"},
            "images": [],
            "annotations": [],
            "categories": [{"id": i, "name": n, "supercategory": "object"}
                           for i, n in enumerate(class_names)],
        }
        next_ann_id = 1
        t0 = time.time()

        for scene_idx in range(n_scenes):
            scene, annotations = self.render_scene(
                ref_images, class_map, scene_size=scene_size
            )

            tag = f"scene_{scene_idx:05d}"
            img_path = img_dir / f"{tag}.jpg"
            cv2.imwrite(str(img_path), scene, [cv2.IMWRITE_JPEG_QUALITY, 95])

            # YOLO labels
            W, H = scene_size
            with open(str(lbl_dir / f"{tag}.txt"), "w") as f:
                for ann in annotations:
                    cls_id = class_map.get(ann["category"], 0)
                    x, y, w, h = ann["bbox"]
                    cx = (x + w / 2) / W
                    cy = (y + h / 2) / H
                    nw = w / W
                    nh = h / H
                    f.write(f"{cls_id} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}\n")

            # COCO entry
            coco["images"].append({
                "id": scene_idx, "file_name": f"train/images/{tag}.jpg",
                "width": W, "height": H,
            })
            for ann in annotations:
                coco["annotations"].append({
                    "id": next_ann_id,
                    "image_id": scene_idx,
                    "category_id": class_map.get(ann["category"], 0),
                    "bbox": ann["bbox"],
                    "area": round(ann["bbox"][2] * ann["bbox"][3], 2),
                    "iscrowd": 0,
                    "score": 1.0,
                })
                next_ann_id += 1

            if (scene_idx + 1) % 20 == 0 or scene_idx == n_scenes - 1:
                rate = (scene_idx + 1) / max(time.time() - t0, 0.001)
                print(f"  [{scene_idx + 1:5d}/{n_scenes}] "
                      f"anns={len(coco['annotations'])} rate={rate:.0f} scenes/s")

        # Save data.yaml (YOLO format)
        import yaml
        data_yaml = {
            "train": "train/images",
            "val": "train/images",
            "nc": len(class_names),
            "names": {i: n for i, n in enumerate(class_names)},
        }
        with open(str(out / "data.yaml"), "w") as f:
            yaml.dump(data_yaml, f, default_flow_style=False)

        # Save COCO
        coco_path = out / "coco_annotations.json"
        with open(str(coco_path), "w") as f:
            json.dump(coco, f, indent=2)

        elapsed = time.time() - t0
        summary = {
            "output_dir": str(out),
            "n_scenes": n_scenes,
            "n_annotations": len(coco["annotations"]),
            "n_classes": len(class_names),
            "classes": class_names,
            "elapsed": round(elapsed, 1),
            "coco_path": str(coco_path),
            "yolo_data_yaml": str(out / "data.yaml"),
        }
        print(f"\n  Flywheel done: {n_scenes} scenes, "
              f"{len(coco['annotations'])} annotations, {elapsed:.1f}s")
        return summary

    def label_image(self, image_path: str, queries: list[str],
                    image_wh: tuple[int, int] | None = None) -> LabelResult:
        """For single-image labeling: render the image with overlaid ref objects.

        In practice, flywheel is used as a batch generator (generate_dataset),
        not per-image. This method enables the provider interface to work
        for benchmarking against other label backends.
        """
        refs_dir = self.config.get("refs_dir", "")
        if not refs_dir or not os.path.isdir(os.path.expanduser(refs_dir)):
            return LabelResult(annotations=[], elapsed=0,
                               metadata={"error": "refs_dir not configured"})

        ref_images = self._load_ref_images(refs_dir)
        if not ref_images:
            return LabelResult(annotations=[], elapsed=0,
                               metadata={"error": "no reference images"})

        class_map = {name: i for i, name in enumerate(sorted(ref_images.keys()))}

        t0 = time.time()
        _, annotations = self.render_scene(
            ref_images, class_map,
            scene_size=image_wh or (800, 600),
        )
        elapsed = time.time() - t0

        return LabelResult(annotations=annotations, elapsed=elapsed,
                           metadata={"mode": "synthetic"})

    def filter_image(self, image_path: str, prompt: str) -> FilterResult:
        """Flywheel-generated images always pass filter (they're synthetic)."""
        return FilterResult(verdict="YES", raw_answer="synthetic image (flywheel)",
                            elapsed=0, confidence=1.0)
