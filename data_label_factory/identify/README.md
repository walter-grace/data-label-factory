# `data_label_factory.identify` — open-set image retrieval

The companion to the main labeling pipeline. Where the base
`data_label_factory` produces COCO labels for training a closed-set
**detector**, this subpackage produces a CLIP-based **retrieval index** for
open-set **identification** — given a known set of N reference images,
identify which one a webcam frame is showing.

**Use this when:**

- You have **1 image per class** (a product catalog, a card collection, an
  art portfolio, a parts diagram, …) and want a "what is this thing I'm
  holding up?" tool.
- You want **zero training time** by default and the option to fine-tune for
  more accuracy.
- You want to **add new items in seconds** by dropping a JPG in a folder
  and re-indexing.
- You want **rarity / variant detection** for free — different prints of
  the same item indexed under filenames that encode the variant.

**Use the base pipeline instead when:**

- You need to detect multiple object instances per image with bounding boxes
- Your objects appear in cluttered scenes and need a real detector
- You have many images per class and want a closed-set classifier

---

## The 4-step blueprint (works for ANY image set)

This is the entire workflow. Replace `~/my-collection/` with your reference
folder and you're done.

### Step 0 — install (one-time, ~1 min)

```bash
pip install -e ".[identify]"
# This pulls torch, pillow, clip, fastapi, ultralytics, and uvicorn
```

### Step 1 — gather references (5–30 min depending on source)

You need **one image per class**. The filename becomes the label, so be
deliberate:

```
~/my-collection/
├── blue_eyes_white_dragon.jpg
├── dark_magician.jpg
├── exodia_the_forbidden_one.jpg
└── ...
```

**Naming rules:**

- The filename stem (minus extension) becomes the displayed label.
- Optional set-code prefixes are auto-stripped: `LOCH-JP001_dark_magician.jpg`
  → `Dark Magician`.
- Optional rarity suffixes are extracted as a separate field if they match
  one of: `pscr`, `scr`, `ur`, `sr`, `op`, `utr`, `cr`, `ea`, `gmr`. Example:
  `dark_magician_pscr.jpg` → name=`Dark Magician`, rarity=`PScR`.
- Underscores become spaces, then title-cased.

**Where to get reference images:**

| Domain | Source |
|---|---|
| Trading cards | ygoprodeck (Yu-Gi-Oh!), Pokémon TCG API, Scryfall (MTG), yugipedia |
| Products | Amazon listing main image, manufacturer site |
| Art / paintings | Wikimedia Commons, museum APIs |
| Industrial parts | Manufacturer catalog scrapes |
| Faces | Selfies (with permission!) |
| Album covers | MusicBrainz cover art archive |
| Movie posters | TMDB API |

**You can mix sources** — e.g. include both English and Japanese versions of
the same card under different filenames. The retrieval system treats them as
separate references but the cosine match will pick whichever is closer to
your live input.

### Step 2 — build the index (10 sec)

```bash
python3 -m data_label_factory.identify index \
    --refs ~/my-collection/ \
    --out my-index.npz
```

This CLIP-encodes every image and saves the embeddings to a single `.npz`
file (~300 KB for 150 references). On Apple Silicon MPS this is ~50 ms per
image — 150 images takes about 8 seconds.

**Output**: `my-index.npz` containing `embeddings`, `names`, `filenames`.

### Step 3 — verify the index (5 sec)

```bash
python3 -m data_label_factory.identify verify --index my-index.npz
```

Self-tests every reference: each one should match itself as the top-1
result. Reports:

- **Top-1 self-identification rate** (should be 100%)
- **Most-confusable pairs** — references with high mutual similarity
  (visually similar items the model might confuse at runtime)
- **Margin analysis** — the gap between "correct match" and "best wrong
  match" cosine scores. **This is the strongest predictor of live accuracy.**

**Margin guidelines:**

| Median margin | What it means | Action |
|---|---|---|
| **> 0.3** | Strong separation, live accuracy will be excellent | Ship it |
| **0.1 – 0.3** | Medium separation, expect some confusion on visually similar items | Consider Step 4 |
| **< 0.1** | References look too similar to off-the-shelf CLIP | **Run Step 4** (fine-tune) |

### Step 4 (OPTIONAL) — fine-tune the retrieval head (5–15 min)

If the verify output shows margin < 0.1, your domain (yugioh cards, MTG
cards, similar-looking product variants, …) confuses generic CLIP. Fix it
with a contrastive fine-tune:

```bash
python3 -m data_label_factory.identify train \
    --refs ~/my-collection/ \
    --out my-projection.pt \
    --epochs 12
```

**What this does:**

- Loads frozen CLIP ViT-B/32
- Trains a small **projection head** (~400k params) on top of CLIP features
- Uses **K-cards-per-batch sampling** (16 distinct classes × 4 augmentations
  = 64-image batches)
- Loss: **SupCon** (Khosla et al. 2020) — pulls augmentations of the same
  class together, pushes different classes apart
- Augmentations: random crop, rotation ±20°, color jitter, perspective warp,
  Gaussian blur, occasional grayscale
- Output: a **1.5 MB `.pt` file** containing the projection head weights

**Reference run** (150-class set, M4 Mac mini, MPS): 12 epochs in ~6 min.
Margin improvement: 0.07 → 0.36 (5× wider).

Then re-build the index with the projection head:

```bash
python3 -m data_label_factory.identify index \
    --refs ~/my-collection/ \
    --out my-index.npz \
    --projection my-projection.pt
```

And re-verify to confirm the margin actually widened:

```bash
python3 -m data_label_factory.identify verify --index my-index.npz
```

### Step 5 — serve it as an HTTP endpoint (instant)

```bash
python3 -m data_label_factory.identify serve \
    --index my-index.npz \
    --refs ~/my-collection/ \
    --projection my-projection.pt \
    --port 8500
```

This starts a FastAPI server with:

- `POST /api/falcon` — multipart `image` + `query` → JSON response in the
  same shape as `mac_tensor`'s `/api/falcon` endpoint, so it's a drop-in
  replacement for any client that talks to mac_tensor (including the
  data-label-factory `web/canvas/live` UI).
- `GET /refs/<filename>` — serves your reference images as a static mount
  so a browser UI can display "this is what the model thinks you're showing".
- `GET /health` — JSON status with index size, projection state, request
  counter, etc.

**Point the live tracker UI at it:**

```bash
# In web/.env.local
FALCON_URL=http://localhost:8500/api/falcon
```

Then open `http://localhost:3030/canvas/live` and click **Use Webcam**.

---

## Concrete examples

### Trading cards (the original use case)

```bash
# Step 1: download reference images via the gather command
data_label_factory gather --project projects/yugioh.yaml --max-per-query 1
# → produces ~/data-label-factory/yugioh/positive/cards/*.jpg

# Step 2-5: build, verify, train, serve
python3 -m data_label_factory.identify index --refs ~/data-label-factory/yugioh/positive/cards/ --out yugioh.npz
python3 -m data_label_factory.identify verify --index yugioh.npz
python3 -m data_label_factory.identify train --refs ~/data-label-factory/yugioh/positive/cards/ --out yugioh_proj.pt
python3 -m data_label_factory.identify index --refs ~/data-label-factory/yugioh/positive/cards/ --out yugioh.npz --projection yugioh_proj.pt
python3 -m data_label_factory.identify serve --index yugioh.npz --refs ~/data-label-factory/yugioh/positive/cards/ --projection yugioh_proj.pt
```

### Album covers ("Shazam for vinyl")

```bash
# Get reference images from MusicBrainz cover art archive (one per album)
mkdir ~/my-vinyl
# ... drop in jpgs named after the album ...
python3 -m data_label_factory.identify index --refs ~/my-vinyl --out vinyl.npz
python3 -m data_label_factory.identify serve --index vinyl.npz --refs ~/my-vinyl
# Hold up a record sleeve to your webcam → get the album back
```

### Industrial parts catalog ("which screw is this?")

```bash
mkdir ~/parts
# Drop in one studio shot per part: m3_bolt_10mm.jpg, hex_nut_5mm.jpg, ...
python3 -m data_label_factory.identify index --refs ~/parts --out parts.npz
python3 -m data_label_factory.identify train --refs ~/parts --out parts_proj.pt --epochs 20
python3 -m data_label_factory.identify index --refs ~/parts --out parts.npz --projection parts_proj.pt
python3 -m data_label_factory.identify serve --index parts.npz --refs ~/parts --projection parts_proj.pt
```

### Plant species ID

Same loop with reference images keyed by species name. You don't need PlantNet's
scale to be useful for **your** garden.

---

## Optional: live price feed (`scrape_prices` + UI integration)

If your reference images correspond to items with a market price (trading cards,
collectibles, parts, etc), you can plug in a live price feed and have the live
tracker UI show the price next to each identified item.

### How it works

```
scripts/scrape_prices_<your_site>.py            ← per-site adapter
        ↓
card_prices.json                                ← keyed by set code, contains JPY/USD/etc
        ↓
data_label_factory.identify serve --prices …    ← server loads it at startup
        ↓                                          + fetches live FX rate from open.er-api.com
{detection, price: {median, currency, usd_median}}  ← surfaced per detection
        ↓
web/canvas/live UI                              ← shows USD prominently in the
                                                  Active Tracks sidebar + a
                                                  Top Valuable Cards panel sorted
                                                  by USD descending
```

### Built-in scraper: yuyu-tei.jp (Japanese OCG market)

```bash
python3 -m data_label_factory.identify scrape_prices \
    --refs ~/my-cards/ \
    --out card_prices.json \
    --site yuyu-tei
```

This is the **example adapter**. Add new sites by implementing a
`_scrape_<sitename>(prefixes)` function in `scrape_prices.py` and wiring it
into the dispatcher at the bottom of the file. The output schema is
site-agnostic.

### Live tracker UI features when prices are loaded

- **Per-detection price line** in the Active Tracks sidebar — USD prominently,
  original currency underneath
- **Top Valuable Cards panel** — fetched from a new `/api/top-prices` endpoint,
  sorted by USD descending, showing the N most valuable items in your set
- **Live FX rate** — JPY/USD conversion fetched once at server startup from
  `open.er-api.com` (free, no auth)
- **Filename → name lookup** — server builds a `<set-code> → English display
  name` map from your reference filenames so the top-prices panel can show
  human-readable names alongside the codes

### Add to Deck (localStorage-backed deck builder)

The live tracker also includes a **`+ Add to Deck`** button on each active
track. Clicking it:

- Adds the identified card to a local deck (browser localStorage, no server state)
- Triggers a green flash + scale animation on the button
- Pulses the deck panel border bright emerald so you can see the card landed
- Updates the running deck total in USD
- Persists across page refreshes
- Lets you remove individual items or clear the whole deck

This is a generic feature that works for any retrieval set — useful for
"build a list of items I've identified" workflows beyond just card collecting
(inventory taking, parts pulling, plant logging, …).

---

## The data-label-factory loop, applied to retrieval

```
gather              (web search / API / phone photos)
   ↓
label               (the filename IS the label — naming convention does the work)
   ↓
verify              (data_label_factory.identify verify — self-test)
   ↓
train (optional)    (data_label_factory.identify train — fine-tune projection head)
   ↓
deploy              (data_label_factory.identify serve — HTTP endpoint)
   ↓
review              (data-label-factory web/canvas/live — sees this server as a falcon backend)
```

Same loop, same conventions, just **retrieval instead of detection**.

---

## Files in this folder

```
identify/
├── __init__.py             package marker + lazy import
├── __main__.py             enables `python3 -m data_label_factory.identify <cmd>`
├── cli.py                  argparse dispatcher for the four commands
├── train.py                Step 4: contrastive fine-tune
├── build_index.py          Step 2: CLIP encode + save index
├── verify_index.py         Step 3: self-test + margin analysis
├── serve.py                Step 5: FastAPI HTTP endpoint
└── README.md               you are here
```

---

## Why this is **lazy-loaded** (not always-on)

The base `data_label_factory` package only depends on `pyyaml`, `pillow`, and
`requests` — kept lightweight so users running the labeling pipeline don't
pay any ML import cost. The `identify` subpackage adds heavy deps (torch,
clip, ultralytics, fastapi) and is only loaded when explicitly invoked via
`python3 -m data_label_factory.identify <command>`. Same opt-in pattern as
the `runpod` subpackage.

Install the heavy deps with the optional extra:

```bash
pip install -e ".[identify]"
```
