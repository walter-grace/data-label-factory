"""doc_cluster.py — group parsed documents by layout similarity.

"Cluster-before-label" intake: a user drops a folder of mixed PDFs
(invoices + W-2s + receipts) and we auto-group them so they can pick
ONE cluster, build a template from ONE doc, and extract the rest.

Inputs: list of parsed doc dicts (LiteParse `parse()` output shape):
    {
        "pages": [
            {"width", "height", "text",
             "blocks": [{"bbox":[x1,y1,x2,y2], "text", "font_size"}]}
        ]
    }

Strategy (naive on purpose — the goal is UX proof, not SOTA accuracy):

    1. For each doc, compute a *fingerprint* — a pure-Python feature dict:
         - page_count
         - block_count
         - avg_font_size
         - bbox_density_grid (6x8 = 48 ints, block count per zone
           averaged across pages, normalized to page 0..1 coords)
         - top_5_text_tokens (lowercased, alnum, length>=3, not stopword)

    2. Project each fingerprint to a flat numeric vector by concatenating:
         [page_count, block_count, avg_font_size, ...48 grid counts...]
       (text tokens are compared separately with a Jaccard overlap).

    3. Pairwise distance = 0.7 * cosine_dist(numeric_vec)
                         + 0.3 * (1 - jaccard(tokens))

    4. Single-linkage agglomerative clustering with a fixed distance
       threshold (0.35). No sklearn, no scipy — about 100 LoC of pure
       Python below.

    5. For each cluster, suggest a name from the *union* of top tokens
       ("invoice" -> invoice, "w-2"/"wages" -> w2, "receipt"/"total"
       -> receipt, else "unknown").

No numpy dependency — list-of-float math is fine for <= 50 docs per call
(which is our ceiling in the API).
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any


# ── Tunables ────────────────────────────────────────────────────────
GRID_ROWS = 6
GRID_COLS = 8
TOP_TOKENS = 5
CLUSTER_THRESHOLD = 0.22   # merge if distance < this; lower = more clusters
NUMERIC_WEIGHT = 0.7
TOKEN_WEIGHT = 0.3

# Very small stopword set — enough to stop clusters from being named
# "the" or "and". Full stopword lists are overkill for this UX.
_STOPWORDS = {
    "the", "and", "for", "with", "from", "this", "that", "are", "was",
    "you", "your", "our", "not", "all", "any", "but", "can", "has",
    "have", "will", "they", "them", "who", "which", "what", "when",
    "where", "page", "date", "name", "amount", "number", "total",
    "subtotal", "address", "phone", "email", "form", "line", "item",
    "description", "quantity", "unit", "price", "due", "paid",
}

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9\-]{2,}")


# ── Fingerprint ─────────────────────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    """Lowercase word tokens >= 3 chars, minus a tiny stopword set."""
    if not text:
        return []
    out = []
    for m in _TOKEN_RE.findall(text):
        tok = m.lower()
        if tok in _STOPWORDS:
            continue
        out.append(tok)
    return out


def _grid_counts(blocks: list[dict], page_w: float, page_h: float,
                 rows: int = GRID_ROWS, cols: int = GRID_COLS) -> list[int]:
    """Count blocks whose centroid falls in each grid zone.

    Returns a flat list of length rows*cols. Normalized coordinates
    so page sizes don't leak in.
    """
    grid = [0] * (rows * cols)
    if not blocks or page_w <= 0 or page_h <= 0:
        return grid
    for b in blocks:
        bbox = b.get("bbox")
        if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
            continue
        x1, y1, x2, y2 = bbox
        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0
        # Normalize to 0..1 if they look like pixels
        if page_w > 1.5 or page_h > 1.5:
            cx = cx / page_w
            cy = cy / page_h
        # Clamp
        cx = max(0.0, min(0.999, cx))
        cy = max(0.0, min(0.999, cy))
        r = int(cy * rows)
        c = int(cx * cols)
        grid[r * cols + c] += 1
    return grid


def fingerprint(doc: dict) -> dict:
    """Compute the feature dict for one parsed doc.

    `doc` is expected to be the LiteParse `.parse()` output:
        {"text", "pages": [{"width","height","blocks":[...]}]}
    """
    pages = doc.get("pages") or []
    page_count = len(pages)

    all_blocks: list[dict] = []
    font_sizes: list[float] = []
    grid_accum = [0] * (GRID_ROWS * GRID_COLS)

    for p in pages:
        blocks = p.get("blocks") or []
        all_blocks.extend(blocks)
        for b in blocks:
            fs = b.get("font_size") or 0
            if fs:
                font_sizes.append(float(fs))
        g = _grid_counts(blocks, p.get("width") or 1, p.get("height") or 1)
        for i, v in enumerate(g):
            grid_accum[i] += v

    # Average grid density across pages (blocks-per-zone per page)
    if page_count > 0:
        grid_avg = [v / page_count for v in grid_accum]
    else:
        grid_avg = grid_accum
    block_count = len(all_blocks)
    avg_font_size = (sum(font_sizes) / len(font_sizes)) if font_sizes else 0.0

    # Token counts across the whole doc
    full_text = doc.get("text") or ""
    if not full_text:
        full_text = " ".join((p.get("text") or "") for p in pages)
    counts = Counter(_tokenize(full_text))
    top_tokens = [tok for tok, _ in counts.most_common(TOP_TOKENS)]

    return {
        "page_count": page_count,
        "block_count": block_count,
        "avg_font_size": round(avg_font_size, 2),
        "bbox_density_grid": [round(v, 3) for v in grid_avg],
        "top_tokens": top_tokens,
    }


# ── Distance ────────────────────────────────────────────────────────

def _numeric_vector(fp: dict) -> list[float]:
    """Flatten the numeric part of a fingerprint into one vector."""
    v: list[float] = [
        float(fp.get("page_count", 0)),
        float(fp.get("block_count", 0)),
        float(fp.get("avg_font_size", 0.0)),
    ]
    v.extend(float(x) for x in (fp.get("bbox_density_grid") or []))
    return v


def _cosine_distance(a: list[float], b: list[float]) -> float:
    """1 - cosine_similarity. Safe on zero-vectors (returns 1.0)."""
    if not a or not b or len(a) != len(b):
        return 1.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 1.0
    sim = dot / (na * nb)
    # Clamp for float noise
    sim = max(-1.0, min(1.0, sim))
    return 1.0 - sim


def _jaccard(a: list[str], b: list[str]) -> float:
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _doc_distance(fp_a: dict, fp_b: dict) -> float:
    num = _cosine_distance(_numeric_vector(fp_a), _numeric_vector(fp_b))
    tok = 1.0 - _jaccard(fp_a.get("top_tokens") or [], fp_b.get("top_tokens") or [])
    return NUMERIC_WEIGHT * num + TOKEN_WEIGHT * tok


# ── Clustering (single-linkage agglomerative) ───────────────────────

def _single_linkage(fps: list[dict], threshold: float) -> list[list[int]]:
    """Return list of index-groups. O(n^2) — fine for n <= 50."""
    n = len(fps)
    if n == 0:
        return []
    # Start with every doc in its own cluster
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x: int, y: int) -> None:
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[ry] = rx

    for i in range(n):
        for j in range(i + 1, n):
            if _doc_distance(fps[i], fps[j]) < threshold:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return sorted(groups.values(), key=len, reverse=True)


# ── Cluster naming ──────────────────────────────────────────────────

_NAME_RULES = [
    # (keyword(s) that must appear in any top-token, suggested name)
    (("invoice", "invoices"), "invoice"),
    (("w-2", "w2", "wages", "wage"), "w2"),
    (("1099",), "1099"),
    (("receipt", "receipts"), "receipt"),
    (("contract", "agreement"), "contract"),
    (("resume", "cv", "curriculum"), "resume"),
    (("statement", "balance"), "statement"),
    (("letter", "dear", "sincerely"), "letter"),
    (("report",), "report"),
]


def _suggest_name(top_tokens: list[str]) -> str:
    if not top_tokens:
        return "unknown"
    toks = {t.lower() for t in top_tokens}
    for keys, name in _NAME_RULES:
        if toks & set(keys):
            return name
    # Fallback: if tokens are mostly numeric/short, treat as receipt-ish
    return "unknown"


def _centroid(fps: list[dict]) -> dict:
    """Average of numeric features + union of top tokens (ranked)."""
    if not fps:
        return {}
    vs = [_numeric_vector(fp) for fp in fps]
    dim = len(vs[0])
    cen = [sum(v[i] for v in vs) / len(vs) for i in range(dim)]

    # Reconstruct back into the fingerprint dict shape for readability
    grid = cen[3:]
    tokens: Counter[str] = Counter()
    for fp in fps:
        for t in fp.get("top_tokens") or []:
            tokens[t] += 1
    return {
        "page_count": round(cen[0], 2),
        "block_count": round(cen[1], 2),
        "avg_font_size": round(cen[2], 2),
        "bbox_density_grid": [round(x, 3) for x in grid],
        "top_tokens": [t for t, _ in tokens.most_common(TOP_TOKENS)],
    }


# ── Public API ──────────────────────────────────────────────────────

def cluster_docs(
    docs: list[dict],
    doc_ids: list[str] | None = None,
    threshold: float = CLUSTER_THRESHOLD,
) -> list[dict]:
    """Cluster a list of parsed docs.

    Parameters
    ----------
    docs : list of parsed-doc dicts (LiteParse `.parse()` output shape)
    doc_ids : optional stable identifiers (same length as docs). If None,
        we use stringified indices.
    threshold : distance threshold for single-linkage merge. Lower
        values produce more, tighter clusters.

    Returns
    -------
    list of dicts:
        {
            "cluster_id": "c0",
            "doc_ids": ["doc_3", "doc_7", ...],
            "doc_count": 3,
            "centroid_features": {...},
            "suggested_name": "invoice"
        }
    Clusters are sorted largest-first.
    """
    if doc_ids is None:
        doc_ids = [str(i) for i in range(len(docs))]
    if len(doc_ids) != len(docs):
        raise ValueError("doc_ids length must match docs length")

    fps = [fingerprint(d) for d in docs]
    groups = _single_linkage(fps, threshold)

    clusters = []
    for ci, idxs in enumerate(groups):
        group_fps = [fps[i] for i in idxs]
        cen = _centroid(group_fps)
        clusters.append({
            "cluster_id": f"c{ci}",
            "doc_ids": [doc_ids[i] for i in idxs],
            "doc_count": len(idxs),
            "centroid_features": cen,
            "suggested_name": _suggest_name(cen.get("top_tokens") or []),
        })
    return clusters
