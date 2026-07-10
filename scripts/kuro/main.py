from flask import Flask, jsonify
from bs4 import BeautifulSoup
import re
import time
import json
import subprocess
import os

app = Flask(__name__)

MFC_BASE = "https://myfigurecollection.net"

def fetch_page_curl(url, retries=3):
    for attempt in range(retries):
        try:
            result = subprocess.run(
                ["curl", "-s", "-L", "--max-time", "30",
                 "-H", "Accept: application/json",
                 "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                 url],
                capture_output=True, text=True, timeout=35
            )
            html = result.stdout
            if html and "Just a moment" not in html[:500] and len(html) > 200:
                return html
            print(f"  Curl attempt {attempt+1}: blocked or empty, retrying...")
            time.sleep(3 * (attempt + 1))
        except Exception as e:
            print(f"  Curl error attempt {attempt+1}: {e}")
            time.sleep(3)
    return None

def fetch_page_playwright(url, retries=2):
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                viewport={"width": 1920, "height": 1080}
            )
            page = context.new_page()
            for attempt in range(retries):
                try:
                    page.goto(url, wait_until="networkidle", timeout=30000)
                    time.sleep(2)
                    html = page.content()
                    if "Just a moment" not in html[:500]:
                        browser.close()
                        return html
                    print(f"  Playwright attempt {attempt+1}: Cloudflare challenge detected, retrying...")
                    time.sleep(5)
                except Exception as e:
                    print(f"  Playwright attempt {attempt+1}: {e}")
                    time.sleep(3)
            browser.close()
    except ImportError:
        print("  Playwright not available, skipping")
    except Exception as e:
        print(f"  Playwright error: {e}")
    return None

def fetch_page(url, retries=3):
    html = fetch_page_curl(url, retries)
    if html:
        return html
    print("  Curl failed, trying Playwright...")
    return fetch_page_playwright(url, 2)

def parse_item_page(item_id):
    url = f"{MFC_BASE}/item/{item_id}"
    html = fetch_page(url)
    if not html:
        return None

    soup = BeautifulSoup(html, "html.parser")
    data = {"id": str(item_id)}

    og_title = soup.find("meta", property="og:title")
    if og_title:
        data["name"] = og_title.get("content", "").strip()

    if not data.get("name"):
        h1 = soup.select_one("h1")
        if h1:
            data["name"] = h1.get_text(strip=True)

    og_img = soup.find("meta", property="og:image")
    if og_img:
        data["image"] = og_img.get("content", "")

    og_desc = soup.find("meta", property="og:description")
    if og_desc:
        data["description"] = og_desc.get("content", "")

    meta_pics = soup.find("meta", attrs={"name": "pictures"})
    if meta_pics:
        try:
            pics = json.loads(meta_pics["content"])
            data["pictures"] = [p.get("src", "") for p in pics if p.get("src")]
        except Exception:
            pass

    if not data.get("pictures") and data.get("image"):
        data["pictures"] = [data["image"]]

    fields = soup.select(".form-field")
    for field in fields:
        label_el = field.select_one(".form-label")
        value_el = field.select_one(".form-input")
        if not label_el or not value_el:
            continue
        label = label_el.get_text(strip=True).lower()
        value = value_el.get_text(strip=True)

        if "scale" in label:
            match = re.search(r"1/[\d]+", value)
            if match:
                data["scale"] = match.group()
        elif "material" in label:
            data["material"] = value
        elif "price" in label or "yen" in label:
            match = re.search(r"[\d,]+", value)
            if match:
                data["price"] = int(match.group().replace(",", ""))
        elif "release" in label or "date" in label:
            match = re.search(r"(\d{4})/(\d{2})/(\d{2})", value)
            if match:
                data["release_date"] = f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
        elif "height" in label or "size" in label:
            match = re.search(r"([\d.]+)\s*cm", value)
            if match:
                data["height"] = int(float(match.group(1)) * 10)
        elif "jan" in label or "barcode" in label:
            match = re.search(r"\d{13}", value)
            if match:
                data["jan"] = match.group()
        elif "character" in label:
            link = value_el.select_one("a")
            data["character"] = link.get_text(strip=True) if link else value
        elif "company" in label or "manufacturer" in label or "maker" in label:
            link = value_el.select_one("a")
            data["manufacturer"] = link.get_text(strip=True) if link else value
        elif "origin" in label or "franchise" in label or "series" in label:
            link = value_el.select_one("a")
            data["origin"] = link.get_text(strip=True) if link else value
        elif "sculptor" in label or "artist" in label:
            links = value_el.select("a")
            data["sculptors"] = [a.get_text(strip=True) for a in links] if links else [value]
        elif "category" in label:
            data["category"] = value

    return data

def parse_browse_page(page=1):
    url = f"{MFC_BASE}/browse.v4.php?tb=item&page={page}"
    html = fetch_page(url)
    if not html:
        return []

    soup = BeautifulSoup(html, "html.parser")
    items = []

    for item_el in soup.select(".item-card, .figure-card, [data-item-id]"):
        item_id = item_el.get("data-item-id") or item_el.get("data-id")
        if item_id:
            items.append({"id": int(item_id)})

    if not items:
        for link in soup.select("a[href*='/item/']"):
            match = re.search(r"/item/(\d+)", link.get("href", ""))
            if match:
                item_id = int(match.group(1))
                if item_id not in [i["id"] for i in items]:
                    items.append({"id": item_id})

    return items

@app.route("/v1/items/<int:item_id>")
def get_item(item_id):
    data = parse_item_page(item_id)
    if data:
        return jsonify({"data": data})
    return jsonify({"error": "Item not found or blocked by Cloudflare"}), 404

@app.route("/v1/latest/<int:page>")
def get_latest(page=1):
    items = parse_browse_page(page)
    return jsonify({"items": items, "page": page})

@app.route("/v1/items/onfire")
def get_trending():
    url = f"{MFC_BASE}/browse.v4.php?tb=item&mode=onfire"
    html = fetch_page(url)
    items = []
    if html:
        soup = BeautifulSoup(html, "html.parser")
        for link in soup.select("a[href*='/item/']"):
            match = re.search(r"/item/(\d+)", link.get("href", ""))
            if match:
                items.append({"id": int(match.group(1))})
    return jsonify({"items": items})

@app.route("/v1/items/releases/<int:year>/<int:month>/<int:day>")
def get_releases(year, month, day):
    url = f"{MFC_BASE}/browse.v4.php?tb=item&mode=releases&year={year}&month={month}&day={day}"
    html = fetch_page(url)
    items = []
    if html:
        soup = BeautifulSoup(html, "html.parser")
        for link in soup.select("a[href*='/item/']"):
            match = re.search(r"/item/(\d+)", link.get("href", ""))
            if match:
                items.append({"id": int(match.group(1))})
    return jsonify({"items": items})

@app.route("/v1/health")
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9192, debug=False)
