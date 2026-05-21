#!/usr/bin/env python3
"""
Fetches category topic pages and patches app.js.
Run this from the same folder as your existing dist/ directory.
"""

import json
import re
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin

import requests

# ── Config ────────────────────────────────────────────────────────────────────

BASE_URL  = "https://aa6d7-service-5-df0f5160.us.monday.app"
DIST      = Path("dist")
API_DIR   = DIST / "api"
PAGE_SIZE = 50
SESSION   = requests.Session()
SESSION.headers.update({"User-Agent": "Mozilla/5.0 (archive-scraper/1.0)"})

# ── Helpers ───────────────────────────────────────────────────────────────────

def get_json(path: str, params: dict = None) -> Optional[dict | list]:
    url = urljoin(BASE_URL, path)
    try:
        r = SESSION.get(url, params=params, timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  SKIP {path}: {e}")
        return None


def save_json(dest: Path, data):
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(f"  saved {dest}")


def category_page_filename(offset: int, limit: int) -> str:
    return f"topics__offset_{offset}__limit_{limit}.json"


# ── Fetch category topic pages ────────────────────────────────────────────────

def fetch_category_topics(categories: list):
    print(f"\n=== Fetching category topic pages (page size {PAGE_SIZE}) ===")

    for cat in categories:
        cid   = cat["id"]
        name  = cat["name"]
        total = cat.get("topic_count", "?")
        print(f"\n  Category {cid} — {name} (~{total} topics)")

        cat_dir = API_DIR / "categories" / str(cid)
        offset  = 0

        while True:
            filename = category_page_filename(offset, PAGE_SIZE)
            dest     = cat_dir / filename

            if dest.exists():
                cached     = json.loads(dest.read_text())
                page_total = cached.get("total", 0)
                items_len  = len(cached.get("items", []))
                print(f"    offset={offset} cached ({items_len} items, total={page_total})")
            else:
                data = get_json(
                    f"/api/categories/{cid}/topics",
                    params={"offset": offset, "limit": PAGE_SIZE},
                )
                if data is None:
                    print(f"    offset={offset} failed — stopping this category")
                    break

                save_json(dest, data)
                page_total = data.get("total", 0)
                items_len  = len(data.get("items", []))
                time.sleep(0.2)

            offset += items_len

            if items_len == 0 or offset >= page_total:
                print(f"    done ({offset} of {page_total})")
                break


# ── Patch app.js ──────────────────────────────────────────────────────────────

OLD_FETCH_FN = """\
async function fetchCategoryPage(categoryId) {
  const { offset } = categoryPaging;
  return api(`/api/categories/${categoryId}/topics.json?offset=${offset}&limit=${PAGE_SIZE}.json`);
}"""

NEW_FETCH_FN = """\
async function fetchCategoryPage(categoryId) {
  const { offset } = categoryPaging;
  // Flat static file — query params encoded into filename by scraper
  return api(`/api/categories/${categoryId}/topics__offset_${offset}__limit_${PAGE_SIZE}.json`);
}"""

def patch_js():
    print("\n=== Patching fetchCategoryPage in JS ===")

    js_files = list(DIST.rglob("*.js"))
    patched  = 0

    for js_path in js_files:
        text = js_path.read_text(errors="replace")
        if "fetchCategoryPage" not in text:
            continue

        if OLD_FETCH_FN in text:
            js_path.write_text(text.replace(OLD_FETCH_FN, NEW_FETCH_FN))
            print(f"  patched {js_path.relative_to(DIST)}")
            patched += 1
        else:
            new_text = re.sub(
                r'async function fetchCategoryPage\(categoryId\)\s*\{[^}]+\}',
                NEW_FETCH_FN,
                text,
                flags=re.DOTALL,
            )
            if new_text != text:
                js_path.write_text(new_text)
                print(f"  patched (regex) {js_path.relative_to(DIST)}")
                patched += 1
            else:
                print(f"  WARNING: found fetchCategoryPage in {js_path.name} but couldn't patch — inspect manually")

    if patched == 0:
        print("  WARNING: fetchCategoryPage not found in any JS file")
    else:
        print(f"  {patched} file(s) patched")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    cats_path = API_DIR / "categories.json"
    if not cats_path.exists():
        print(f"Error: {cats_path} not found — make sure dist/ is in the current folder")
        raise SystemExit(1)

    categories = json.loads(cats_path.read_text())
    print(f"Loaded {len(categories)} categories from {cats_path}")

    fetch_category_topics(categories)
    patch_js()
    print("\n✅ Done!")


if __name__ == "__main__":
    main()
