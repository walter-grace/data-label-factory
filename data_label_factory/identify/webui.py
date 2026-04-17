"""WebUI element detection: YOLO-based open-vocabulary UI labeling + DOM mapping.

Lets an LLM agent screenshot a website, get back labeled UI regions (buttons,
headers, navs, inputs, etc.), and optionally map those regions to actual DOM
elements so the agent can edit the correct component in source code.

Two-step pipeline:

    1. detect_ui_elements(image, yolo, classes)
       → runs YOLOv8-World with web-UI class vocabulary
       → returns labeled bboxes with confidence scores

    2. map_to_dom(ui_elements, dom_bounds, iou_threshold)
       → IoU matches YOLO bboxes against pre-collected DOM element bounds
       → prefers semantically matching tags ("button" → <button> over <div>)
       → returns bboxes annotated with CSS selectors, tag names, IDs, etc.

No CLIP needed — YOLO's open-vocabulary label is the identity for UI elements.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any

from PIL import Image

# ── Default UI element classes ──────────────────────────────────────────────
# YOLOv8-World works best with concrete, visually-grounded noun phrases.
# Ordered by visual distinctiveness (tier 1 first, then tier 2).

DEFAULT_WEB_UI_CLASSES: list[str] = [
    # Tier 1 — visually distinct, high-confidence
    "button",
    "navigation bar",
    "search bar",
    "text input field",
    "dropdown menu",
    "logo",
    "hero image",
    "card",
    "modal dialog",
    "footer",
    "sidebar",
    # Tier 2 — useful but may overlap / need dedup
    "heading",
    "paragraph",
    "icon",
    "checkbox",
    "radio button",
    "toggle switch",
    "tab bar",
    "breadcrumb",
    "avatar",
    "badge",
    "table",
    "form",
]

# Map YOLO class labels → semantically matching HTML tags. Used to break
# IoU ties when a YOLO bbox overlaps multiple DOM elements equally.
_TAG_AFFINITY: dict[str, set[str]] = {
    "button":           {"button", "a", "input"},
    "navigation bar":   {"nav", "header"},
    "search bar":       {"form", "input", "search"},
    "text input field": {"input", "textarea"},
    "dropdown menu":    {"select", "ul", "details"},
    "logo":             {"img", "svg", "a"},
    "hero image":       {"img", "picture", "figure"},
    "card":             {"article", "section", "div"},
    "modal dialog":     {"dialog", "div"},
    "footer":           {"footer"},
    "sidebar":          {"aside", "nav"},
    "heading":          {"h1", "h2", "h3", "h4", "h5", "h6"},
    "paragraph":        {"p", "span", "div"},
    "icon":             {"svg", "img", "i", "span"},
    "checkbox":         {"input"},
    "radio button":     {"input"},
    "toggle switch":    {"input", "button"},
    "tab bar":          {"nav", "ul", "div"},
    "breadcrumb":       {"nav", "ol", "ul"},
    "avatar":           {"img", "div"},
    "badge":            {"span", "div"},
    "table":            {"table"},
    "form":             {"form"},
}


# ── Data types ──────────────────────────────────────────────────────────────

@dataclass
class UIElement:
    """A detected UI element (YOLO output, no DOM info yet)."""
    bbox_norm: dict[str, float]   # {x1, y1, x2, y2} normalized [0,1]
    bbox_px: dict[str, float]     # {x1, y1, x2, y2} in pixel coords
    label: str                    # YOLO class name
    confidence: float             # YOLO confidence score

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class MappedElement:
    """A UIElement matched to a DOM element."""
    bbox_norm: dict[str, float]
    bbox_px: dict[str, float]
    label: str
    confidence: float
    iou_score: float
    # DOM info (from the agent's pre-collected bounds)
    selector: str
    tag: str
    element_id: str | None
    element_classes: list[str]
    data_testid: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ── IoU helper ──────────────────────────────────────────────────────────────

def iou(a: dict[str, float], b: dict[str, float]) -> float:
    """Axis-aligned intersection-over-union between two {x1,y1,x2,y2} boxes."""
    ix1 = max(a["x1"], b["x1"])
    iy1 = max(a["y1"], b["y1"])
    ix2 = min(a["x2"], b["x2"])
    iy2 = min(a["y2"], b["y2"])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter == 0.0:
        return 0.0
    area_a = (a["x2"] - a["x1"]) * (a["y2"] - a["y1"])
    area_b = (b["x2"] - b["x1"]) * (b["y2"] - b["y1"])
    return inter / (area_a + area_b - inter)


# ── Core detection ──────────────────────────────────────────────────────────

def detect_ui_elements(
    image: "Image.Image",
    yolo_model: Any,
    classes: list[str] | None = None,
    conf: float = 0.15,
    *,
    omniparser_model: Any = None,
) -> list[UIElement]:
    """Detect UI elements on a screenshot.

    Two modes:
        1. **OmniParser mode** (recommended): if `omniparser_model` is
           provided, uses Microsoft's OmniParser UI-fine-tuned YOLO which
           detects all interactable regions in one pass. The `classes`
           parameter is ignored (OmniParser is single-class).
        2. **Open-vocab mode**: if `omniparser_model` is None, falls back to
           YOLOv8-World with the provided class vocabulary.

    Args:
        image:            PIL image (e.g. a website screenshot)
        yolo_model:       A loaded ultralytics.YOLO instance (yolov8s-world.pt)
        classes:          For open-vocab mode only — override class vocabulary.
        conf:             YOLO confidence threshold.
        omniparser_model: Optional loaded OmniParser YOLO (.pt). When present,
                          used instead of yolo_model for detection.

    Returns:
        List of UIElement with normalized + pixel bounding boxes and labels.
    """
    W, H = image.size
    elements: list[UIElement] = []

    if omniparser_model is not None:
        # ── OmniParser path: single-class, UI-fine-tuned ──
        results = omniparser_model.predict(image, conf=conf, iou=0.5, verbose=False)
        if not results:
            return elements
        boxes = getattr(results[0], "boxes", None)
        if boxes is None or boxes.xyxy is None:
            return elements
        names = omniparser_model.names or {0: "ui_element"}
        for idx, (x1, y1, x2, y2) in enumerate(boxes.xyxy.cpu().numpy().tolist()):
            cls_idx = int(boxes.cls[idx].item())
            label = names.get(cls_idx, "ui_element")
            score = float(boxes.conf[idx].item())
            elements.append(UIElement(
                bbox_norm={"x1": x1 / W, "y1": y1 / H, "x2": x2 / W, "y2": y2 / H},
                bbox_px={"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                label=label,
                confidence=score,
            ))
    else:
        # ── Open-vocab fallback: YOLOv8-World ──
        if yolo_model is None:
            return elements
        cls_list = classes or DEFAULT_WEB_UI_CLASSES
        yolo_model.set_classes(cls_list)
        results = yolo_model.predict(image, conf=conf, iou=0.5, verbose=False)
        if not results:
            return elements
        boxes = getattr(results[0], "boxes", None)
        if boxes is None or boxes.xyxy is None:
            return elements
        for idx, (x1, y1, x2, y2) in enumerate(boxes.xyxy.cpu().numpy().tolist()):
            cls_idx = int(boxes.cls[idx].item())
            label = cls_list[cls_idx] if cls_idx < len(cls_list) else f"class_{cls_idx}"
            score = float(boxes.conf[idx].item())
            elements.append(UIElement(
                bbox_norm={"x1": x1 / W, "y1": y1 / H, "x2": x2 / W, "y2": y2 / H},
                bbox_px={"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                label=label,
                confidence=score,
            ))

    # Sort by area descending (larger = more structurally important)
    elements.sort(
        key=lambda e: (e.bbox_px["x2"] - e.bbox_px["x1"]) * (e.bbox_px["y2"] - e.bbox_px["y1"]),
        reverse=True,
    )
    return elements


# ── DOM mapping ─────────────────────────────────────────────────────────────

def map_to_dom(
    ui_elements: list[UIElement],
    dom_bounds: list[dict[str, Any]],
    iou_threshold: float = 0.3,
    dpr: float = 1.0,
) -> list[MappedElement]:
    """Match YOLO-detected UI elements to DOM elements by IoU.

    Args:
        ui_elements: Output from detect_ui_elements().
        dom_bounds:  Pre-collected DOM element bounds from the agent. Each
                     entry should have at minimum:
                         {selector, tag, x1, y1, x2, y2}
                     Optional fields: id, classes (list), data_testid
        iou_threshold: Minimum IoU to accept a match.
        dpr:         Device pixel ratio of the screenshot. If the screenshot
                     was captured at 2x Retina, pass dpr=2.0 so DOM bounds
                     (which are in CSS pixels) get scaled to match the
                     screenshot's pixel coordinates.

    Returns:
        List of MappedElement — one per UIElement that found a DOM match.
        Elements with no match above the threshold are omitted.
    """
    # Scale DOM bounds from CSS pixels to screenshot pixels
    scaled_dom: list[dict[str, Any]] = []
    for d in dom_bounds:
        scaled_dom.append({
            **d,
            "x1": d["x1"] * dpr, "y1": d["y1"] * dpr,
            "x2": d["x2"] * dpr, "y2": d["y2"] * dpr,
        })

    mapped: list[MappedElement] = []

    for el in ui_elements:
        best_iou = 0.0
        best_dom: dict[str, Any] | None = None

        for dom_el in scaled_dom:
            dom_box = {
                "x1": dom_el["x1"], "y1": dom_el["y1"],
                "x2": dom_el["x2"], "y2": dom_el["y2"],
            }
            score = iou(el.bbox_px, dom_box)
            if score < iou_threshold:
                continue

            # Break ties: prefer semantically matching tags
            affinity = _TAG_AFFINITY.get(el.label, set())
            tag = dom_el.get("tag", "").lower()

            if score > best_iou:
                best_iou = score
                best_dom = dom_el
            elif abs(score - best_iou) < 0.05 and best_dom is not None:
                # Close IoU — check tag affinity as tiebreaker
                best_tag = best_dom.get("tag", "").lower()
                if tag in affinity and best_tag not in affinity:
                    best_iou = score
                    best_dom = dom_el

        if best_dom is not None:
            mapped.append(MappedElement(
                bbox_norm=el.bbox_norm,
                bbox_px=el.bbox_px,
                label=el.label,
                confidence=el.confidence,
                iou_score=best_iou,
                selector=best_dom.get("selector", ""),
                tag=best_dom.get("tag", ""),
                element_id=best_dom.get("id"),
                element_classes=best_dom.get("classes", []),
                data_testid=best_dom.get("data_testid"),
            ))

    return mapped


# ── Screenshot diffing ──────────────────────────────────────────────────────

@dataclass
class DiffResult:
    """Result of comparing two sets of detections."""
    added: list[dict[str, Any]]      # elements in `after` not in `before`
    removed: list[dict[str, Any]]    # elements in `before` not in `after`
    moved: list[dict[str, Any]]      # same element, different position
    unchanged: list[dict[str, Any]]  # same element, same-ish position
    before_count: int
    after_count: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def diff_detections(
    before: list[UIElement],
    after: list[UIElement],
    iou_match_threshold: float = 0.3,
    move_threshold: float = 0.8,
) -> DiffResult:
    """Compare two sets of UI element detections (before/after an edit).

    Matches elements across the two sets by IoU. Elements in `after` that
    don't match anything in `before` are "added". Elements in `before` that
    don't match anything in `after` are "removed". Matched pairs with IoU
    below `move_threshold` are "moved".
    """
    used_before: set[int] = set()
    matched_pairs: list[tuple[int, int, float]] = []

    for j, aft in enumerate(after):
        best_iou = 0.0
        best_i = -1
        for i, bef in enumerate(before):
            if i in used_before:
                continue
            score = iou(bef.bbox_px, aft.bbox_px)
            if score > best_iou:
                best_iou = score
                best_i = i
        if best_i >= 0 and best_iou >= iou_match_threshold:
            matched_pairs.append((best_i, j, best_iou))
            used_before.add(best_i)

    matched_after: set[int] = {j for _, j, _ in matched_pairs}

    added = [after[j].to_dict() for j in range(len(after)) if j not in matched_after]
    removed = [before[i].to_dict() for i in range(len(before)) if i not in used_before]
    moved = []
    unchanged = []
    for i, j, score in matched_pairs:
        entry = {
            "before": before[i].to_dict(),
            "after": after[j].to_dict(),
            "iou": round(score, 3),
        }
        if score < move_threshold:
            moved.append(entry)
        else:
            unchanged.append(entry)

    return DiffResult(
        added=added,
        removed=removed,
        moved=moved,
        unchanged=unchanged,
        before_count=len(before),
        after_count=len(after),
    )


# ── JS collection snippets ─────────────────────────────────────────────────
# These are JavaScript snippets agents should run in the browser (via Chrome
# MCP / Playwright / CDP) to collect the data our tools need.

JS_COLLECT_ALL_ELEMENTS = """
// Collects ALL visible DOM elements with bounding rects.
// Run in browser via: page.evaluate(snippet)
(() => {
    const all = document.querySelectorAll('*');
    return Array.from(all).map((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        if (r.bottom < 0 || r.right < 0) return null;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        return {
            selector: el.id ? '#' + el.id
                : el.tagName.toLowerCase()
                    + (el.className && typeof el.className === 'string'
                        ? '.' + el.className.trim().split(/\\s+/)[0] : '')
                    + ':nth(' + i + ')',
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: Array.from(el.classList),
            data_testid: el.getAttribute('data-testid') || null,
            x1: r.left, y1: r.top, x2: r.right, y2: r.bottom,
            text: el.textContent ? el.textContent.trim().slice(0, 80) : null,
        };
    }).filter(x => x !== null);
})()
""".strip()

JS_COLLECT_COMPUTED_STYLES = """
// Collects computed styles for all visible interactive elements.
// Returns: [{selector, tag, styles: {fontSize, color, bg, padding, margin, ...}}]
(() => {
    const selectors = 'a, button, input, select, textarea, [role=button], h1, h2, h3, h4, h5, h6, nav, header, footer, main, section, form, img';
    const els = document.querySelectorAll(selectors);
    return Array.from(els).slice(0, 200).map((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        const cs = window.getComputedStyle(el);
        return {
            selector: el.id ? '#' + el.id
                : el.tagName.toLowerCase()
                    + (el.className && typeof el.className === 'string'
                        ? '.' + el.className.trim().split(/\\s+/)[0] : '')
                    + ':nth(' + i + ')',
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            x1: r.left, y1: r.top, x2: r.right, y2: r.bottom,
            styles: {
                fontSize: cs.fontSize,
                fontWeight: cs.fontWeight,
                fontFamily: cs.fontFamily,
                color: cs.color,
                backgroundColor: cs.backgroundColor,
                padding: cs.padding,
                margin: cs.margin,
                border: cs.border,
                borderRadius: cs.borderRadius,
                display: cs.display,
                position: cs.position,
                width: cs.width,
                height: cs.height,
                opacity: cs.opacity,
                zIndex: cs.zIndex,
            },
        };
    }).filter(x => x !== null);
})()
""".strip()

JS_COLLECT_ACCESSIBILITY_TREE = """
// Collects the accessibility tree for all elements with accessible roles.
// Returns: [{role, name, description, selector, bbox, ...}]
(() => {
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        null,
    );
    const results = [];
    let node;
    let i = 0;
    while ((node = walker.nextNode()) && i < 500) {
        const role = node.getAttribute('role') || node.tagName.toLowerCase();
        const ariaLabel = node.getAttribute('aria-label') || '';
        const ariaDescribedby = node.getAttribute('aria-describedby') || '';
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Skip purely structural divs with no semantic role
        if (['div', 'span'].includes(role) && !ariaLabel) continue;
        results.push({
            role: role,
            name: ariaLabel || node.textContent?.trim().slice(0, 60) || '',
            aria_label: ariaLabel || null,
            aria_describedby: ariaDescribedby || null,
            tag: node.tagName.toLowerCase(),
            selector: node.id ? '#' + node.id
                : node.tagName.toLowerCase()
                    + (node.className && typeof node.className === 'string'
                        ? '.' + node.className.trim().split(/\\s+/)[0] : '')
                    + ':nth(' + i + ')',
            id: node.id || null,
            x1: r.left, y1: r.top, x2: r.right, y2: r.bottom,
            tabindex: node.getAttribute('tabindex'),
            disabled: node.hasAttribute('disabled'),
        });
        i++;
    }
    return results;
})()
""".strip()
