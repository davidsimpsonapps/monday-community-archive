#!/usr/bin/env python3
"""
Scraper for https://aa6d7-service-5-df0f5160.us.monday.app/

Strategy:
  1. Mirror the frontend (HTML, JS, CSS, assets) with wget
  2. Discover topics and save them in one pass — either via a listing endpoint
     or by enumerating IDs (7–130000) with 10 concurrent workers, saving each
     response immediately on hit so there's no separate fetch pass.
  3. Fetch every other API endpoint the frontend calls and save as flat JSON files
     at the exact same URL paths, so the existing JS works with zero changes.

Output layout (./dist/):
  dist/
    index.html          (and all other frontend assets, mirrored)
    api/
      categories.json         → GET /api/categories
      tags.json               → GET /api/tags
      topics/
        list.json             → GET /api/topics/list  (index of all topics)
        <id>.json             → GET /api/topics/<id>  (one per topic)

Serve locally with:  python3 -m http.server 8080 --directory dist
Then open:           http://localhost:8080/
"""

import json
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin

import requests

# ── Config ────────────────────────────────────────────────────────────────────

BASE_URL     = "https://aa6d7-service-5-df0f5160.us.monday.app"
DIST         = Path("dist")
API_DIR      = DIST / "api"
TOPICS_DIR   = API_DIR / "topics"
WORKERS      = 10     # concurrent threads for enumeration
REPORT_EVERY = 500    # print progress every N IDs checked
SESSION      = requests.Session()
SESSION.headers.update({"User-Agent": "Mozilla/5.0 (archive-scraper/1.0)"})

# Known API endpoints to fetch (besides individual topics)
LISTING_ENDPOINTS = [
    "/api/categories",
    "/api/tags",
    "/api/topics/list",
    "/api/topics/featured",
    "/api/topics/popular",
]

# ── Helpers ───────────────────────────────────────────────────────────────────

def get_json(path: str, params: dict = None) -> Optional[dict]:
    """GET a JSON endpoint, return parsed dict or None on failure."""
    url = urljoin(BASE_URL, path)
    try:
        r = SESSION.get(url, params=params, timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  SKIP {path}: {e}")
        return None


def save_json(dest: Path, data):
    """Write data as pretty JSON to dest, creating parent dirs."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(f"  saved {dest}")


# ── Step 1 — Mirror frontend assets ──────────────────────────────────────────

def mirror_frontend():
    """
    Use wget to mirror the entire frontend.
    This grabs index.html, all JS/CSS bundles, images, fonts, etc.
    wget's --convert-links rewrites internal hrefs to be relative,
    so the mirrored site works when served from dist/.
    """
    print("\n=== Step 1: Mirroring frontend assets with wget ===")
    DIST.mkdir(exist_ok=True)

    cmd = [
        "wget",
        "--mirror",
        "--no-parent",
        "--page-requisites",
        "--convert-links",
        "--adjust-extension",
        "--no-host-directories",
        "--directory-prefix", str(DIST),
        "--reject-regex", r"/api/",
        "--quiet",
        "--show-progress",
        BASE_URL + "/",
    ]
    print("  running:", " ".join(cmd))
    result = subprocess.run(cmd)
    if result.returncode not in (0, 8):
        print(f"  wget exited with code {result.returncode} — check output above")
    else:
        print("  frontend mirror complete")


# ── Step 2 — Discover & fetch topics in one pass ──────────────────────────────

def discover_and_fetch_topics():
    """
    Try the listing endpoint first.  If it returns a usable ID list, fetch
    each topic from that list (skipping already-cached files).

    Otherwise enumerate IDs 7–130000 using a thread pool: each worker
    makes one request and — if it gets a 200 — immediately saves the JSON.
    No separate fetch pass needed.
    """
    print("\n=== Step 2: Discovering & fetching topics ===")
    TOPICS_DIR.mkdir(parents=True, exist_ok=True)

    # ── Try listing endpoint first ────────────────────────────────────────────
    for list_path in ["/api/topics/list", "/api/topics"]:
        data = get_json(list_path)
        if data is None:
            continue
        rows = data if isinstance(data, list) else data.get("topics", [])
        if rows and isinstance(rows[0], dict) and "id" in rows[0]:
            ids = [r["id"] for r in rows]
            print(f"  found {len(ids)} topics from {list_path}")
            save_json(API_DIR / "topics" / "list.json", data)

            # Fetch each topic, skipping cached ones
            for i, tid in enumerate(ids):
                dest = TOPICS_DIR / f"{tid}.json"
                if dest.exists():
                    print(f"  [{i+1}/{len(ids)}] {tid} cached, skipping")
                    continue
                print(f"  [{i+1}/{len(ids)}] fetching {tid}…")
                topic = get_json(f"/api/topics/{tid}")
                if topic:
                    save_json(dest, topic)
            return

    # ── Fallback: concurrent enumeration 7–130000 ────────────────────────────
    print(f"  listing endpoint unavailable — enumerating 7–130000 with {WORKERS} workers")

    PROBE_START = 7
    PROBE_END   = 130000

    found     = []
    completed = 0
    lock      = threading.Lock()

    def probe_and_save(tid):
        nonlocal completed
        dest = TOPICS_DIR / f"{tid}.json"

        # Already cached from a previous run — count it and move on
        if dest.exists():
            with lock:
                completed += 1
                found.append(tid)
            return tid

        url = urljoin(BASE_URL, f"/api/topics/{tid}")
        try:
            r = SESSION.get(url, timeout=10)
            if r.status_code == 200:
                data = r.json()
                save_json(dest, data)
                with lock:
                    completed += 1
                    found.append(tid)
                return tid
        except Exception:
            pass

        with lock:
            completed += 1
        return None

    total = PROBE_END - PROBE_START + 1
    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = [executor.submit(probe_and_save, tid)
                   for tid in range(PROBE_START, PROBE_END + 1)]
        for future in as_completed(futures):
            with lock:
                c = completed
            if c % REPORT_EVERY == 0:
                with lock:
                    f = len(found)
                pct = c / total * 100
                print(f"  progress: {c:,}/{total:,} checked ({pct:.1f}%), {f:,} topics saved…")

    print(f"  enumeration complete — found {len(found):,} topics")


# ── Step 3 — Fetch listing / meta endpoints ───────────────────────────────────

def fetch_listing_endpoints():
    print("\n=== Step 3: Fetching listing & meta endpoints ===")
    for path in LISTING_ENDPOINTS:
        data = get_json(path)
        if data is None:
            continue
        rel  = path.lstrip("/")
        dest = DIST / (rel + ".json")
        save_json(dest, data)
        time.sleep(0.2)


# ── Step 4 — Patch the JS to use flat JSON files ─────────────────────────────

def patch_js():
    """
    The frontend fetches e.g. /api/topics/124483 (no .json extension).
    Patch the JS bundles to append .json so they match the flat files.
    """
    print("\n=== Step 4: Patching JS bundles to append .json to API paths ===")

    js_files = list(DIST.rglob("*.js"))
    print(f"  found {len(js_files)} JS files")

    patched = 0
    for js_path in js_files:
        text = js_path.read_text(errors="replace")

        # Static string literals:  "/api/foo/bar"  →  "/api/foo/bar.json"
        new_text = re.sub(
            r'(["\'])(/api/[^"\'?#]+?)(\1)',
            lambda m: m.group(1) + m.group(2) + ".json" + m.group(3)
                      if not m.group(2).endswith(".json") else m.group(0),
            text,
        )

        # Template literals:  `/api/topics/${id}`  →  `/api/topics/${id}.json`
        new_text = re.sub(
            r'(`/api/[^`]*?`)' ,
            lambda m: m.group(0)[:-1] + ".json`"
                      if not m.group(0).endswith(".json`") else m.group(0),
            new_text,
        )

        if new_text != text:
            js_path.write_text(new_text)
            patched += 1
            print(f"  patched {js_path.relative_to(DIST)}")

    print(f"  patched {patched} JS files")


# ── Step 5 — Write README ─────────────────────────────────────────────────────

README = """\
# monday.com community knowledge base — static mirror

Generated by scrape.py.

## Serve locally

```bash
python3 -m http.server 8080 --directory dist
# then open http://localhost:8080/
```

## Deploy to Netlify / Vercel / GitHub Pages

Point the deployment root at the `dist/` directory.

### Netlify — handle extensionless API paths

Add `dist/_redirects`:

```
/api/*  /api/:splat.json  200
```

### nginx — handle extensionless API paths

```nginx
location /api/ {
    try_files $uri $uri.json =404;
}
```

## Keeping it up to date

Re-run `scrape.py` — already-cached topic JSON files are skipped,
so only new topics are downloaded.

## Structure

```
dist/
  index.html
  assets/          ← JS, CSS, fonts (mirrored as-is)
  api/
    categories.json
    tags.json
    topics/
      list.json    ← index of all topics
      124483.json  ← individual topic + all posts
      ...
```
"""

def write_readme():
    (DIST / "README.md").write_text(README)
    print("\n  wrote dist/README.md")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"Scraping {BASE_URL} → {DIST}/")

    mirror_frontend()
    fetch_listing_endpoints()
    discover_and_fetch_topics()
    patch_js()
    write_readme()

    print("\n✅ Done!  Serve with:  python3 -m http.server 8080 --directory dist")


if __name__ == "__main__":
    if shutil.which("wget") is None:
        print("Error: wget not found.  Install with:  brew install wget")
        sys.exit(1)
    main()
