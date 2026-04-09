"""Build a CLIP retrieval index from a folder of reference images.

Each image's filename becomes its display label (with set-code prefixes
stripped and rarity suffixes preserved). Optionally applies a fine-tuned
projection head produced by `data_label_factory.identify train`.

The output `.npz` contains three arrays:
    embeddings  (N, D)  L2-normalized
    names       (N,)    cleaned display names
    filenames   (N,)    original filenames (so the server can serve refs)
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="data_label_factory.identify index",
        description=(
            "Encode every image in a reference folder with CLIP (optionally "
            "passed through a fine-tuned projection head) and save the embeddings "
            "as a searchable .npz index."
        ),
    )
    parser.add_argument("--refs", required=True, help="Folder of reference images")
    parser.add_argument("--out", default="card_index.npz", help="Output .npz path")
    parser.add_argument("--projection", default=None,
                        help="Optional fine-tuned projection head .pt (from `train`)")
    parser.add_argument("--clip-model", default="ViT-B/32")
    args = parser.parse_args(argv)

    try:
        import numpy as np
        import torch
        import torch.nn as nn
        import torch.nn.functional as F
        from PIL import Image
        import clip
    except ImportError as e:
        raise SystemExit(
            f"missing dependency: {e}\n"
            "install with:\n"
            "    pip install torch pillow git+https://github.com/openai/CLIP.git"
        )

    DEVICE = ("mps" if torch.backends.mps.is_available()
              else "cuda" if torch.cuda.is_available() else "cpu")
    print(f"[index] device={DEVICE}", flush=True)

    refs = Path(args.refs)
    if not refs.is_dir():
        raise SystemExit(f"refs folder not found: {refs}")

    print(f"[index] loading CLIP {args.clip_model} …", flush=True)
    model, preprocess = clip.load(args.clip_model, device=DEVICE)
    model.eval()

    head = None
    if args.projection and os.path.exists(args.projection):
        print(f"[index] loading projection head from {args.projection}", flush=True)

        class ProjectionHead(nn.Module):
            def __init__(self, in_dim=512, hidden=512, out_dim=256):
                super().__init__()
                self.net = nn.Sequential(
                    nn.Linear(in_dim, hidden), nn.GELU(), nn.Linear(hidden, out_dim))

            def forward(self, x):
                return F.normalize(self.net(x), dim=-1)

        ckpt = torch.load(args.projection, map_location=DEVICE)
        sd = ckpt.get("state_dict", ckpt)
        head = ProjectionHead(
            in_dim=ckpt.get("in_dim", 512),
            hidden=ckpt.get("hidden", 512),
            out_dim=ckpt.get("out_dim", 256),
        ).to(DEVICE)
        head.load_state_dict(sd)
        head.eval()
        print(f"[index]   out_dim={ckpt.get('out_dim', 256)}", flush=True)

    files = sorted(f for f in os.listdir(refs)
                   if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
    if not files:
        raise SystemExit(f"no images in {refs}")
    print(f"[index] {len(files)} reference images", flush=True)

    embeddings, names, filenames = [], [], []
    for i, fname in enumerate(files, 1):
        path = refs / fname
        # Strip set-code prefix (e.g. "LOCH-JP001_") and clean up underscores
        stem = os.path.splitext(fname)[0]
        stem = re.sub(r"^[A-Z]+-[A-Z]+\d+_", "", stem)
        name = stem.replace("_", " ").title()
        # "Pharaoh S Servant" → "Pharaoh's Servant"
        name = re.sub(r"\b(\w+) S\b", r"\1's", name)
        try:
            img = Image.open(path).convert("RGB")
        except Exception as e:
            print(f"[index]   skip {fname}: {e}", flush=True)
            continue
        with torch.no_grad():
            tensor = preprocess(img).unsqueeze(0).to(DEVICE)
            feat = model.encode_image(tensor).float()
            feat = feat / feat.norm(dim=-1, keepdim=True)
            if head is not None:
                feat = head(feat)
        embeddings.append(feat.cpu().numpy()[0].astype(np.float32))
        names.append(name)
        filenames.append(fname)
        if i % 25 == 0 or i == len(files):
            print(f"[index]   [{i:3d}/{len(files)}] {name[:50]}", flush=True)

    emb = np.stack(embeddings, axis=0)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(out,
             embeddings=emb,
             names=np.array(names, dtype=object),
             filenames=np.array(filenames, dtype=object))
    print(f"\n[index] ✓ wrote {out}  ({emb.shape[0]} refs × {emb.shape[1]} dims, "
          f"{out.stat().st_size / 1024:.1f} KB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
