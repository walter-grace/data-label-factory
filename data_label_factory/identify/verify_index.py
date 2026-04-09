"""Self-test the index for top-1 accuracy + report confusable pairs.

For each reference image, embed it and verify that its top-1 match in the
index is itself. Reports the cosine margin between correct and best-wrong
matches — the most useful number for predicting live accuracy.

Run this immediately after building an index to catch bad data BEFORE
deploying it to a live tracker.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="data_label_factory.identify verify",
        description=(
            "Self-test a built index. Each reference image should match itself "
            "as top-1; a wide cosine margin between correct and best-wrong matches "
            "is the strongest predictor of live accuracy."
        ),
    )
    parser.add_argument("--index", default="card_index.npz", help="Path to .npz from `index`")
    parser.add_argument("--top-confusables", type=int, default=5,
                        help="How many of the most-confusable pairs to print")
    args = parser.parse_args(argv)

    try:
        import numpy as np
    except ImportError:
        raise SystemExit("numpy required: pip install numpy")

    npz = np.load(args.index, allow_pickle=True)
    EMB = npz["embeddings"]
    NAMES = list(npz["names"])
    print(f"[verify] index: {len(NAMES)} refs × {EMB.shape[1]} dims")

    # Pairwise similarity matrix (small N, fits in memory)
    sims = EMB @ EMB.T
    np.fill_diagonal(sims, -1.0)

    # Top confusable pairs
    print(f"\nMost-confusable pairs (highest cosine sim between DIFFERENT refs):")
    flat_idx = np.argpartition(sims.flatten(), -args.top_confusables * 2)[-args.top_confusables * 2:]
    seen = set()
    shown = 0
    for fi in flat_idx[np.argsort(sims.flatten()[flat_idx])[::-1]]:
        i, j = divmod(int(fi), len(NAMES))
        if (j, i) in seen:
            continue
        seen.add((i, j))
        print(f"  {sims[i, j]:.3f}  {NAMES[i][:42]}  ↔  {NAMES[j][:42]}")
        shown += 1
        if shown >= args.top_confusables:
            break

    # Restore diagonal for self-test
    np.fill_diagonal(sims, 1.0)

    # Self-identity test: each ref's top-1 in EMB @ EMB[i] should be i
    correct = 0
    failures = []
    for i in range(len(NAMES)):
        row = EMB @ EMB[i]
        top = int(np.argmax(row))
        if top == i:
            correct += 1
        else:
            failures.append((NAMES[i], NAMES[top], float(row[top]), float(row[i])))

    pct = correct / len(NAMES) * 100
    print(f"\nself-identity test: {correct}/{len(NAMES)} = {pct:.1f}% top-1 self-id")
    for name, mismatch, score_wrong, score_right in failures[:10]:
        print(f"  ✗ {name[:42]}  →  matched {mismatch[:42]}  "
              f"(top={score_wrong:.3f} vs self={score_right:.3f})")

    # Margin analysis: gap between "I matched myself" and "best wrong match"
    correct_scores, best_wrong_scores = [], []
    for i in range(len(NAMES)):
        row = EMB @ EMB[i]
        correct_scores.append(row[i])
        row[i] = -1
        best_wrong_scores.append(row.max())

    median_correct = float(np.median(correct_scores))
    median_wrong = float(np.median(best_wrong_scores))
    margin = median_correct - median_wrong
    print(f"\nthreshold analysis:")
    print(f"  median correct match score:    {median_correct:.3f}")
    print(f"  median best-wrong-match score: {median_wrong:.3f}")
    print(f"  gap (margin):                  {margin:.3f}")
    suggested = max(0.5, median_wrong + 0.05)
    print(f"  → recommended SIM_THRESHOLD = {suggested:.2f}")
    return 0 if pct >= 99 else 1


if __name__ == "__main__":
    sys.exit(main())
