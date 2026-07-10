import sys
sys.stdout.reconfigure(line_buffering=True)
import subprocess
import json

item_id = 1675109

urls = [
    f"https://webcache.googleusercontent.com/search?q=cache:myfigurecollection.net/item/{item_id}",
    f"https://web.archive.org/web/2024/https://myfigurecollection.net/item/{item_id}",
]

for url in urls:
    print(f"\nTrying: {url[:80]}...", flush=True)
    result = subprocess.run(
        ["curl", "-s", "-L", "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
         "--max-time", "15", url],
        capture_output=True, text=True, timeout=20
    )
    html = result.stdout
    if html and len(html) > 500 and "Just a moment" not in html[:500]:
        print(f"  SUCCESS! Length: {len(html)}", flush=True)
        print(f"  First 300: {html[:300]}", flush=True)
    else:
        print(f"  Failed. Length: {len(html) if html else 0}", flush=True)
        if html:
            print(f"  First 200: {html[:200]}", flush=True)
