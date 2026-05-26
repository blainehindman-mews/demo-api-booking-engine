"""Download the Pexels hero videos for the Cascadian booking engine.

All videos are freely licensed under the Pexels license.
Run once: `python download_videos.py`
"""

import os
import sys
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "assets", "videos")

# (filename, pexels page id, author credit) — playback order top→bottom
VIDEOS = [
    ("hero-4-seattle-sunrise.mp4",    "29042800", "JeetsVids"),
    ("hero-3-seattle-from-ferry.mp4", "37228020", "Climate And Transit"),
    ("hero-5-diablo-lake.mp4",        "15049330", "Thomas K"),
    ("hero-6-mt-rainier.mp4",         "18668098", "Dean Diemert"),
    ("hero-7-seattle-sailboat.mp4",   "29024558", "JeetsVids"),
]

UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
}


def download_one(filename: str, page_id: str, credit: str) -> bool:
    out_path = os.path.join(OUT_DIR, filename)
    if os.path.exists(out_path) and os.path.getsize(out_path) > 100_000:
        print(f"  [SKIP] {filename} already exists ({os.path.getsize(out_path) // 1024} KB)")
        return True

    # Pexels public download endpoint — follows redirects to the actual MP4 on their CDN.
    url = f"https://www.pexels.com/download/video/{page_id}/"
    try:
        with requests.get(url, headers=UA, stream=True, allow_redirects=True, timeout=60) as r:
            r.raise_for_status()
            ctype = r.headers.get("Content-Type", "")
            if "video" not in ctype and "octet" not in ctype:
                print(f"  [WARN] {filename}: unexpected Content-Type '{ctype}' — saving anyway")
            total = 0
            with open(out_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=1 << 16):
                    f.write(chunk)
                    total += len(chunk)
            print(f"  [OK]   {filename}  ({total // 1024} KB)  credit: {credit}")
            return True
    except Exception as e:
        print(f"  [FAIL] {filename}: {e}")
        if os.path.exists(out_path):
            os.remove(out_path)
        return False


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"Downloading {len(VIDEOS)} Pexels videos to {OUT_DIR}\n")
    ok = sum(download_one(*v) for v in VIDEOS)
    print(f"\n{ok}/{len(VIDEOS)} downloaded.")
    return 0 if ok == len(VIDEOS) else 1


if __name__ == "__main__":
    sys.exit(main())
