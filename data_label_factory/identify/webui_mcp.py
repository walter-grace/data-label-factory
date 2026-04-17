"""MCP server that lets LLM agents label website screenshots via the
data-label-factory webui vision pipeline.

Architecture:

    +-----------+   POST /api/webui/*   +-----------------+
    |  identify | ◀───────────────────▶ |   this MCP      |
    |  serve    |                       |   server        |
    +-----------+                       +-----------------+
                                                 ▲ stdio
                                                 │
                                           +-----------+
                                           |  Claude   |
                                           |  Desktop  |
                                           +-----------+

Tools exposed:

    label_page(screenshot_base64, classes?)
        → sends screenshot to /api/webui/detect
        → returns labeled UI regions (no DOM needed)

    label_page_with_dom(screenshot_base64, dom_bounds, classes?, dpr?)
        → sends screenshot + DOM bounds to /api/webui/map
        → returns regions mapped to CSS selectors via IoU

    suggest_selector(screenshot_base64, description, dom_bounds?)
        → "find the blue signup button"
        → detects UI elements, uses CLIP text-vs-crop matching to rank

    get_default_classes()
        → returns the class vocabulary so agents can customize

Run locally:

    GATEWAY_URL=http://localhost:8500 \
        python -m data_label_factory.identify webui-mcp

In Claude Desktop config (claude_desktop_config.json):

    {
      "mcpServers": {
        "webui-labeler": {
          "command": "python",
          "args": ["-m", "data_label_factory.identify.webui_mcp"],
          "env": {"GATEWAY_URL": "http://localhost:8500"}
        }
      }
    }
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
from typing import Any


GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://localhost:8500").rstrip("/")


def _missing(pkg: str) -> "SystemExit":
    return SystemExit(
        f"missing dependency: {pkg}\n"
        "install with:\n"
        "    pip install 'mcp[cli]' httpx\n"
    )


def main() -> int:
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError:
        raise _missing("mcp")
    try:
        import httpx
    except ImportError:
        raise _missing("httpx")

    mcp = FastMCP("webui-labeler")
    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0))

    @mcp.tool()
    async def label_page(
        screenshot_base64: str,
        classes: str | None = None,
        conf: float = 0.15,
    ) -> dict[str, Any]:
        """Label UI elements on a website screenshot. Send a base64-encoded
        PNG/JPEG screenshot and get back labeled bounding boxes for buttons,
        headers, navbars, inputs, etc. No DOM info needed — just the image.

        Args:
            screenshot_base64: base64-encoded screenshot image
            classes: optional comma-separated class list override
                     (default: button, navigation bar, search bar, ...)
            conf: YOLO confidence threshold (default 0.15)

        Returns:
            {ok, count, elements: [{bbox_norm, bbox_px, label, confidence}], ...}
        """
        image_bytes = base64.b64decode(screenshot_base64)
        files = {"image": ("screenshot.png", image_bytes, "image/png")}
        data: dict[str, Any] = {"conf": str(conf)}
        if classes:
            data["classes"] = classes
        r = await client.post(
            f"{GATEWAY_URL}/api/webui/detect",
            files=files,
            data=data,
        )
        r.raise_for_status()
        return r.json()

    @mcp.tool()
    async def label_page_with_dom(
        screenshot_base64: str,
        dom_bounds: list[dict[str, Any]],
        classes: str | None = None,
        conf: float = 0.15,
        dpr: float = 1.0,
        iou_threshold: float = 0.3,
    ) -> dict[str, Any]:
        """Label UI elements AND map them to DOM elements. Send a screenshot
        plus DOM element bounds (collected via Chrome DevTools Protocol or
        element.getBoundingClientRect()), and get back regions mapped to CSS
        selectors.

        Args:
            screenshot_base64: base64-encoded screenshot image
            dom_bounds: list of DOM elements, each with at minimum:
                {selector, tag, x1, y1, x2, y2}
                Optional: id, classes (list), data_testid
            classes: optional comma-separated class list override
            conf: YOLO confidence threshold
            dpr: device pixel ratio (pass 2.0 for Retina screenshots)
            iou_threshold: minimum IoU to accept a bbox↔DOM match

        Returns:
            {ok, count, mapped: [{label, confidence, selector, tag, ...}], ...}
        """
        image_bytes = base64.b64decode(screenshot_base64)
        files = {"image": ("screenshot.png", image_bytes, "image/png")}
        data: dict[str, Any] = {
            "dom_bounds": json.dumps(dom_bounds),
            "conf": str(conf),
            "dpr": str(dpr),
            "iou_threshold": str(iou_threshold),
        }
        if classes:
            data["classes"] = classes
        r = await client.post(
            f"{GATEWAY_URL}/api/webui/map",
            files=files,
            data=data,
        )
        r.raise_for_status()
        return r.json()

    @mcp.tool()
    async def suggest_selector(
        screenshot_base64: str,
        description: str,
        dom_bounds: list[dict[str, Any]] | None = None,
        dpr: float = 1.0,
    ) -> dict[str, Any]:
        """Find the UI element that best matches a natural-language description.
        e.g. "the blue signup button in the top right"

        First runs YOLO detection to find all UI elements, then returns the
        element whose label + position best matches the description. If
        dom_bounds is provided, also returns the matched CSS selector.

        Args:
            screenshot_base64: base64-encoded screenshot image
            description: natural-language description of the target element
            dom_bounds: optional DOM bounds for selector mapping
            dpr: device pixel ratio

        Returns:
            {ok, description, best_match: {label, confidence, bbox, selector?}, all_elements: [...]}
        """
        # First detect all elements
        if dom_bounds:
            result = await label_page_with_dom(
                screenshot_base64=screenshot_base64,
                dom_bounds=dom_bounds,
                dpr=dpr,
            )
            elements = result.get("mapped", [])
        else:
            result = await label_page(screenshot_base64=screenshot_base64)
            elements = result.get("elements", [])

        if not elements:
            return {"ok": False, "description": description, "reason": "no UI elements detected"}

        # Simple heuristic ranking: score elements by how well their label
        # matches the description (substring match + position hints).
        # A future version could use CLIP text-vs-crop for true semantic
        # matching, but keyword overlap works well for common queries like
        # "the signup button" or "the navigation bar".
        desc_lower = description.lower()
        desc_words = set(desc_lower.split())

        scored: list[tuple[float, dict]] = []
        for el in elements:
            label = (el.get("label") or "").lower()
            label_words = set(label.split())
            # Word overlap score
            overlap = len(desc_words & label_words) / max(len(desc_words), 1)
            # Substring bonus
            if label in desc_lower:
                overlap += 0.5
            # Position hints: "top" / "bottom" / "left" / "right"
            bbox = el.get("bbox_norm", el.get("bbox_px", {}))
            cy = (bbox.get("y1", 0) + bbox.get("y2", 0)) / 2
            cx = (bbox.get("x1", 0) + bbox.get("x2", 0)) / 2
            if "top" in desc_lower and cy < 0.3:
                overlap += 0.2
            if "bottom" in desc_lower and cy > 0.7:
                overlap += 0.2
            if "left" in desc_lower and cx < 0.3:
                overlap += 0.2
            if "right" in desc_lower and cx > 0.7:
                overlap += 0.2
            scored.append((overlap, el))

        scored.sort(key=lambda x: -x[0])
        best_score, best_el = scored[0]

        return {
            "ok": True,
            "description": description,
            "best_match": best_el,
            "match_score": round(best_score, 3),
            "all_elements": elements,
        }

    @mcp.tool()
    async def get_default_classes() -> dict[str, Any]:
        """Return the default web UI class vocabulary used for detection.
        Agents can use this to understand what categories are available and
        pass a custom subset to label_page() if desired."""
        r = await client.get(f"{GATEWAY_URL}/api/webui/classes")
        r.raise_for_status()
        return r.json()

    # ── Tool 5: label_structure (ALL DOM elements, not just interactive) ──

    @mcp.tool()
    async def label_structure(
        screenshot_base64: str,
        dom_all: list[dict[str, Any]],
        conf: float = 0.05,
        dpr: float = 1.0,
    ) -> dict[str, Any]:
        """Get a full structural view of a webpage: OmniParser detections mapped
        to ALL DOM elements (headers, divs, sections, etc.), plus structural-only
        elements that weren't visually detected.

        Collect `dom_all` by running the JS snippet from `get_browser_scripts()`.
        This gives you the complete layout tree the agent needs to reason about
        which component to edit.

        Args:
            screenshot_base64: base64-encoded screenshot
            dom_all: ALL visible DOM elements (from JS_COLLECT_ALL_ELEMENTS).
                     Each: {selector, tag, x1, y1, x2, y2, id?, classes?, text?}
            conf: detection confidence threshold
            dpr: device pixel ratio
        """
        image_bytes = base64.b64decode(screenshot_base64)
        files = {"image": ("screenshot.png", image_bytes, "image/png")}
        data = {
            "dom_all": json.dumps(dom_all),
            "conf": str(conf),
            "dpr": str(dpr),
        }
        r = await client.post(f"{GATEWAY_URL}/api/webui/structure", files=files, data=data)
        r.raise_for_status()
        return r.json()

    # ── Tool 6: get_computed_styles ──

    @mcp.tool()
    async def get_computed_styles(
        screenshot_base64: str,
        dom_with_styles: list[dict[str, Any]],
        dpr: float = 1.0,
    ) -> dict[str, Any]:
        """Correlate visual detections with computed CSS styles for each element.

        Collect `dom_with_styles` by running the JS snippet from
        `get_browser_scripts()` (the 'collect_computed_styles' one). Each entry
        should have {selector, tag, x1, y1, x2, y2, styles: {fontSize, color,
        backgroundColor, padding, margin, ...}}.

        Returns OmniParser detections mapped to DOM elements, enriched with
        their CSS styles. The agent can see "this button has font-size: 16px,
        background: #2ea44f" without opening the inspector.

        Args:
            screenshot_base64: base64-encoded screenshot
            dom_with_styles: DOM elements with computed styles
            dpr: device pixel ratio
        """
        # Use the /map endpoint for detection→DOM matching
        image_bytes = base64.b64decode(screenshot_base64)
        files = {"image": ("screenshot.png", image_bytes, "image/png")}
        # Strip styles from dom_bounds for the IoU mapping
        dom_bounds = [{k: v for k, v in d.items() if k != "styles"} for d in dom_with_styles]
        data = {
            "dom_bounds": json.dumps(dom_bounds),
            "conf": "0.05",
            "dpr": str(dpr),
        }
        r = await client.post(f"{GATEWAY_URL}/api/webui/map", files=files, data=data)
        r.raise_for_status()
        result = r.json()

        # Enrich matched elements with their styles from the original data
        style_lookup = {}
        for d in dom_with_styles:
            key = d.get("selector", "")
            if key and "styles" in d:
                style_lookup[key] = d["styles"]

        for m in result.get("mapped", []):
            sel = m.get("selector", "")
            if sel in style_lookup:
                m["styles"] = style_lookup[sel]

        return result

    # ── Tool 7: screenshot_diff ──

    @mcp.tool()
    async def screenshot_diff(
        before_base64: str,
        after_base64: str,
        conf: float = 0.05,
    ) -> dict[str, Any]:
        """Compare two screenshots and report which UI elements were added,
        removed, or moved. Use this after making a code edit to verify the
        right element changed.

        Args:
            before_base64: base64-encoded screenshot BEFORE the edit
            after_base64: base64-encoded screenshot AFTER the edit
            conf: detection confidence threshold

        Returns:
            {added: [...], removed: [...], moved: [...], unchanged: [...]}
        """
        before_bytes = base64.b64decode(before_base64)
        after_bytes = base64.b64decode(after_base64)
        r = await client.post(
            f"{GATEWAY_URL}/api/webui/diff",
            files={
                "before": ("before.png", before_bytes, "image/png"),
                "after": ("after.png", after_bytes, "image/png"),
            },
            data={"conf": str(conf)},
        )
        r.raise_for_status()
        return r.json()

    # ── Tool 8: get_accessibility_tree ──

    @mcp.tool()
    async def get_accessibility_tree(
        screenshot_base64: str,
        ax_tree: list[dict[str, Any]],
        dpr: float = 1.0,
    ) -> dict[str, Any]:
        """Correlate visual detections with the accessibility tree.

        Collect `ax_tree` by running the JS snippet from `get_browser_scripts()`
        (the 'collect_accessibility_tree' one). Each entry should have
        {role, name, selector, x1, y1, x2, y2, ...}.

        Returns OmniParser detections enriched with a11y info: role, aria-label,
        name, and whether the element is focusable/disabled. The agent can see
        "this button is labeled 'Sign up for GitHub', has role=link" alongside
        the visual bbox.

        Args:
            screenshot_base64: base64-encoded screenshot
            ax_tree: accessibility tree entries from the browser
            dpr: device pixel ratio
        """
        # Use /map for detection→DOM matching (ax_tree entries have bboxes)
        image_bytes = base64.b64decode(screenshot_base64)
        files = {"image": ("screenshot.png", image_bytes, "image/png")}
        dom_bounds = [{
            "selector": a.get("selector", ""),
            "tag": a.get("tag", ""),
            "id": a.get("id"),
            "classes": [],
            "x1": a["x1"], "y1": a["y1"], "x2": a["x2"], "y2": a["y2"],
        } for a in ax_tree if "x1" in a]
        data = {
            "dom_bounds": json.dumps(dom_bounds),
            "conf": "0.05",
            "dpr": str(dpr),
            "iou_threshold": "0.2",
        }
        r = await client.post(f"{GATEWAY_URL}/api/webui/map", files=files, data=data)
        r.raise_for_status()
        result = r.json()

        # Enrich with a11y fields
        ax_lookup = {}
        for a in ax_tree:
            key = a.get("selector", "")
            if key:
                ax_lookup[key] = a

        for m in result.get("mapped", []):
            sel = m.get("selector", "")
            if sel in ax_lookup:
                ax = ax_lookup[sel]
                m["role"] = ax.get("role")
                m["aria_label"] = ax.get("aria_label")
                m["aria_name"] = ax.get("name")
                m["tabindex"] = ax.get("tabindex")
                m["disabled"] = ax.get("disabled", False)

        return result

    # ── Tool 9: get_browser_scripts ──

    @mcp.tool()
    async def get_browser_scripts() -> dict[str, Any]:
        """Return JS snippets to run in the browser to collect data for the
        other tools. Run these via your Chrome MCP server or Playwright.

        Returns three scripts:
        - collect_all_elements: for label_structure()
        - collect_computed_styles: for get_computed_styles()
        - collect_accessibility_tree: for get_accessibility_tree()

        Each script is a self-contained IIFE that returns JSON-serializable data.
        """
        r = await client.get(f"{GATEWAY_URL}/api/webui/scripts")
        r.raise_for_status()
        return r.json()

    mcp.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
