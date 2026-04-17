"""Scrape live card prices and cache them as a JSON sidecar to the index.

This is the optional 5th step of the identify pipeline. After you've built
an index, run this to fetch current market prices for every reference card
and save them to `card_prices.json`. The serve subcommand auto-loads this
file when present and includes a `price` field on every detection's response.

Currently supports yuyu-tei.jp (Japanese OCG market). Add new sites by
implementing a `_scrape_<site>(set_prefixes) -> dict` function and wiring
it into the dispatch table at the bottom.

Output schema:
    {
      "scraped_at": "2026-04-08T19:30:00",
      "site": "yuyu-tei",
      "currency": "JPY",
      "prices": {
        "LOCR-JP066": {
          "median": 420,
          "min": 320,
          "max": 980,
          "count": 5,
          "name_jp": "No.65 裁断魔人ジャッジ・バスター",
          "rarities": {"UR": 420, "SR": 320}
        },
        ...
      }
    }
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 11_6) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/14.1.2 Safari/605.1.15"
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="data_label_factory.identify scrape_prices",
        description=(
            "Fetch current market prices for every reference card and cache "
            "them as a JSON sidecar to the index. The serve command auto-loads "
            "the cache and surfaces prices in the live tracker UI."
        ),
    )
    parser.add_argument("--refs", required=True,
                        help="Folder of reference images (filenames must start with set codes "
                             "like LOCR-JP066_<name>.jpg)")
    parser.add_argument("--out", default="card_prices.json",
                        help="Output JSON path (default: card_prices.json)")
    parser.add_argument("--site", default="yuyu-tei",
                        choices=["yuyu-tei"],
                        help="Price source to scrape")
    parser.add_argument("--max-prefixes", type=int, default=10,
                        help="Safety cap on how many distinct set prefixes to scrape")
    args = parser.parse_args(argv)

    refs = Path(args.refs)
    if not refs.is_dir():
        raise SystemExit(f"refs folder not found: {refs}")

    # Discover all distinct set prefixes from the filenames (e.g. LOCR-JP, LOCH-JP)
    prefixes: set[str] = set()
    for f in os.listdir(refs):
        m = re.match(r"^([A-Z]+-[A-Z]+)\d+_", f)
        if m:
            prefixes.add(m.group(1))

    if not prefixes:
        raise SystemExit(
            "no set-code prefixes found in filenames. expected files like "
            "'LOCR-JP066_<name>.jpg' so the scraper knows what to query."
        )

    if len(prefixes) > args.max_prefixes:
        raise SystemExit(
            f"refusing to scrape {len(prefixes)} distinct prefixes "
            f"(--max-prefixes={args.max_prefixes}). Either narrow your refs folder "
            f"or raise the cap."
        )

    print(f"[scrape] discovered {len(prefixes)} set prefixes: {sorted(prefixes)}")
    print(f"[scrape] site: {args.site}")

    if args.site == "yuyu-tei":
        records = _scrape_yuyu_tei(sorted(prefixes))
    else:
        raise SystemExit(f"unknown site: {args.site}")

    # Aggregate per set code (median, min, max across all rarities)
    per_code: dict[str, dict] = {}
    grouped: dict[str, list] = defaultdict(list)
    for r in records:
        grouped[r["code"]].append(r)
    for code, lst in grouped.items():
        prices = sorted(p["price"] for p in lst)
        n = len(prices)
        median = prices[n // 2] if n else None
        per_code[code] = {
            "median": median,
            "min": min(prices),
            "max": max(prices),
            "count": n,
            "name_jp": lst[0].get("name", ""),
            "rarities": {p["rarity"]: p["price"] for p in lst},
        }

    out = {
        "scraped_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "site": args.site,
        "currency": "JPY",
        "prices": per_code,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"\n[scrape] ✓ wrote {out_path}")
    print(f"[scrape]   {len(per_code)} cards with prices")
    if per_code:
        print(f"[scrape]   sample:")
        for code, info in list(per_code.items())[:5]:
            print(f"     {code:14}  median ¥{info['median']:>5,}  ({info['count']} listings)  {info['name_jp'][:40]}")
    return 0


# ============================================================
# Site-specific scrapers
# ============================================================

def _scrape_yuyu_tei(prefixes: list[str]) -> list[dict]:
    """Scrape yuyu-tei.jp by set prefix.

    yuyu-tei's search returns the entire booster pack list when queried with a
    set prefix like 'LOCR-JP', so we get all cards in one fetch per subset.
    """
    import urllib.request
    import urllib.parse

    listings: list[dict] = []
    for prefix in prefixes:
        url = f"https://yuyu-tei.jp/sell/ygo/s/search?word={urllib.parse.quote(prefix)}"
        print(f"[scrape] fetching {url}")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                html = r.read().decode("utf-8", errors="ignore")
        except Exception as e:
            print(f"[scrape]   error: {e}")
            continue

        # Each card listing block contains: SET-CODE RARITY NAME ... <price> 円
        # Use forward-search proximity matching with a generous window.
        pattern = re.compile(
            r"(" + re.escape(prefix) + r"\d+)\s+"
            r"(UR|SR|ScR|PScR|GMR|UtR|EA|CR|OP|N)\s+"
            r"([^\"<>]+?)\s*[\"<]"
            r".{0,8000}?"
            r"([0-9]{1,3}(?:,[0-9]{3})*)\s*円",
            re.DOTALL,
        )
        n_before = len(listings)
        seen_keys: set[tuple[str, str]] = set()
        for code, rarity, name, price_str in pattern.findall(html):
            key = (code, rarity)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            listings.append({
                "code": code,
                "rarity": rarity,
                "name": name.strip(),
                "price": int(price_str.replace(",", "")),
            })
        print(f"[scrape]   parsed {len(listings) - n_before} listings")
        time.sleep(1.0)  # be polite

    return listings


if __name__ == "__main__":
    sys.exit(main())
