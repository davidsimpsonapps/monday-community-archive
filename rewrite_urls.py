#!/usr/bin/env python3
"""
rewrite_urls.py

Rewrites community.monday.com topic URLs inside every topic's cookedHtml
to use the local hash-router format.

  Before:
    https://community.monday.com/t/some-slug/113350
    https://community.monday.com/t/some-slug/113350/3

  After:
    /#/t/113350
    /#/t/113350/3

Edits dist/api/topics/*.json in place.
Already-rewritten files are skipped (idempotent).
"""

import json
import re
from pathlib import Path

TOPICS_DIR = Path("dist/api/topics")

# Matches the full community URL, capturing the numeric ID and optional /N post anchor
# e.g. https://community.monday.com/t/any-slug-here/113350/3
PATTERN = re.compile(
    r'https?://community\.monday\.com/t/[^/"\'>\s]+/(\d+)(/\d+)?',
    re.IGNORECASE,
)

def rewrite(text: str) -> str:
    def replacement(m):
        topic_id  = m.group(1)
        post_part = m.group(2) or ""   # e.g. "/3" or ""
        return f"/#/t/{topic_id}{post_part}"
    return PATTERN.sub(replacement, text)

def process_file(path: Path) -> bool:
    """Return True if file was modified."""
    raw = path.read_text(encoding="utf-8")
    updated = rewrite(raw)
    if updated == raw:
        return False
    path.write_text(updated, encoding="utf-8")
    return True

def main():
    files = sorted(TOPICS_DIR.glob("*.json"))
    if not files:
        print(f"No JSON files found in {TOPICS_DIR}")
        return

    print(f"Processing {len(files):,} topic files…")
    modified = 0
    for i, f in enumerate(files):
        if i % 2000 == 0:
            print(f"  {i:,}/{len(files):,}…")
        if process_file(f):
            modified += 1

    print(f"\nDone — {modified:,} of {len(files):,} files updated.")

if __name__ == "__main__":
    main()
