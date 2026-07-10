import sys
sys.stdout.reconfigure(line_buffering=True)
import subprocess
from bs4 import BeautifulSoup
import json
import re

item_id = 1675109

url = f"https://web.archive.org/web/2024/https://myfigurecollection.net/item/{item_id}"
print(f"Fetching: {url}", flush=True)
result = subprocess.run(
    ["curl", "-s", "-L", "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
     "--max-time", "15", url],
    capture_output=True, text=True, timeout=20
)
html = result.stdout
print(f"Page length: {len(html)}", flush=True)

soup = BeautifulSoup(html, "html.parser")

og_title = soup.find("meta", property="og:title")
if og_title:
    print(f"OG Title: {og_title.get('content', '')}", flush=True)

og_img = soup.find("meta", property="og:image")
if og_img:
    print(f"OG Image: {og_img.get('content', '')}", flush=True)

og_desc = soup.find("meta", property="og:description")
if og_desc:
    print(f"OG Desc: {og_desc.get('content', '')[:100]}", flush=True)

fields = soup.select(".form-field")
print(f"Form fields found: {len(fields)}", flush=True)
for field in fields[:5]:
    label_el = field.select_one(".form-label")
    value_el = field.select_one(".form-input")
    if label_el and value_el:
        label = label_el.get_text(strip=True)
        value = value_el.get_text(strip=True)
        print(f"  {label}: {value}", flush=True)

h1 = soup.select_one("h1")
if h1:
    print(f"H1: {h1.get_text(strip=True)}", flush=True)
