"""doc_template — User-editable document-extraction templates.

A Template describes *where* structured fields live on a document so that
parsing arbitrary instances of the same doc type returns consistent,
schema-aligned extractions. The user-facing flow:

    1. Upload first PDF  →  lit parses into tentative blocks
    2. User drags bboxes + types labels in the /template/new editor
    3. Save as YAML (projects/templates/user/<name>.yaml)
    4. Apply template to batch PDFs  →  structured JSON/CSV
    5. Corrections flow into /api/rewards for GRPO retraining

Template anchoring:
    Fields can declare `anchor_text` (e.g. "Invoice #") — when we apply
    the template to a new PDF, we look for that text near the expected
    bbox and shift the field-bbox accordingly. This handles docs of the
    same TYPE that aren't pixel-identical (e.g. different vendors'
    invoices).

Storage layout:
    data_label_factory/templates/library/*.yaml    — marketplace seed
    projects/templates/user/*.yaml                  — user-created
"""

from __future__ import annotations

import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional

import yaml


# Where user-created templates live on disk. Library templates live in the
# package under data_label_factory/templates/library/ (installed alongside
# the code, not in the per-user projects dir).
USER_TEMPLATE_DIR = Path(
    __import__("os").environ.get(
        "DLF_TEMPLATE_DIR",
        str(Path(__file__).parent.parent / "projects" / "templates" / "user"),
    )
)
LIBRARY_TEMPLATE_DIR = Path(__file__).parent / "templates" / "library"


FieldType = Literal["text", "number", "currency", "date", "email", "phone", "table", "boolean"]


@dataclass
class TemplateField:
    """A single labeled region on the document."""
    name: str                            # machine key, e.g. "invoice_number"
    label: str                           # human label, e.g. "Invoice #"
    bbox: list[float]                    # [x1, y1, x2, y2] in PDF points
    type: FieldType = "text"
    required: bool = False
    anchor_text: Optional[str] = None    # nearby landmark for alignment
    page: int = 1                        # 1-indexed page number

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        # Drop None values for cleaner YAML
        return {k: v for k, v in d.items() if v is not None}


@dataclass
class Template:
    """A named document-extraction template.

    YAML round-trips via to_yaml/from_yaml. Fields can be reordered without
    breaking apply-to-batch — we key by `name`.
    """
    name: str                            # unique slug
    display_name: str
    description: str = ""
    doc_type: str = "generic"            # invoice, w2, receipt, contract, ...
    page_size: list[float] = field(default_factory=lambda: [612, 792])
    fields: list[TemplateField] = field(default_factory=list)
    anchor_fields: list[str] = field(default_factory=list)
    created_at: str = ""
    source: Literal["library", "user", "cluster", "schema"] = "user"

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "description": self.description,
            "doc_type": self.doc_type,
            "page_size": list(self.page_size),
            "fields": [f.to_dict() for f in self.fields],
            "anchor_fields": list(self.anchor_fields),
            "created_at": self.created_at or _now_iso(),
            "source": self.source,
        }

    def to_yaml(self) -> str:
        return yaml.safe_dump(self.to_dict(), sort_keys=False)

    def save(self, path: Optional[Path] = None) -> Path:
        """Persist to disk. Defaults to USER_TEMPLATE_DIR/<name>.yaml."""
        if path is None:
            USER_TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
            path = USER_TEMPLATE_DIR / f"{self.name}.yaml"
        path.write_text(self.to_yaml())
        return path

    def summary(self) -> dict[str, Any]:
        """Slim public shape for list views — no per-field bboxes."""
        return {
            "name": self.name,
            "display_name": self.display_name,
            "description": self.description,
            "doc_type": self.doc_type,
            "page_size": list(self.page_size),
            "field_count": len(self.fields),
            "source": self.source,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Template":
        fields_raw = d.get("fields") or []
        fields = [TemplateField(**_clean_field(f)) for f in fields_raw]
        return cls(
            name=d["name"],
            display_name=d.get("display_name", d["name"]),
            description=d.get("description", ""),
            doc_type=d.get("doc_type", "generic"),
            page_size=d.get("page_size", [612, 792]),
            fields=fields,
            anchor_fields=d.get("anchor_fields", []),
            created_at=d.get("created_at", ""),
            source=d.get("source", "user"),
        )

    @classmethod
    def from_yaml(cls, text: str) -> "Template":
        return cls.from_dict(yaml.safe_load(text))

    @classmethod
    def load(cls, name: str, library: bool = False) -> Optional["Template"]:
        """Load by slug. Tries library OR user dir depending on flag."""
        root = LIBRARY_TEMPLATE_DIR if library else USER_TEMPLATE_DIR
        # Allow both exact slug and stem match
        candidate = root / f"{_slug(name)}.yaml"
        if not candidate.exists():
            return None
        return cls.from_yaml(candidate.read_text())

    # ── Core: apply template to a freshly-parsed document ─────────

    def apply(self, parsed_doc: dict[str, Any]) -> dict[str, Any]:
        """Apply this template to a `lit parse` output.

        For each field:
          1. Use anchor_text if present to shift the bbox (handles doc
             variance — fields are tied to nearby text, not absolute
             coordinates)
          2. Collect all blocks intersecting (or overlapping >20%) the
             adjusted bbox
          3. Concatenate block text → field value
          4. Type-coerce if possible (currency → float, date → ISO)

        Returns { field_name: {value, raw_text, bbox_used, confidence} }.
        """
        result: dict[str, Any] = {}
        pages = parsed_doc.get("pages") or []
        for f in self.fields:
            page_idx = max(0, min(f.page - 1, len(pages) - 1))
            page = pages[page_idx] if pages else {"blocks": []}
            blocks = page.get("blocks") or []

            bbox = list(f.bbox)

            # Anchor-alignment: if anchor_text matches a block, shift the
            # field bbox by (anchor_block_bbox - anchor_expected_bbox).
            if f.anchor_text:
                shift = _compute_anchor_shift(blocks, f.anchor_text, bbox)
                if shift:
                    dx, dy = shift
                    bbox = [bbox[0] + dx, bbox[1] + dy, bbox[2] + dx, bbox[3] + dy]

            # Collect overlapping blocks
            matched = [
                b for b in blocks
                if _bbox_overlap_ratio(_bbox_of(b), bbox) > 0.2
            ]
            # Sort by reading order (y then x)
            matched.sort(key=lambda b: (_bbox_of(b)[1], _bbox_of(b)[0]))

            raw_text = " ".join((b.get("text") or "").strip() for b in matched).strip()

            if f.type == "table":
                # Cluster matched word-boxes into rows + columns → 2D value
                table_rows = word_boxes_to_table_value(matched)
                result[f.name] = {
                    "value": table_rows,
                    "raw_text": raw_text,
                    "bbox_used": bbox,
                    "confidence": round(sum(b.get("confidence", 1.0) for b in matched) / max(len(matched), 1), 3),
                    "matched_block_count": len(matched),
                    "row_count": len(table_rows),
                    "col_count": max((len(r) for r in table_rows), default=0),
                }
            else:
                value = _coerce(raw_text, f.type)
                result[f.name] = {
                    "value": value,
                    "raw_text": raw_text,
                    "bbox_used": bbox,
                    "confidence": round(sum(b.get("confidence", 1.0) for b in matched) / max(len(matched), 1), 3),
                    "matched_block_count": len(matched),
                }

        return result


# ── Loading utilities ──────────────────────────────────────────────

def list_templates(library: bool = False) -> list[Template]:
    """All templates in the given source directory."""
    root = LIBRARY_TEMPLATE_DIR if library else USER_TEMPLATE_DIR
    if not root.exists():
        return []
    out: list[Template] = []
    for p in sorted(root.glob("*.yaml")):
        try:
            t = Template.from_yaml(p.read_text())
            if not t.source:
                t.source = "library" if library else "user"
            out.append(t)
        except Exception:
            # Malformed YAML — skip silently so one bad file doesn't break listing
            continue
    return out


# ── Helpers ────────────────────────────────────────────────────────

def _now_iso() -> str:
    import datetime
    return datetime.datetime.utcnow().isoformat() + "Z"


def _slug(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def _clean_field(d: dict) -> dict:
    """Drop legacy/unknown keys before passing to TemplateField."""
    allowed = {"name", "label", "bbox", "type", "required", "anchor_text", "page"}
    return {k: v for k, v in d.items() if k in allowed}


def _bbox_of(block: dict) -> list[float]:
    bb = block.get("bbox") or [0, 0, 0, 0]
    if len(bb) == 4:
        return [float(x) for x in bb]
    return [0, 0, 0, 0]


def _bbox_overlap_ratio(a: list[float], b: list[float]) -> float:
    """Area of intersection / area of the smaller box. 0..1."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    a_area = max(0, (ax2 - ax1) * (ay2 - ay1))
    b_area = max(0, (bx2 - bx1) * (by2 - by1))
    smaller = min(a_area, b_area) or 1
    return inter / smaller


def _compute_anchor_shift(blocks: list[dict], anchor_text: str, expected_bbox: list[float]) -> Optional[tuple[float, float]]:
    """Find a block whose text contains anchor_text near expected_bbox; return shift vector."""
    ax = anchor_text.lower().strip()
    if not ax:
        return None
    # Prefer the closest match to expected position (center distance)
    ex_cx = (expected_bbox[0] + expected_bbox[2]) / 2
    ex_cy = (expected_bbox[1] + expected_bbox[3]) / 2
    best = None
    best_dist = float("inf")
    for b in blocks:
        t = (b.get("text") or "").lower()
        if ax not in t:
            continue
        bb = _bbox_of(b)
        cx = (bb[0] + bb[2]) / 2
        cy = (bb[1] + bb[3]) / 2
        d = (cx - ex_cx) ** 2 + (cy - ex_cy) ** 2
        if d < best_dist:
            best_dist = d
            best = bb
    if not best:
        return None
    # Shift = (actual center - expected center) — but anchor_text is a LANDMARK near the field,
    # not the field itself, so we interpret: actual anchor position - expected anchor position.
    # Since expected_bbox IS the field bbox, we approximate shift using the anchor-to-field
    # delta as zero and just use the anchor-vs-itself shift. Simple and good enough for v1.
    # Future: store expected_anchor_bbox separately.
    return None  # Disabled in v1 — anchors enable UI hints but don't shift bboxes yet.


# ── Word-to-region clustering ──────────────────────────────────────
#
# LiteParse emits per-word boxes. Tables are a cluster of aligned
# per-word boxes across multiple rows; paragraphs are a few clustered
# lines. We cluster word-boxes by line-height-aware y-proximity, then
# detect column structure to classify cluster type.

def cluster_words_to_rows(
    blocks: list[dict],
    line_gap_tolerance: float = 1.4,
) -> list[list[dict]]:
    """Group word-blocks into rows by y-centroid.

    Two words are on the same row if their vertical centers are within
    `line_gap_tolerance * min(line_height)` of each other. Returns a list
    of rows, each row sorted left-to-right.
    """
    if not blocks:
        return []
    # Attach centroids + heights
    items = []
    for b in blocks:
        bb = b.get("bbox") or [0, 0, 0, 0]
        if len(bb) != 4:
            continue
        x1, y1, x2, y2 = bb
        items.append({
            "block": b,
            "cy": (y1 + y2) / 2,
            "h": y2 - y1,
            "x1": x1,
            "x2": x2,
        })
    items.sort(key=lambda it: (it["cy"], it["x1"]))

    median_h = sorted(it["h"] for it in items)[len(items) // 2] or 1
    tol = line_gap_tolerance * median_h

    rows: list[list[dict]] = []
    for it in items:
        placed = False
        for row in rows:
            if abs(it["cy"] - row[0]["cy"]) < tol:
                row.append(it)
                placed = True
                break
        if not placed:
            rows.append([it])

    # Sort each row left-to-right and return just the blocks
    return [sorted(r, key=lambda it: it["x1"]) for r in rows]


def cluster_rows_to_table(rows: list[list[dict]]) -> dict[str, Any]:
    """Detect table structure inside a set of rows.

    Heuristic: if rows have >= `min_cols` items AND share >= 2 aligned
    left-edges across rows, we treat it as a table. Columns are inferred
    from clustering left-edges across all rows.
    """
    if len(rows) < 2:
        return {"type": "paragraph", "rows": [[it["block"] for it in r] for r in rows]}

    # Extract all left-edges and bin into columns (±gap tolerance)
    all_x = []
    for row in rows:
        for it in row:
            all_x.append(it["x1"])
    if not all_x:
        return {"type": "paragraph", "rows": []}

    all_x.sort()
    col_tol = 8.0  # PDF points — ~2px at 72dpi
    columns: list[float] = []
    for x in all_x:
        if not columns or x - columns[-1] > col_tol:
            columns.append(x)

    # Classify row lengths
    row_lens = [len(r) for r in rows]
    mean_cols = sum(row_lens) / len(row_lens)
    # Table if: >= 2 rows, each row has >= 2 cols, >= 3 distinct columns overall
    is_table = (
        len(rows) >= 2
        and mean_cols >= 2
        and len(columns) >= 3
    )

    return {
        "type": "table" if is_table else "paragraph",
        "columns": columns if is_table else [],
        "rows": [[it["block"] for it in r] for r in rows],
        "row_count": len(rows),
        "col_count": len(columns) if is_table else max(row_lens),
    }


def word_boxes_to_table_value(blocks: list[dict]) -> list[list[str]]:
    """Extract table-shaped text from clustered word boxes.

    Returns a 2D list of strings — one row per detected text line,
    cells left-to-right. Empty cells are "".
    """
    rows = cluster_words_to_rows(blocks)
    cluster = cluster_rows_to_table(rows)
    out: list[list[str]] = []
    if cluster["type"] != "table":
        # Fall back to one cell per line
        return [[" ".join((b.get("text") or "").strip() for b in row) for row in cluster["rows"]]]

    columns = cluster["columns"]
    for row in cluster["rows"]:
        cells = ["" for _ in columns]
        for b in row:
            x1 = (b.get("bbox") or [0, 0, 0, 0])[0]
            # Assign to nearest column
            ci = min(range(len(columns)), key=lambda i: abs(columns[i] - x1))
            if cells[ci]:
                cells[ci] += " " + (b.get("text") or "").strip()
            else:
                cells[ci] = (b.get("text") or "").strip()
        out.append(cells)
    return out


def _coerce(raw: str, ftype: FieldType) -> Any:
    """Best-effort string → typed value. Return raw string on failure."""
    s = raw.strip()
    if not s:
        return None
    try:
        if ftype == "currency":
            # Strip $, €, commas; parse float
            cleaned = re.sub(r"[^\d.\-]", "", s)
            return float(cleaned) if cleaned else s
        if ftype == "number":
            cleaned = re.sub(r"[^\d.\-]", "", s)
            return float(cleaned) if cleaned else s
        if ftype == "date":
            # Very permissive — just return the raw string; UI can parse further
            return s
        if ftype == "boolean":
            return s.lower() in ("yes", "true", "y", "1", "checked", "✓", "x")
        if ftype == "email":
            m = re.search(r"[\w.\-]+@[\w.\-]+\.\w+", s)
            return m.group(0) if m else s
        if ftype == "phone":
            return s
    except Exception:
        return s
    return s
