#!/usr/bin/env python3
"""
Replace YouTube thumbnail links with proper iframes in all topic JSON files.

Before:
  <div class="youtube-onebox lazy-video-container">
    <a href="https://www.youtube.com/watch?v=VIDEO_ID" target="_blank" class="video-thumbnail" rel="...">
      <img class="youtube-thumbnail" src="..." title="TITLE" ... />
    </a>
  </div>

After:
  <div class="youtube-embed">
    <iframe width="560" height="315" src="https://www.youtube.com/embed/VIDEO_ID"
      title="TITLE" frameborder="0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen></iframe>
  </div>
"""

import json
import re
import glob
import sys
from pathlib import Path

TOPICS_DIR = Path(__file__).parent / "dist/api/topics"

# Matches the full outer div wrapping a YouTube thumbnail link.
# Captures the entire block; video ID and title are extracted separately inside replacer.
PATTERN = re.compile(
    r'<div[^>]*class="youtube-onebox[^"]*"[^>]*>\s*'
    r'<a\s[^>]*class="video-thumbnail"[^>]*>\s*'
    r'<img[^>]*/?\s*>\s*'
    r'</a>\s*'
    r'</div>',
    re.DOTALL,
)

VIDEO_ID_RE = re.compile(r'href="https://www\.youtube\.com/watch\?v=([^"&]+)')
TITLE_RE = re.compile(r'\btitle="([^"]*)"')

# Strips legacy width/height attrs from already-converted iframes
IFRAME_DIMS_RE = re.compile(r'\s*(?:width|height)="\d+"')


def make_embed(video_id: str, title: str) -> str:
    safe_title = title.replace('"', "&quot;")
    return (
        f'<div class="youtube-embed">\n'
        f'  <iframe '
        f'src="https://www.youtube.com/embed/{video_id}" '
        f'title="{safe_title}" frameborder="0" '
        f'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" '
        f'allowfullscreen></iframe>\n'
        f'</div>'
    )


def process_file(path: Path, dry_run: bool = False) -> int:
    with open(path) as fh:
        data = json.load(fh)

    changed = 0
    for post in data.get("posts", []):
        html = post.get("cookedHtml", "")

        # Strip width/height from already-converted iframes inside youtube-embed divs
        if 'youtube-embed' in html:
            def strip_dims(m: re.Match) -> str:
                nonlocal changed
                cleaned = IFRAME_DIMS_RE.sub("", m.group(0))
                if cleaned != m.group(0):
                    changed += 1
                return cleaned
            html = re.sub(
                r'<iframe[^>]*>',
                strip_dims,
                html,
            )
            post["cookedHtml"] = html

        if "video-thumbnail" not in html:
            continue

        def replacer(m: re.Match) -> str:
            nonlocal changed
            block = m.group(0)
            vid_match = VIDEO_ID_RE.search(block)
            if not vid_match:
                return block  # leave unchanged if we can't extract an ID
            video_id = vid_match.group(1)
            title_match = TITLE_RE.search(block)
            title = title_match.group(1) if title_match else ""
            changed += 1
            return make_embed(video_id, title)

        new_html = PATTERN.sub(replacer, html)
        if new_html != html:
            post["cookedHtml"] = new_html

    if changed and not dry_run:
        with open(path, "w") as fh:
            json.dump(data, fh, ensure_ascii=False)

    return changed


def main():
    dry_run = "--dry-run" in sys.argv
    files = sorted(TOPICS_DIR.glob("*.json"))

    total_files = 0
    total_replacements = 0

    for path in files:
        count = process_file(path, dry_run=dry_run)
        if count:
            total_files += 1
            total_replacements += count
            print(f"{'[dry-run] ' if dry_run else ''}{'Replaced' if not dry_run else 'Would replace'} {count} embed(s) in {path.name}")

    print(f"\n{'[dry-run] ' if dry_run else ''}Done: {total_replacements} replacement(s) across {total_files} file(s).")


if __name__ == "__main__":
    main()
