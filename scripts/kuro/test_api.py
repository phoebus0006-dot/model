import sys
sys.stdout.reconfigure(line_buffering=True)
import json

urls = [
    "https://myfigurecollection.net/api/item/1675109",
    "https://myfigurecollection.net/item/1675109.json",
    "https://myfigurecollection.net/api/v1/items/1675109",
    "https://myfigurecollection.net/api/items?type=item&id=1675109",
]

import subprocess
for url in urls:
    print(f"\nTrying: {url}", flush=True)
    result = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-H",
         "User-Agent: Mozilla/5.0", "-H", "Accept: application/json",
         "--max-time", "10", url],
        capture_output=True, text=True, timeout=15
    )
    print(f"  Status: {result.stdout}", flush=True)

print("\n\nTrying browse API...", flush=True)
browse_urls = [
    "https://myfigurecollection.net/browse.v4.php?tb=item&page=1&mode=onfire",
    "https://myfigurecollection.net/api/browse?tb=item&page=1",
]
for url in browse_urls:
    print(f"\nTrying: {url}", flush=True)
    result = subprocess.run(
        ["curl", "-s", "-H", "User-Agent: Mozilla/5.0", "-H", "Accept: application/json",
         "--max-time", "10", url],
        capture_output=True, text=True, timeout=15
    )
    status = result.stdout[:200] if result.stdout else "empty"
    print(f"  Response: {status}", flush=True)
