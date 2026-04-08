#!/usr/bin/env python3
"""
gather_v2.py — smarter, parallel image gatherer for the drone-falcon dataset.

Improvements over gather_images.py (v1):
  - Parallel downloads (50 threads instead of sequential)
  - YouTube frame extraction via yt-dlp + ffmpeg (the killer feature for combat footage)
  - Optional inline Qwen filter — only saves images Qwen says YES to
  - Perceptual-hash dedup across sources (catches the same image from different sites)
  - Resumable via local manifest

Sources:
  - DuckDuckGo image search   (broad, noisy)
  - Wikimedia Commons         (CC, niche, slower)
  - YouTube videos / playlists (gold for combat footage)

Outputs:
  drone-dataset-v2/<bucket>/<file>.jpg     ← local mirror
  drone-dataset-v2/manifest.json           ← every file with provenance

Usage:
    # Web search only (DDG + Wikimedia)
    python3 gather_v2.py --bucket positive/fiber_spool_drone \\
        --query "fiber optic drone Ukraine" --query "tethered fpv drone" \\
        --max-per-query 100

    # YouTube frame extraction
    python3 gather_v2.py --bucket positive/fiber_spool_drone \\
        --youtube "https://youtube.com/playlist?list=ABC123" \\
        --fps 1 --max-frames-per-video 200

    # Inline Qwen filter (only saves YES images)
    python3 gather_v2.py --bucket positive/fiber_spool_drone \\
        --query "fiber optic drone" --filter
"""

import argparse
import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from PIL import Image


# ============================================================
# CONFIG
# ============================================================

USER_AGENT = "data-label-factory-gather/0.1 (research project)"
# Override via env vars (same as the rest of the factory CLI)
M4_QWEN_URL = os.environ.get("QWEN_URL", "http://localhost:8291")
QWEN_MODEL_PATH = os.environ.get(
    "QWEN_MODEL_PATH", "mlx-community/Qwen2.5-VL-3B-Instruct-4bit"
)
QWEN_FILTER_PROMPT = (
    "Look at this image. Does it show a drone, a cable spool, or a wound fiber optic cable?\n"
    "Answer with exactly one word: YES or NO.\n"
    "YES if you see ANY of: a drone, a quadcopter, a cable reel, a fiber spool, a wound cable.\n"
    "NO if the main subject is something else."
)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


# ============================================================
# DUCKDUCKGO IMAGE SEARCH (no API key)
# ============================================================


def ddg_search(query: str, max_results: int = 50) -> list:
    """Returns list of dicts: {url, source, title, page}."""
    import re
    results = []
    headers = {"User-Agent": USER_AGENT}

    # Step 1: get vqd token
    try:
        token_url = f"https://duckduckgo.com/?q={urllib.parse.quote(query)}&iax=images&ia=images"
        req = urllib.request.Request(token_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        m = re.search(r'vqd=["\']?([\d-]+)["\']?', html)
        if not m:
            return results
        vqd = m.group(1)
    except Exception as e:
        print(f"  ddg token err: {e}")
        return results

    # Step 2: paginate i.js
    seen = set()
    next_url = None
    while len(results) < max_results:
        if next_url is None:
            params = {"l": "us-en", "o": "json", "q": query, "vqd": vqd, "f": ",,,,,", "p": "1"}
            url = f"https://duckduckgo.com/i.js?{urllib.parse.urlencode(params)}"
        else:
            url = "https://duckduckgo.com" + next_url
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
        except Exception as e:
            print(f"  ddg page err: {e}")
            break
        items = data.get("results", [])
        if not items:
            break
        for it in items:
            img_url = it.get("image")
            if not img_url or img_url in seen:
                continue
            seen.add(img_url)
            results.append({
                "url": img_url,
                "source": "duckduckgo",
                "title": it.get("title", "")[:200],
                "page": it.get("url", ""),
                "license": "unknown",
                "query": query,
            })
            if len(results) >= max_results:
                break
        next_url = data.get("next")
        if not next_url:
            break
        time.sleep(0.3)
    return results


# ============================================================
# WIKIMEDIA COMMONS (CC, free)
# ============================================================


def wikimedia_search(query: str, max_results: int = 50) -> list:
    params = {
        "action": "query", "format": "json",
        "generator": "search", "gsrsearch": f"filetype:bitmap {query}",
        "gsrnamespace": "6", "gsrlimit": str(min(50, max_results)),
        "prop": "imageinfo", "iiprop": "url|extmetadata|size",
    }
    url = f"https://commons.wikimedia.org/w/api.php?{urllib.parse.urlencode(params)}"
    results = []
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"  wikimedia err: {e}")
        return results
    pages = (data.get("query") or {}).get("pages") or {}
    for _, p in pages.items():
        ii = (p.get("imageinfo") or [{}])[0]
        img_url = ii.get("url")
        if not img_url:
            continue
        ext = (ii.get("extmetadata") or {})
        license_name = (ext.get("LicenseShortName") or {}).get("value", "")
        results.append({
            "url": img_url,
            "source": "wikimedia",
            "title": p.get("title", ""),
            "page": f"https://commons.wikimedia.org/wiki/{urllib.parse.quote(p.get('title', ''))}",
            "license": license_name,
            "query": query,
        })
        if len(results) >= max_results:
            break
    return results


# ============================================================
# YOUTUBE FRAME EXTRACTION (the killer feature)
# ============================================================


def youtube_extract_frames(
    video_url: str,
    out_dir: str,
    fps: float = 1.0,
    max_frames: int = 200,
    cookies_from_browser: str = None,
) -> list:
    """Download a YouTube video, extract frames at given fps. Returns list of frame paths.
    Uses yt-dlp + ffmpeg (via imageio_ffmpeg's bundled binary).
    """
    import yt_dlp
    import imageio_ffmpeg

    ffmpeg_bin = imageio_ffmpeg.get_ffmpeg_exe()
    os.makedirs(out_dir, exist_ok=True)
    work_dir = os.path.join(out_dir, "_video_tmp")
    os.makedirs(work_dir, exist_ok=True)

    # Download with yt-dlp — android+web player clients bypass most YT bot detection
    print(f"  yt-dlp downloading: {video_url}")
    ydl_opts = {
        "format": "worstvideo[height>=480]/worst",
        "outtmpl": os.path.join(work_dir, "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
    }
    if cookies_from_browser:
        ydl_opts["cookiesfrombrowser"] = (cookies_from_browser,)
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=True)
        video_id = info.get("id", "video")
        title = info.get("title", "")
    except Exception as e:
        print(f"  yt-dlp failed: {e}")
        return []

    # Find downloaded file
    video_files = [os.path.join(work_dir, f) for f in os.listdir(work_dir) if f.startswith(video_id)]
    if not video_files:
        print(f"  no downloaded video found in {work_dir}")
        return []
    video_file = video_files[0]

    # Extract frames via ffmpeg
    print(f"  ffmpeg extracting frames at {fps} fps from {video_file}")
    frame_pattern = os.path.join(work_dir, f"{video_id}_%05d.jpg")
    cmd = [
        ffmpeg_bin, "-y", "-i", video_file,
        "-vf", f"fps={fps}",
        "-frames:v", str(max_frames),
        "-q:v", "3",
        frame_pattern,
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=600)
    except Exception as e:
        print(f"  ffmpeg failed: {e}")
        return []

    frames = sorted(f for f in os.listdir(work_dir) if f.startswith(video_id + "_") and f.endswith(".jpg"))
    out_frames = []
    for i, fr in enumerate(frames):
        src = os.path.join(work_dir, fr)
        dest = os.path.join(out_dir, f"yt_{video_id}_{i:05d}.jpg")
        shutil.move(src, dest)
        out_frames.append({
            "path": dest,
            "source": "youtube",
            "video_id": video_id,
            "video_title": title,
            "video_url": video_url,
            "frame_index": i,
            "license": "see source video",
        })

    # Clean up downloaded video
    try:
        os.unlink(video_file)
    except Exception:
        pass

    print(f"  → extracted {len(out_frames)} frames")
    return out_frames


# ============================================================
# QWEN INLINE FILTER (optional)
# ============================================================


def qwen_yes_no(image_path: str, m4_url: str = M4_QWEN_URL, timeout: int = 30) -> tuple:
    """Returns (verdict, raw_answer). verdict ∈ {YES, NO, UNKNOWN, ERROR}."""
    try:
        img = Image.open(image_path).convert("RGB")
        max_dim = 1024
        if max(img.size) > max_dim:
            ratio = max_dim / max(img.size)
            img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        payload = {
            "model": QWEN_MODEL_PATH,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    {"type": "text", "text": QWEN_FILTER_PROMPT},
                ],
            }],
            "max_tokens": 12, "temperature": 0,
        }
        req = urllib.request.Request(
            f"{m4_url}/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
        ans = data["choices"][0]["message"]["content"].strip().upper()
        first = ans.split()[0].rstrip(".,") if ans else ""
        verdict = "YES" if "YES" in first else ("NO" if "NO" in first else "UNKNOWN")
        return verdict, ans
    except Exception as e:
        return "ERROR", str(e)


# ============================================================
# DOWNLOAD + DEDUP
# ============================================================


def url_filename(url: str, source: str) -> str:
    h = hashlib.sha1(url.encode()).hexdigest()[:12]
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    if ext not in IMAGE_EXTS:
        ext = ".jpg"
    return f"{source}_{h}{ext}"


def download_one(url: str, dest: str, timeout: int = 30) -> tuple:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        if len(data) < 1024:
            return False, 0, "too small"
        with open(dest, "wb") as f:
            f.write(data)
        return True, len(data), None
    except Exception as e:
        return False, 0, str(e)


def perceptual_hash(image_path: str) -> str:
    """8x8 average-hash for fast cross-source dedup."""
    try:
        img = Image.open(image_path).convert("L").resize((8, 8), Image.LANCZOS)
        pixels = list(img.getdata())
        avg = sum(pixels) / len(pixels)
        bits = "".join("1" if p > avg else "0" for p in pixels)
        return hex(int(bits, 2))[2:].zfill(16)
    except Exception:
        return ""


# ============================================================
# MAIN
# ============================================================


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="drone-dataset-v2", help="Image output root (shared across experiments)")
    p.add_argument("--bucket", required=True, help="Bucket subpath, e.g. positive/fiber_spool_drone")
    p.add_argument("--experiment", default="",
                   help="Optional experiment name; if set, creates experiments/<YYYY-MM-DD_HHMMSS>_<name>/")
    p.add_argument("--query", action="append", default=[],
                   help="Search query (repeatable). Hits DDG + Wikimedia.")
    p.add_argument("--youtube", action="append", default=[],
                   help="YouTube video URL or playlist URL (repeatable). Extracts frames.")
    p.add_argument("--fps", type=float, default=1.0, help="Frames per second to extract from videos")
    p.add_argument("--max-frames-per-video", type=int, default=200)
    p.add_argument("--max-per-query", type=int, default=100)
    p.add_argument("--workers", type=int, default=50, help="Parallel download threads")
    p.add_argument("--filter", action="store_true",
                   help="Run Qwen YES/NO filter on each downloaded image, skip NO")
    p.add_argument("--cookies-from-browser", default=None,
                   help="For YouTube: chrome|safari|firefox — use browser cookies for age-gated/login videos")
    args = p.parse_args()

    bucket_dir = os.path.join(args.out, args.bucket)
    os.makedirs(bucket_dir, exist_ok=True)

    # Set up the dated experiment dir if requested
    experiment_dir = None
    if args.experiment or "EXPERIMENT_DIR" in os.environ:
        from experiments import make_experiment_dir, write_readme, write_config, update_latest_symlink
        if "EXPERIMENT_DIR" in os.environ:
            experiment_dir = os.environ["EXPERIMENT_DIR"]
            os.makedirs(os.path.join(experiment_dir, "gather"), exist_ok=True)
        else:
            experiment_dir = make_experiment_dir(args.experiment)
            write_readme(
                experiment_dir,
                name=args.experiment,
                description=f"gather_v2 run: bucket={args.bucket}, queries={args.query}, youtube={len(args.youtube)} videos",
                params=vars(args),
            )
            write_config(experiment_dir, vars(args))
            update_latest_symlink(experiment_dir)
        manifest_path = os.path.join(experiment_dir, "gather", "manifest.json")
        print(f"Experiment dir: {experiment_dir}")
    else:
        manifest_path = os.path.join(args.out, "manifest.json")
    manifest = []
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    print(f"Resumed: {len(manifest)} files in manifest")

    # Track URL + perceptual-hash dedup sets
    seen_urls = {m["url"] for m in manifest if "url" in m}
    seen_hashes = {m["phash"] for m in manifest if m.get("phash")}

    # ===== Step 1: web search =====
    web_hits = []
    for q in args.query:
        print(f"\n[search] {q!r}")
        ddg_results = ddg_search(q, max_results=args.max_per_query)
        wiki_results = wikimedia_search(q, max_results=args.max_per_query)
        print(f"  DDG: {len(ddg_results)}  Wikimedia: {len(wiki_results)}")
        web_hits.extend(ddg_results)
        web_hits.extend(wiki_results)

    # Filter out duplicates by URL
    web_hits = [h for h in web_hits if h["url"] not in seen_urls]
    print(f"\n  {len(web_hits)} new web URLs to download (after dedup)")

    # ===== Step 2: parallel download =====
    downloaded = []
    if web_hits:
        print(f"\n[download] {len(web_hits)} files via {args.workers} threads...")
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {}
            for hit in web_hits:
                fname = url_filename(hit["url"], hit["source"])
                dest = os.path.join(bucket_dir, fname)
                if os.path.exists(dest):
                    continue
                futures[pool.submit(download_one, hit["url"], dest)] = (hit, dest)
            n_ok, n_skip, n_err = 0, 0, 0
            for fut in as_completed(futures):
                hit, dest = futures[fut]
                ok, nbytes, err = fut.result()
                if ok:
                    n_ok += 1
                    downloaded.append({**hit, "path": dest, "bytes": nbytes})
                else:
                    n_err += 1
        elapsed = time.time() - t0
        print(f"  downloaded: {n_ok} new, {n_err} errors in {elapsed:.0f}s")

    # ===== Step 3: YouTube frame extraction =====
    youtube_hits = []
    for video_url in args.youtube:
        print(f"\n[youtube] {video_url}")
        frames = youtube_extract_frames(
            video_url, bucket_dir,
            fps=args.fps, max_frames=args.max_frames_per_video,
            cookies_from_browser=args.cookies_from_browser,
        )
        youtube_hits.extend(frames)

    # ===== Step 4: dedup via perceptual hash =====
    if downloaded or youtube_hits:
        print(f"\n[dedup] computing perceptual hashes...")
        for entry in downloaded + youtube_hits:
            phash = perceptual_hash(entry["path"])
            entry["phash"] = phash
            if phash and phash in seen_hashes:
                # duplicate — remove the file
                try:
                    os.unlink(entry["path"])
                except Exception:
                    pass
                entry["dropped"] = "dup_phash"
            else:
                seen_hashes.add(phash)
        n_dropped = sum(1 for e in downloaded + youtube_hits if e.get("dropped"))
        print(f"  dropped {n_dropped} duplicates")

    # ===== Step 5: Optional Qwen filter =====
    survivors = []
    for entry in downloaded + youtube_hits:
        if entry.get("dropped"):
            continue
        if not args.filter:
            survivors.append(entry)
            continue
        verdict, raw = qwen_yes_no(entry["path"])
        entry["qwen_verdict"] = verdict
        entry["qwen_answer"] = raw
        if verdict != "YES":
            try:
                os.unlink(entry["path"])
            except Exception:
                pass
            entry["dropped"] = f"qwen_{verdict}"
        else:
            survivors.append(entry)

    # ===== Save manifest + stats =====
    for entry in downloaded + youtube_hits:
        entry["bucket"] = args.bucket
        manifest.append(entry)
    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # If we're inside an experiment dir, write stats.json next to the manifest
    if experiment_dir:
        stats = {
            "bucket": args.bucket,
            "queries": args.query,
            "youtube_urls": args.youtube,
            "web_hits_found": len(web_hits),
            "downloaded": len(downloaded),
            "youtube_frames": len(youtube_hits),
            "dropped_dup": sum(1 for e in (downloaded + youtube_hits) if e.get("dropped") == "dup_phash"),
            "dropped_qwen": sum(1 for e in (downloaded + youtube_hits) if e.get("dropped", "").startswith("qwen")),
            "survivors": len(survivors),
            "filter_enabled": args.filter,
            "manifest_total": len(manifest),
            "completed_at": datetime.now().isoformat(timespec="seconds") if 'datetime' in dir() else None,
        }
        try:
            from datetime import datetime as _dt
            stats["completed_at"] = _dt.now().isoformat(timespec="seconds")
        except Exception:
            pass
        stats_path = os.path.join(experiment_dir, "gather", "stats.json")
        with open(stats_path, "w") as f:
            json.dump(stats, f, indent=2)
        print(f"  stats:            {stats_path}")

    # ===== Summary =====
    print("\n" + "=" * 60)
    print("DONE")
    print("=" * 60)
    print(f"  bucket:           {args.bucket}")
    print(f"  web hits found:   {len(web_hits)}")
    print(f"  downloaded:       {len(downloaded)}")
    print(f"  youtube frames:   {len(youtube_hits)}")
    if args.filter:
        n_yes = sum(1 for e in downloaded + youtube_hits if e.get("qwen_verdict") == "YES")
        n_no = sum(1 for e in downloaded + youtube_hits if e.get("qwen_verdict") == "NO")
        print(f"  qwen filter:      YES={n_yes}  NO={n_no}")
    print(f"  survivors:        {len(survivors)}")
    print(f"  manifest:         {manifest_path} ({len(manifest)} total)")


if __name__ == "__main__":
    main()
