"""data_label_factory.identify — open-set retrieval / card identification.

The companion to the bbox-grounding pipeline. Where the main `data_label_factory`
CLI produces COCO labels for training a closed-set detector, this subpackage
produces a CLIP-based retrieval index for open-set identification.

Use it when you have a known set of N reference images (cards, products, parts,
artworks, etc) and want to identify which one a webcam frame is showing — with
a single reference image per class and zero training time.

Pipeline stages
---------------

    references/                  ← user provides 1 image per class
         ↓
    train_identifier             ← optional: contrastive fine-tune of a small
         ↓                          projection head on top of frozen CLIP
    clip_proj.pt
         ↓
    build_index                  ← CLIP-encode each reference + apply projection
         ↓                          head, save embeddings to .npz
    card_index.npz
         ↓
    verify_index                 ← self-test: each reference should match itself
         ↓                          as top-1 with high cosine similarity
    serve_identifier             ← HTTP server (mac_tensor /api/falcon-shaped)
         ↓                          that the live tracker UI talks to
    /api/falcon

This is the data-label-factory loop applied to retrieval instead of detection.

CLI
---

    python3 -m data_label_factory.identify train  --refs limit-over-pack/ --out clip_proj.pt
    python3 -m data_label_factory.identify index  --refs limit-over-pack/ --proj clip_proj.pt --out card_index.npz
    python3 -m data_label_factory.identify verify --index card_index.npz --refs limit-over-pack/
    python3 -m data_label_factory.identify serve  --index card_index.npz --refs limit-over-pack/ --port 8500
"""

__all__ = ["main"]


def main():
    """Lazy entry point — only imports the heavy ML deps if user invokes the CLI."""
    from .cli import main as _main
    return _main()
