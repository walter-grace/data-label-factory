"""Contrastive fine-tune of a small projection head on top of frozen CLIP.

Wraps the proven training loop that took the 150-card index from cosine
margin 0.074 → 0.36 (5x improvement). The CLIP backbone stays frozen, only
a tiny ~400k-param projection MLP is trained, so this runs on Apple Silicon
MPS in ~5 minutes for a 150-class set.

Data generation: K cards × M augmentations per batch (default 16 × 4 = 64).
Loss: SupCon (Khosla et al. 2020).
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time
from pathlib import Path

# Lazy heavy imports — only triggered when this module is actually invoked.

DEFAULT_PALETTE_HINT = "ViT-B/32 + 512→512→256 projection"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="data_label_factory.identify train",
        description=(
            "Contrastive fine-tune a small projection head on top of frozen CLIP. "
            "Use this when off-the-shelf CLIP retrieval is too noisy for your "
            f"reference set. Architecture: {DEFAULT_PALETTE_HINT}."
        ),
    )
    parser.add_argument("--refs", required=True,
                        help="Folder of reference images (1 per class). Filenames become labels.")
    parser.add_argument("--out", default="clip_proj.pt",
                        help="Output path for the trained projection head .pt")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--k-cards", type=int, default=16,
                        help="Distinct classes per training batch.")
    parser.add_argument("--m-augs", type=int, default=4,
                        help="Augmentations per class per batch.")
    parser.add_argument("--steps-per-epoch", type=int, default=80)
    parser.add_argument("--lr", type=float, default=5e-4)
    parser.add_argument("--temperature", type=float, default=0.1)
    parser.add_argument("--clip-model", default="ViT-B/32")
    args = parser.parse_args(argv)

    try:
        import numpy as np
        import torch
        import torch.nn as nn
        import torch.nn.functional as F
        from torch.utils.data import Dataset, DataLoader, Sampler
        from torchvision import transforms
        from PIL import Image
        import clip
    except ImportError as e:
        raise SystemExit(
            f"missing dependency: {e}\n"
            "install with:\n"
            "    pip install torch torchvision pillow git+https://github.com/openai/CLIP.git"
        )

    DEVICE = ("mps" if torch.backends.mps.is_available()
              else "cuda" if torch.cuda.is_available() else "cpu")
    print(f"[train] device={DEVICE}", flush=True)

    refs = Path(args.refs)
    if not refs.is_dir():
        raise SystemExit(f"refs folder not found: {refs}")

    print(f"[train] loading CLIP {args.clip_model} …", flush=True)
    clip_model, clip_preprocess = clip.load(args.clip_model, device=DEVICE)
    clip_model.eval()
    for p in clip_model.parameters():
        p.requires_grad = False

    class CardDataset(Dataset):
        def __init__(self, folder: Path, augs_per_card: int):
            files = sorted(f for f in os.listdir(folder)
                           if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
            if not files:
                raise SystemExit(f"no images in {folder}")
            self.images = []
            for f in files:
                self.images.append(Image.open(folder / f).convert("RGB"))
            self.aug_per_card = augs_per_card
            self.aug = transforms.Compose([
                transforms.RandomResizedCrop(256, scale=(0.6, 1.0), ratio=(0.7, 1.4)),
                transforms.RandomRotation(20),
                transforms.ColorJitter(brightness=0.3, contrast=0.3, saturation=0.3, hue=0.05),
                transforms.RandomPerspective(distortion_scale=0.2, p=0.5),
                transforms.RandomApply([transforms.GaussianBlur(5, sigma=(0.1, 2.0))], p=0.3),
                transforms.RandomGrayscale(p=0.05),
            ])

        def __len__(self):
            return len(self.images) * self.aug_per_card

        def __getitem__(self, idx):
            card_idx = idx % len(self.images)
            return clip_preprocess(self.aug(self.images[card_idx])), card_idx

    class KCardsSampler(Sampler):
        def __init__(self, dataset, k_cards: int, m_augs: int, steps: int):
            self.n = len(dataset.images)
            self.k = k_cards
            self.m = m_augs
            self.steps = steps

        def __iter__(self):
            for _ in range(self.steps):
                cards = random.sample(range(self.n), self.k)
                batch = []
                for c in cards:
                    for _ in range(self.m):
                        batch.append(c)
                random.shuffle(batch)
                yield from batch

        def __len__(self):
            return self.steps * self.k * self.m

    class ProjectionHead(nn.Module):
        def __init__(self, in_dim=512, hidden=512, out_dim=256):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(in_dim, hidden), nn.GELU(), nn.Linear(hidden, out_dim))

        def forward(self, x):
            return F.normalize(self.net(x), dim=-1)

    def supcon_loss(features: "torch.Tensor", labels: "torch.Tensor", temperature: float) -> "torch.Tensor":
        device = features.device
        bsz = features.size(0)
        labels = labels.contiguous().view(-1, 1)
        mask = torch.eq(labels, labels.T).float().to(device)
        sim = torch.matmul(features, features.T) / temperature
        sim_max, _ = torch.max(sim, dim=1, keepdim=True)
        logits = sim - sim_max.detach()
        self_mask = torch.scatter(
            torch.ones_like(mask), 1,
            torch.arange(bsz, device=device).view(-1, 1), 0)
        pos_mask = mask * self_mask
        exp_logits = torch.exp(logits) * self_mask
        log_prob = logits - torch.log(exp_logits.sum(1, keepdim=True) + 1e-12)
        pos_count = pos_mask.sum(1)
        pos_count = torch.where(pos_count == 0, torch.ones_like(pos_count), pos_count)
        return -((pos_mask * log_prob).sum(1) / pos_count).mean()

    print(f"[train] dataset from {refs}", flush=True)
    ds = CardDataset(refs, augs_per_card=args.m_augs)
    print(f"[train]   {len(ds.images)} reference images", flush=True)

    sampler = KCardsSampler(ds, k_cards=args.k_cards, m_augs=args.m_augs,
                            steps=args.steps_per_epoch)
    loader = DataLoader(ds, batch_size=args.k_cards * args.m_augs,
                        sampler=sampler, num_workers=0, drop_last=True)

    head = ProjectionHead(in_dim=512, hidden=512, out_dim=256).to(DEVICE)
    print(f"[train] projection head: {sum(p.numel() for p in head.parameters()):,} params", flush=True)

    optimizer = torch.optim.AdamW(head.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=args.epochs * args.steps_per_epoch)

    print(f"\n[train] {args.epochs} epochs · {args.steps_per_epoch} steps · "
          f"batch={args.k_cards * args.m_augs} (K={args.k_cards}×M={args.m_augs})\n", flush=True)
    t0 = time.time()
    for epoch in range(args.epochs):
        head.train()
        epoch_loss, n_batches = 0.0, 0
        for imgs, labels in loader:
            imgs = imgs.to(DEVICE)
            labels = labels.to(DEVICE)
            with torch.no_grad():
                feats = clip_model.encode_image(imgs).float()
                feats = feats / feats.norm(dim=-1, keepdim=True)
            proj = head(feats)
            loss = supcon_loss(proj, labels, temperature=args.temperature)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            scheduler.step()
            epoch_loss += loss.item()
            n_batches += 1
        print(f"[train]   epoch {epoch + 1:2d}/{args.epochs}  loss={epoch_loss / max(n_batches, 1):.4f}  "
              f"({time.time() - t0:.0f}s)", flush=True)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "state_dict": head.state_dict(),
        "in_dim": 512, "hidden": 512, "out_dim": 256,
        "model": args.clip_model,
        "epochs": args.epochs, "k_cards": args.k_cards, "m_augs": args.m_augs,
        "ref_count": len(ds.images),
    }, out_path)
    print(f"\n[train] ✓ saved {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
