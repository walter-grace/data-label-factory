"""flywheel_docs — Document-mode challenge registry for Flywheel.

Extends the Flywheel game to document-layout labeling. Every challenge shows
a block cropped from a parsed document and asks "Is this a section header?"
(or similar binary question). Answers flow to /api/rewards and eventually
train a doc-layout GRPO model.

Why this is agent-friendly:
    Each challenge surfaces *three* signals so agents with different
    capabilities can play:
        1. block_text     — text-only LLMs can decide from string alone
        2. page_image_url — vision models can look at the full rendered page
        3. bbox           — allows client-side or server-side cropping
    Trust weighting is reused from the image-mode Flywheel (honeypots
    establish ground truth; trust < 50 = labels discarded).

Storage layout (filesystem):
    {DLF_FLYWHEEL_DIR}/{doc_id}/page_N.png   — rendered pages
    (default DLF_FLYWHEEL_DIR = /tmp/dlf-flywheel)

Today the registry ships ONE sample document (the MoE paper that Nico
parsed). Future: auto-ingest from /api/parse — every parse contributes
new challenges to this pool.
"""

from __future__ import annotations

import os
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal


FLYWHEEL_DIR = Path(os.environ.get("DLF_FLYWHEEL_DIR", "/tmp/dlf-flywheel"))
GroundTruth = Literal["YES", "NO"]
BlockType = Literal["header", "paragraph", "table", "figure", "caption"]


@dataclass
class DocChallenge:
    """A single document-labeling challenge.

    A challenge is one bounding box on a rendered document page plus the
    question we want verified. Honeypots have a `ground_truth` set; real
    challenges leave it None so any answer becomes training data.
    """
    id: str
    doc_id: str           # slug — e.g. "moe_paper"
    page: int             # 1-indexed
    block_text: str
    bbox: list[float]     # [x1, y1, x2, y2] in PDF points
    page_width: int       # PDF width in points (e.g. 612)
    page_height: int      # PDF height in points
    question: str = "Is this block a section header? YES or NO."
    question_field: BlockType = "header"
    tentative_type: BlockType = "paragraph"   # what lit's heuristic said
    ground_truth: GroundTruth | None = None    # honeypots only
    difficulty: Literal["easy", "medium", "hard"] = "medium"

    def page_image_path(self) -> Path:
        return FLYWHEEL_DIR / self.doc_id / f"page_{self.page}.png"

    def page_image_url(self, base_url: str = "") -> str:
        """URL relative to the DLF backend host."""
        return f"{base_url}/api/doc-page/{self.doc_id}/page_{self.page}.png"

    def to_public(self, base_url: str = "") -> dict[str, Any]:
        """Safe shape to send over the wire — hides ground_truth."""
        return {
            "challenge_id": self.id,
            "doc_id": self.doc_id,
            "page": self.page,
            "block_text": self.block_text,
            "bbox": self.bbox,
            "page_width": self.page_width,
            "page_height": self.page_height,
            "page_image_url": self.page_image_url(base_url),
            "question": self.question,
            "question_field": self.question_field,
            "tentative_type": self.tentative_type,
        }


# ── Registry ─────────────────────────────────────────────────────────
#
# Blocks are indexed against /tmp/parsed.json from an earlier lit parse of
# the MoE paper. Hand-labeled `ground_truth` reflects human judgment on
# whether the block is a section header.

_MOE_PAPER_CHALLENGES: list[DocChallenge] = [
    # ── HONEYPOTS — YES (clear section headers) ────────────────────
    DocChallenge(
        id="moe_01_title",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="MoE Expert Streaming: Running 35B Models on 8GB Macs",
        bbox=[34, 33, 252, 42],
        ground_truth="YES", difficulty="easy",
    ),
    DocChallenge(
        id="moe_02_abstract",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="Abstract",
        bbox=[34, 70, 64, 79],
        ground_truth="YES", difficulty="easy",
    ),
    DocChallenge(
        id="moe_03_keyfindings",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="Key Findings",
        bbox=[34, 122, 83, 131],
        ground_truth="YES", difficulty="easy",
    ),
    DocChallenge(
        id="moe_04_benchresults",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="Benchmark Results",
        bbox=[34, 210, 117, 219],
        ground_truth="YES", difficulty="medium",
    ),
    DocChallenge(
        id="moe_05_architecture",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="Architecture",
        bbox=[34, 310, 95, 319],
        ground_truth="YES", difficulty="easy",
    ),

    # ── HONEYPOTS — NO (clear body paragraphs) ─────────────────────
    DocChallenge(
        id="moe_06_para1",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text=(
            "We demonstrate that Mixture-of-Experts (MoE) models with high "
            "sparsity can run on consumer hardware…"
        ),
        bbox=[34, 80, 516, 89],
        ground_truth="NO", difficulty="easy",
    ),
    DocChallenge(
        id="moe_07_madvise",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text=(
            "Prefetching expert pages via madvise() outperforms both stock "
            "mmap and our custom LRU cache…"
        ),
        bbox=[34, 133, 545, 143],
        ground_truth="NO", difficulty="medium",
    ),
    DocChallenge(
        id="moe_08_m2air",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="M2 MacBook Air (8GB): 2.1 tok/s with madvise vs 0.3 tok/s stock — a 7x improvement.",
        bbox=[34, 220, 540, 230],
        ground_truth="NO", difficulty="medium",
    ),
    DocChallenge(
        id="moe_09_system_intro",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="The system consists of three components:",
        bbox=[34, 321, 240, 330],
        ground_truth="NO", difficulty="hard",
    ),
    DocChallenge(
        id="moe_10_crossover_body",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text=(
            "At approximately 0.75-0.79x RAM/model ratio, the benefit of "
            "madvise disappears…"
        ),
        bbox=[34, 165, 530, 175],
        ground_truth="NO", difficulty="medium",
    ),

    # ── REAL CHALLENGES — no ground truth, labels become training data ─
    DocChallenge(
        id="moe_r1_subtitle",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="Technical Report — March 2026",
        bbox=[237, 43, 375, 54],
        ground_truth=None, difficulty="hard",   # genuinely ambiguous
    ),
    DocChallenge(
        id="moe_r2_hwresults_caption",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="Hardware Results:",
        bbox=[34, 198, 94, 207],
        ground_truth=None, difficulty="medium",
    ),
    DocChallenge(
        id="moe_r3_crossover_label",
        doc_id="moe_paper", page=1, page_width=612, page_height=792,
        block_text="Crossover Point:",
        bbox=[34, 155, 95, 164],
        ground_truth=None, difficulty="medium",
    ),
]


def list_challenges(doc_id: str | None = None) -> list[DocChallenge]:
    """All challenges, optionally filtered by document."""
    pool = _MOE_PAPER_CHALLENGES  # future: aggregate across all ingested docs
    if doc_id:
        return [c for c in pool if c.doc_id == doc_id]
    return list(pool)


def get_challenge(challenge_id: str) -> DocChallenge | None:
    for c in _MOE_PAPER_CHALLENGES:
        if c.id == challenge_id:
            return c
    return None


def sample_challenge(
    rng: random.Random | None = None,
    honeypot_rate: float = 0.3,
) -> DocChallenge:
    """Pick a challenge with the given honeypot rate.

    Matches the image-Flywheel trust mechanism: ~30% of served challenges
    have known ground truth so we can score trust scores.
    """
    rng = rng or random
    honeypots = [c for c in _MOE_PAPER_CHALLENGES if c.ground_truth is not None]
    reals = [c for c in _MOE_PAPER_CHALLENGES if c.ground_truth is None]

    if not honeypots and not reals:
        raise ValueError("no challenges registered")
    if not honeypots:
        return rng.choice(reals)
    if not reals:
        return rng.choice(honeypots)

    if rng.random() < honeypot_rate:
        return rng.choice(honeypots)
    return rng.choice(reals)


def list_docs() -> list[dict[str, Any]]:
    """Documents available in the challenge pool."""
    by_doc: dict[str, list[DocChallenge]] = {}
    for c in _MOE_PAPER_CHALLENGES:
        by_doc.setdefault(c.doc_id, []).append(c)
    out = []
    for doc_id, cs in by_doc.items():
        page_img = FLYWHEEL_DIR / doc_id / "page_1.png"
        out.append({
            "doc_id": doc_id,
            "display_name": doc_id.replace("_", " ").title(),
            "challenge_count": len(cs),
            "honeypot_count": sum(1 for c in cs if c.ground_truth is not None),
            "page_rendered": page_img.exists(),
            "page_path": str(page_img),
        })
    return out
