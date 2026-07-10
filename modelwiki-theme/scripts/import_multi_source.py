#!/usr/bin/env python3
"""
ModelWiki 多来源手办数据导入脚本
================================
支持来源: goodsmile, mfc, hobbysearch, amiami
功能:
  - 直接 POST /api/v1/figures 写库,跳过人工审核
  - AI 洗稿(调用 gemini-3.1-flash-lite 清洗描述)
  - 图片水印检测(有水印则不录入图片)
  - 跨来源去重(按 JAN 码 + slug)

用法:
  python3 import_multi_source.py --source mfc --limit 50 --token xxx
  python3 import_multi_source.py --source amiami --limit 100 --ai-rewrite
  python3 import_multi_source.py --source all --limit 200 --ai-rewrite
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

# ==================== 全局配置 ====================

GOODSMILE_BASE = "https://www.goodsmile.com"
GOODSMILE_LIST = f"{GOODSMILE_BASE}/en/search/list"

MFC_BASE = "https://myfigurecollection.net"
HOBBYSEARCH_BASE = "https://www.1999.co.jp"
AMIAPI_BASE = "https://api.amiami.com/api/v1.0"
AMIAMI_IMG_BASE = "https://img.amiami.com"

CATEGORY_NAMES = {
    "pvc-figure": "PVC Figure",
    "scale-figure": "Scale Figure",
    "nendoroid": "Nendoroid",
    "figma": "figma",
    "action-figure": "Action Figure",
    "plastic-model": "Plastic Model",
    "plush": "Plush",
    "other-merch": "Other Merchandise",
}

# AI 洗稿配置(从环境变量读取)
AI_BASE = os.environ.get("MODELWIKI_AI_BASE", "https://key.phoebusstudio.com/v1")
AI_KEY = os.environ.get("MODELWIKI_AI_KEY", "")
AI_MODEL = os.environ.get("MODELWIKI_REWRITE_MODEL", "gemini-3.1-flash-lite")

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "ModelWikiBot/1.0 (+https://www.phoebusstudio.com/)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
})


# ==================== 通用工具函数 ====================

def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def slugify(value: str, fallback: str = "item") -> str:
    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode("ascii")
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or fallback


def absolute_url(value: str | None, base: str = GOODSMILE_BASE) -> str:
    if not value:
        return ""
    return urljoin(base, value)


def parse_price_jpy(text: str) -> int | None:
    text = (text or "").replace(",", "")
    match = re.search(r"(?:JPY|¥|￥)\s*([0-9]+)", text, re.IGNORECASE)
    if not match:
        match = re.search(r"\b([0-9]{4,7})\b", text)
    return int(match.group(1)) if match else None


def parse_release_date(text: str) -> str | None:
    text = (text or "").strip()
    if not text:
        return None
    # MM/YYYY 或 MM-YYYY
    month_year = re.search(r"\b(0?[1-9]|1[0-2])[/.-]([0-9]{4})\b", text)
    if month_year:
        month, year = month_year.groups()
        return f"{year}-{int(month):02d}-01"
    # YYYY/MM 或 YYYY-MM
    year_month = re.search(r"\b([0-9]{4})[/.-](0?[1-9]|1[0-2])\b", text)
    if year_month:
        year, month = year_month.groups()
        return f"{year}-{int(month):02d}-01"
    # YYYY-MM-DD / YYYY/MM/DD
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%d/%m/%Y", "%B %Y", "%b %Y"):
        try:
            return datetime.strptime(text.strip(), fmt).date().isoformat()
        except ValueError:
            pass
    # 英文月份名 + 年份(如 "Aug 2027")
    month_map = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
                 "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
    for mon_str, mon_num in month_map.items():
        if re.search(rf"\b{mon_str}[a-z]*\s+(\d{{4}})\b", text, re.IGNORECASE):
            match = re.search(rf"\b{mon_str}[a-z]*\s+(\d{{4}})\b", text, re.IGNORECASE)
            if match:
                return f"{match.group(1)}-{mon_num:02d}-01"
    return None


def parse_height_mm(text: str) -> int | None:
    match = re.search(r"(?:approximately|approx\.?)?\s*([0-9]{2,4})\s*mm", text or "", re.IGNORECASE)
    return int(match.group(1)) if match else None


def parse_scale(text: str, title: str = "") -> str | None:
    haystack = f"{title} {text}"
    match = re.search(r"\b1\s*/\s*(\d{1,2})\b", haystack)
    if match:
        return f"1/{match.group(1)}"
    if re.search(r"\bnon[- ]scale\b", haystack, re.IGNORECASE):
        return "Non-scale"
    return None


def category_slug(title: str, specs: str) -> str:
    haystack = f"{title} {specs}".lower()
    if "nendoroid" in haystack:
        return "nendoroid"
    if "figma" in haystack:
        return "figma"
    if "plamatea" in haystack or "model kit" in haystack or "plastic model" in haystack:
        return "plastic-model"
    if "plush" in haystack or "stuffed" in haystack:
        return "plush"
    if re.search(r"\b1\s*/\s*\d{1,2}\b", haystack) or "scale figure" in haystack:
        return "scale-figure"
    if "action figure" in haystack:
        return "action-figure"
    return "pvc-figure"


def normalize_description(text: str) -> str:
    text = clean_text(text)
    if not text:
        return ""
    # 去除 Good Smile 常见的营销套话
    text = re.sub(r"Be sure to add.*?collection\.?", "", text, flags=re.IGNORECASE)
    sentences = re.split(r"(?<=[.!?])\s+", text)
    picked: list[str] = []
    for sentence in sentences:
        sentence = clean_text(sentence)
        if sentence and sentence not in picked:
            picked.append(sentence)
        if len(" ".join(picked)) >= 360:
            break
    return clean_text(" ".join(picked))[:900]


# ==================== 图片水印检测 ====================

def detect_watermark(image_url: str, source: str = "") -> bool:
    """
    检测图片是否有水印。返回 True 表示有水印(应跳过)。
    检测策略:
    1. URL 中包含 watermark 字样
    2. 下载图片用 Pillow 分析右下角和中央区域是否有规律性文字图案
    """
    if not image_url:
        return False

    url_lower = image_url.lower()
    if "watermark" in url_lower or "wm." in url_lower or "logo" in url_lower:
        return True

    # 来源特定规则: MFC 的缩略图通常无水印,但大图可能有
    if source == "mfc" and "/micro/" in url_lower:
        return False  # micro 缩略图太小,跳过检测

    try:
        from PIL import Image, ImageChops, ImageEnhance
        import numpy as np
    except ImportError:
        # Pillow/numpy 不可用,只做 URL 检测
        return False

    try:
        resp = SESSION.get(image_url, timeout=15)
        if resp.status_code != 200 or len(resp.content) < 1024:
            return False
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        w, h = img.size
        if w < 100 or h < 100:
            return False

        # 检测右下角区域(常见水印位置)
        right_bottom = img.crop((int(w * 0.7), int(h * 0.7), w, h))
        # 检测中央区域(常见半透明水印)
        center = img.crop((int(w * 0.25), int(h * 0.25), int(w * 0.75), int(h * 0.75)))

        # 简单检测:边缘区域与整体的颜色差异
        # 水印通常会让边缘区域出现规律性的高对比文字
        for region_name, region in [("right_bottom", right_bottom), ("center", center)]:
            arr = np.array(region)
            # 计算标准差,水印区域通常有更高的局部对比度
            std = arr.std()
            # 检测是否有明显的文字图案(边缘密集)
            if std > 60:  # 阈值可调
                # 进一步检测:边缘密度
                gray = np.mean(arr, axis=2)
                # 简单 Sobel 边缘检测
                dx = np.abs(np.diff(gray, axis=1))
                dy = np.abs(np.diff(gray, axis=0))
                edge_density = (dx.mean() + dy.mean()) / 2
                if edge_density > 25:  # 边缘密度高,可能是文字
                    print(f"  [watermark] {source} image has high edge density in {region_name}: {edge_density:.1f}", file=sys.stderr)
                    return True
        return False
    except Exception as e:
        print(f"  [watermark] detection failed for {image_url}: {e}", file=sys.stderr)
        return False


# ==================== AI 洗稿 ====================

def ai_rewrite_description(description: str, title: str = "", source: str = "") -> str:
    """
    用 AI (gemini-3.1-flash-lite) 清洗描述文本:
    - 去除营销套话和版权文字
    - 改写为客观、中性的百科风格
    - 保留关键事实(尺寸、材质、系列等)
    """
    if not description or len(description) < 20:
        return description
    if not AI_KEY or not AI_BASE:
        print("  [ai] AI_KEY or AI_BASE not configured, skipping rewrite", file=sys.stderr)
        return description

    prompt = f"""Rewrite the following figure product description into a clean, neutral, encyclopedia-style entry. Requirements:
- Remove all marketing language, promotional phrases, and call-to-action text
- Remove any copyright notices, website URLs, or watermarks text
- Keep it factual and objective
- Preserve key specifications (size, material, series, sculptor if mentioned)
- Output in English
- Keep it under 300 characters

Figure: {title}
Source: {source}
Original description:
{description}

Cleaned description:"""

    try:
        resp = SESSION.post(
            f"{AI_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {AI_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": AI_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
                "max_tokens": 200,
            },
            timeout=30,
        )
        if resp.status_code != 200:
            print(f"  [ai] rewrite failed: HTTP {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
            return description
        data = resp.json()
        cleaned = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
        if cleaned and len(cleaned) > 20:
            return cleaned[:900]
        return description
    except Exception as e:
        print(f"  [ai] rewrite error: {e}", file=sys.stderr)
        return description


# ==================== API 客户端 ====================

class ApiClient:
    def __init__(self, base_url: str, token: str = ""):
        self.base_url = base_url.rstrip("/")
        self.cache: dict[str, dict[str, Any]] = {}
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._existing_jans: set[str] | None = None

    def request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", {}) or {})
        return SESSION.request(method, self.base_url + path, timeout=90, headers=headers, **kwargs)

    def json(self, method: str, path: str, *, ok: tuple[int, ...] = (200, 201), **kwargs: Any) -> dict[str, Any]:
        response = self.request(method, path, **kwargs)
        if response.status_code not in ok:
            raise RuntimeError(f"{method} {path} failed: HTTP {response.status_code} {response.text[:300]}")
        return response.json()

    def list_entities(self, endpoint: str) -> dict[str, Any]:
        if endpoint in self.cache:
            return self.cache[endpoint]
        result = self.json("GET", f"/{endpoint}?page=1&perPage=100")
        entities = {item["slug"]: item for item in result.get("data", [])}
        self.cache[endpoint] = entities
        return entities

    def ensure_category(self, slug: str) -> int:
        categories = self.json("GET", "/categories").get("data", [])
        flat: dict[str, Any] = {}
        def visit(items: list[dict[str, Any]]) -> None:
            for item in items:
                flat[item["slug"]] = item
                visit(item.get("children") or [])
        visit(categories)
        if slug in flat:
            return int(flat[slug]["id"])
        payload = {"slug": slug, "name": CATEGORY_NAMES.get(slug, slug.replace("-", " ").title()), "sortOrder": len(flat) + 1}
        created = self.json("POST", "/categories", json=payload)
        return int(created["data"]["id"])

    def ensure_entity(self, endpoint: str, name: str, extra: dict[str, Any] | None = None) -> int:
        name = clean_text(name)
        if not name:
            name = "Unknown"
        slug = slugify(name, fallback=endpoint.rstrip("s"))
        existing = self.list_entities(endpoint).get(slug)
        if existing:
            return int(existing["id"])
        payload = {"slug": slug, "name": name, "nameEn": name}
        if extra:
            payload.update(extra)
        response = self.request("POST", f"/{endpoint}", json=payload)
        if response.status_code == 409:
            detail = self.json("GET", f"/{endpoint}/{slug}")
            entity = detail["data"]
        elif response.status_code == 201:
            entity = response.json()["data"]
        else:
            raise RuntimeError(f"POST /{endpoint} failed: HTTP {response.status_code} {response.text[:300]}")
        self.cache.setdefault(endpoint, {})[slug] = entity
        return int(entity["id"])

    def figure_exists(self, slug: str) -> bool:
        response = self.request("GET", f"/figures/{slug}")
        return response.status_code == 200

    def figure_exists_by_jan(self, jan_code: str) -> bool:
        if not jan_code:
            return False
        if self._existing_jans is None:
            self._existing_jans = set()
            page = 1
            while True:
                resp = self.json("GET", f"/figures?page={page}&perPage=100")
                items = resp.get("data", [])
                if not items:
                    break
                for item in items:
                    if item.get("janCode"):
                        self._existing_jans.add(str(item["janCode"]))
                if len(items) < 100:
                    break
                page += 1
                if page > 20:  # 最多扫 2000 条
                    break
        return jan_code in self._existing_jans

    def unique_figure_slug(self, title: str) -> str:
        base = slugify(title, fallback="figure")
        candidate = base
        suffix = 2
        while self.figure_exists(candidate):
            candidate = f"{base}-{suffix}"
            suffix += 1
        return candidate

    def create_figure(self, item: dict[str, Any]) -> dict[str, Any]:
        manufacturer_id = self.ensure_entity("manufacturers", item.get("manufacturer") or "Unknown", {"country": "JP"})
        series_id = self.ensure_entity("series", item.get("series") or "Original Character", {"mediaType": "figure"})
        category_id = self.ensure_category(item.get("category_slug") or "pvc-figure")
        sculptor_ids = []
        if item.get("sculptor"):
            sculptor_id = self.ensure_entity("sculptors", item["sculptor"], {"alias": [], "styleTags": []})
            sculptor_ids.append({"id": sculptor_id, "role": "Sculptor", "isPrimary": True})

        # JAN 码去重
        jan_code = item.get("jan_code") or item.get("janCode")
        if jan_code and self.figure_exists_by_jan(str(jan_code)):
            raise RuntimeError(f"Figure with JAN {jan_code} already exists, skipping")

        title = item["title"]
        # 图片水印检测
        images = []
        if item.get("image_url"):
            if not detect_watermark(item["image_url"], item.get("source", "")):
                images.append({"source": item["image_url"], "alt": title, "sortOrder": 0})
            else:
                print(f"  [watermark] skipping watermarked image: {item['image_url']}", file=sys.stderr)

        # 多来源 ID 字段
        multi_source_ids: dict[str, Any] = {}
        if item.get("mfc_id"):
            multi_source_ids["mfcId"] = str(item["mfc_id"])
        if item.get("amiami_id"):
            multi_source_ids["amiamiId"] = str(item["amiami_id"])
        if item.get("hobbysearch_id"):
            multi_source_ids["hobbySearchId"] = str(item["hobbysearch_id"])
        if item.get("hlj_id"):
            multi_source_ids["hljId"] = str(item["hlj_id"])

        payload: dict[str, Any] = {
            "slug": self.unique_figure_slug(title),
            "name": title,
            "nameEn": title,
            "scale": item.get("scale"),
            # material not mappable from specifications (contains full spec text, not just material)
            "priceJpy": item.get("price_jpy") or item.get("priceJpy"),
            "releaseDate": item.get("release_date") or item.get("releaseDate"),
            "heightMm": item.get("height_mm") or item.get("heightMm"),
            "janCode": jan_code or None,
            "productLine": item.get("product_line") or item.get("productLine") or None,
            "ageRating": "All Ages",
            "seriesId": series_id,
            "manufacturerId": manufacturer_id,
            "categoryIds": [category_id],
            "sculptorIds": sculptor_ids,
            "localized": [{
                "language": "en",
                "title": title,
                "origin": item.get("series") or "Original Character",
                "description": item.get("description") or item.get("specifications") or title,
            }],
            "releases": [{
                "edition": "Standard",
                "releaseDate": item.get("release_date") or item.get("releaseDate"),
                "priceJpy": item.get("price_jpy") or item.get("priceJpy"),
                "isRerelease": False,
            }],
            "images": images,
        }
        payload.update(multi_source_ids)

        for key, value in list(payload.items()):
            if value is None:
                payload.pop(key)

        return self.json("POST", "/figures", json=payload)


# ==================== Good Smile 适配器 ====================

def goodsmile_search_filter(status: str = "1", keyword: str = "") -> dict[str, Any]:
    return {
        "search_keyword": keyword,
        "search_status": status,
        "search_title": [],
        "search_category": [],
        "search_maker": [],
        "release_date_from": "",
        "release_date_to": "",
        "search_over18": False,
        "search_bonus": False,
        "search_exclusive": False,
        "search_sale": False,
        "search_sales_origin": False,
        "tag": [],
    }


def goodsmile_parse_list_html(html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "lxml")
    items: list[dict[str, Any]] = []
    for node in soup.select(".p-product-list__item"):
        link = node.select_one("a.p-product-list__link")
        href = link.get("href") if link else ""
        url = absolute_url(href, GOODSMILE_BASE)
        match = re.search(r"/product/(\d+)", url)
        product_id = match.group(1) if match else ""
        if not product_id:
            continue
        image = node.select_one(".b-product-item__image img")
        logo = node.select_one(".b-product-item__logo img")
        title_node = node.select_one(".b-product-item__title")
        price_node = node.select_one(".b-product-item__price")
        items.append({
            "source_id": product_id,
            "url": url,
            "title": clean_text(title_node.get_text(" ") if title_node else ""),
            "price_jpy": parse_price_jpy(clean_text(price_node.get_text(" ") if price_node else "")),
            "image_url": absolute_url(image.get("src") if image else "", GOODSMILE_BASE),
            "manufacturer": clean_text(logo.get("alt") if logo else ""),
            "source": "goodsmile",
        })
    return items


def goodsmile_lines_from_soup(soup: BeautifulSoup) -> list[str]:
    return [clean_text(line) for line in soup.get_text("\n").splitlines() if clean_text(line)]


def goodsmile_value_after(lines: list[str], labels: list[str]) -> str:
    label_set = {label.lower() for label in labels}
    for index, line in enumerate(lines):
        if line.lower().rstrip(":") in label_set:
            for candidate in lines[index + 1: index + 7]:
                if candidate.lower().rstrip(":") not in label_set:
                    return candidate
    return ""


def goodsmile_section_after(lines: list[str], heading: str, stops: list[str]) -> str:
    start = -1
    for index, line in enumerate(lines):
        if line.lower().rstrip(":") == heading.lower():
            start = index + 1
            break
    if start < 0:
        return ""
    stop_set = {stop.lower() for stop in stops}
    collected: list[str] = []
    for line in lines[start:]:
        if line.lower().rstrip(":") in stop_set:
            break
        collected.append(line)
    return clean_text(" ".join(collected))


def goodsmile_parse_detail_html(html: str, url: str, card: dict[str, Any]) -> dict[str, Any]:
    soup = BeautifulSoup(html, "lxml")
    lines = goodsmile_lines_from_soup(soup)
    h1 = soup.select_one("h1")
    title = clean_text(h1.get_text(" ") if h1 else "") or card.get("title", "")
    description = goodsmile_section_after(lines, "Product Description",
        ["Product Specifications", "Specifications", "Series", "Sculptor", "Manufacturer", "Distributed by", "Release Info"])
    specs = goodsmile_value_after(lines, ["Specifications", "Product Specifications"])
    if not specs:
        specs = goodsmile_section_after(lines, "Specifications", ["Sculptor", "Manufacturer", "Distributed by", "Release Info"])
    series = goodsmile_value_after(lines, ["Series"]) or "Original Character"
    sculptor = goodsmile_value_after(lines, ["Sculptor"])
    manufacturer = goodsmile_value_after(lines, ["Manufacturer"]) or card.get("manufacturer") or "Good Smile Company"
    release_text = goodsmile_value_after(lines, ["Release Date", "Shipping", "Shipment", "Release"])
    price_text = goodsmile_value_after(lines, ["Price"])
    image = soup.select_one("meta[property='og:image']")
    image_url = absolute_url(image.get("content") if image else card.get("image_url", ""), GOODSMILE_BASE)
    return {
        "source_id": card["source_id"],
        "source": "goodsmile",
        "url": url,
        "title": title,
        "description": normalize_description(description),
        "series": series,
        "manufacturer": manufacturer,
        "sculptor": sculptor,
        "specifications": specs,
        "scale": parse_scale(specs, title),
        "height_mm": parse_height_mm(specs),
        "release_date": parse_release_date(release_text),
        "price_jpy": parse_price_jpy(price_text) or card.get("price_jpy"),
        "product_line": title.split(" ", 1)[0] if title else "",
        "category_slug": category_slug(title, specs),
        "image_url": image_url,
    }


def goodsmile_list_products(limit: int, offset: int, keyword: str, status: str) -> list[dict[str, Any]]:
    params = {
        "filter": json.dumps(goodsmile_search_filter(status=status, keyword=keyword), separators=(",", ":")),
        "orderBy": "1", "limit": str(limit), "offset": str(offset),
        "couponId": "null", "searchIndex": "-1",
    }
    resp = SESSION.get(GOODSMILE_LIST, params=params, timeout=45)
    resp.raise_for_status()
    return goodsmile_parse_list_html(resp.text)


def goodsmile_fetch_detail(card: dict[str, Any]) -> dict[str, Any]:
    resp = SESSION.get(card["url"], timeout=45)
    resp.raise_for_status()
    return goodsmile_parse_detail_html(resp.text, card["url"], card)


def goodsmile_collect(limit: int, keyword: str = "", status: str = "1") -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    offset = 0
    batch_size = min(max(limit * 2, 60), 100)
    while len(candidates) < limit and offset < 500:
        batch = goodsmile_list_products(batch_size, offset, keyword, status)
        if not batch:
            break
        for card in batch:
            if card["source_id"] in seen:
                continue
            seen.add(card["source_id"])
            candidates.append(card)
            if len(candidates) >= limit:
                break
        offset += batch_size
    return candidates


# ==================== Playwright 辅助函数 ====================

def _playwright_fetch_html(url: str, wait_selector: str = "body", timeout_ms: int = 30000) -> str:
    """用 Playwright + stealth 抓取页面(绕过 Cloudflare)。返回 HTML 文本。"""
    import asyncio
    from playwright.async_api import async_playwright

    async def _fetch():
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                ],
            )
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 1920, "height": 1080},
                locale="en-US",
            )
            # 应用 stealth(如果可用)
            try:
                from playwright_stealth import Stealth
                stealth = Stealth()
                # stealth 1.x 使用 use_async 上下文管理器
                page = await context.new_page()
                # 手动注入反检测脚本
                await page.add_init_script("""
                    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                    Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
                    Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
                    window.chrome = { runtime: {} };
                """)
            except Exception:
                page = await context.new_page()

            try:
                resp = await page.goto(url, wait_until="networkidle", timeout=timeout_ms)
                # 等待 Cloudflare 挑战完成
                await page.wait_for_timeout(5000)
                html = await page.content()
                await browser.close()
                return html
            except Exception as e:
                await browser.close()
                raise

    return asyncio.run(_fetch())


# ==================== MFC 适配器 ====================

def mfc_fetch_list(page: int, per_page: int = 50, keyword: str = "") -> list[dict[str, Any]]:
    """从 MFC 获取列表(使用 Playwright 绕过 Cloudflare)"""
    params_str = f"_tb=item&sort=insert&page={page}"
    if keyword:
        params_str += f"&title={keyword}"
    url = f"{MFC_BASE}/?{params_str}"

    try:
        html = _playwright_fetch_html(url, timeout_ms=45000)
    except Exception as e:
        print(f"[mfc] Playwright fetch failed: {e}", file=sys.stderr)
        # Fallback: 尝试 curl-cffi
        try:
            from curl_cffi import requests as cffi_requests
            r = cffi_requests.get(url, impersonate="chrome120", timeout=30, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            })
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            html = r.text
        except Exception as e2:
            print(f"[mfc] curl-cffi also failed: {e2}", file=sys.stderr)
            return []

    soup = BeautifulSoup(html, "lxml")
    items: list[dict[str, Any]] = []
    # MFC 列表项选择器
    for node in soup.select(".item-icon, .tcg-item-icon, .item-card"):
        link = node.select_one("a")
        if not link:
            continue
        href = link.get("href", "")
        match = re.search(r"/item/(\d+)", href)
        if not match:
            continue
        item_id = match.group(1)
        img = link.select_one("img")
        title = ""
        if img:
            title = clean_text(img.get("alt", "") or img.get("title", ""))
        image_url = ""
        if img:
            src = img.get("src") or img.get("data-src") or ""
            if src:
                image_url = absolute_url(src, "https://static.myfigurecollection.net")
        items.append({
            "source_id": item_id,
            "source": "mfc",
            "url": f"{MFC_BASE}/item/{item_id}",
            "title": title,
            "image_url": image_url,
            "price_jpy": None,
            "manufacturer": "",
        })
    return items


def mfc_parse_detail_html(html: str, url: str, card: dict[str, Any]) -> dict[str, Any]:
    """解析 MFC 详情页"""
    soup = BeautifulSoup(html, "lxml")
    lines = [clean_text(line) for line in soup.get_text("\n").splitlines() if clean_text(line)]

    h1 = soup.select_one("h1")
    title = clean_text(h1.get_text(" ") if h1 else "") or card.get("title", "")

    # 解析字段
    series = ""
    sculptor = ""
    manufacturer = ""
    release_text = ""
    price_text = ""
    jan_code = ""
    specs = ""
    category_name = ""

    # Category
    cat_node = soup.select_one(".category, [itemprop='category']")
    if cat_node:
        category_name = clean_text(cat_node.get_text(" "))

    # 按标签查找
    def find_after_label(labels: list[str]) -> str:
        for i, line in enumerate(lines):
            for label in labels:
                if label.lower() in line.lower() and ":" in line:
                    parts = line.split(":", 1)
                    if len(parts) > 1 and parts[0].strip().lower() in [l.lower() for l in labels]:
                        return clean_text(parts[1])
            for label in labels:
                if line.lower().rstrip(":") == label.lower():
                    for candidate in lines[i + 1: i + 5]:
                        if candidate.lower().rstrip(":") not in [l.lower() for l in labels]:
                            return candidate
        return ""

    series = find_after_label(["Series", "Classification", "Origin"])
    sculptor = find_after_label(["Sculptor", "Artist"])
    manufacturer = find_after_label(["Manufacturer", "Company", "Publisher", "Distributor"])
    release_text = find_after_label(["Release Date", "Releases", "Release"])
    price_text = find_after_label(["Price"])
    specs = find_after_label(["Materials", "Dimensions", "Specifications"])

    # JAN 码(在 Releases 区块)
    jan_match = re.search(r"\b(\d{13})\b", html)
    if jan_match:
        jan_code = jan_match.group(1)

    # 图片(取主图)
    image_url = card.get("image_url", "")
    og_image = soup.select_one("meta[property='og:image']")
    if og_image:
        image_url = absolute_url(og_image.get("content", ""), "https://static.myfigurecollection.net")
    # 如果是缩略图,尝试获取大图
    if "/micro/" in image_url:
        image_url = image_url.replace("/micro/", "/big/")
    elif "/thumb/" in image_url:
        image_url = image_url.replace("/thumb/", "/big/")

    # 分类映射
    cat_lower = category_name.lower()
    if "trading" in cat_lower or "prize" in cat_lower:
        cat_slug = "pvc-figure"
    elif "scale" in cat_lower:
        cat_slug = "scale-figure"
    elif "nendoroid" in cat_lower or "chibi" in cat_lower:
        cat_slug = "nendoroid"
    elif "figma" in cat_lower or "action" in cat_lower:
        cat_slug = "figma"
    elif "model" in cat_lower or "plamo" in cat_lower:
        cat_slug = "plastic-model"
    elif "plush" in cat_lower:
        cat_slug = "plush"
    else:
        cat_slug = category_slug(title, specs)

    return {
        "source_id": card["source_id"],
        "source": "mfc",
        "mfc_id": card["source_id"],
        "url": url,
        "title": title,
        "description": normalize_description(specs),
        "series": series or "Original Character",
        "manufacturer": manufacturer or "Unknown",
        "sculptor": sculptor,
        "specifications": specs,
        "scale": parse_scale(specs, title),
        "height_mm": parse_height_mm(specs),
        "release_date": parse_release_date(release_text),
        "price_jpy": parse_price_jpy(price_text),
        "jan_code": jan_code,
        "product_line": title.split(" ", 1)[0] if title else "",
        "category_slug": cat_slug,
        "image_url": image_url,
    }


def mfc_fetch_detail(card: dict[str, Any]) -> dict[str, Any]:
    """获取 MFC 详情页(使用 Playwright)"""
    try:
        html = _playwright_fetch_html(card["url"], timeout_ms=30000)
    except Exception as e:
        print(f"[mfc] detail Playwright failed: {e}", file=sys.stderr)
        # Fallback: curl-cffi
        from curl_cffi import requests as cffi_requests
        r = cffi_requests.get(card["url"], impersonate="chrome120", timeout=30, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        })
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        html = r.text
    return mfc_parse_detail_html(html, card["url"], card)


def mfc_collect(limit: int, keyword: str = "") -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    page = 1
    while len(candidates) < limit and page <= 20:
        batch = mfc_fetch_list(page, per_page=50, keyword=keyword)
        if not batch:
            break
        candidates.extend(batch[:limit - len(candidates)])
        page += 1
    return candidates[:limit]


# ==================== Hobby Search 适配器 ====================

def hobbysearch_fetch_list(page: int, per_page: int = 30, keyword: str = "") -> list[dict[str, Any]]:
    """从 Hobby Search 获取列表(使用 Playwright 绕过 Cloudflare)"""
    params_str = f"typ1_c=101&cat=figure&target=original&searchkey={keyword or ''}&sortid=7&page={page}"
    url = f"{HOBBYSEARCH_BASE}/eng/search?{params_str}"

    try:
        html = _playwright_fetch_html(url, timeout_ms=30000)
    except Exception as e:
        print(f"[hobbysearch] Playwright failed: {e}", file=sys.stderr)
        return []

    soup = BeautifulSoup(html, "lxml")
    items: list[dict[str, Any]] = []
    # Hobby Search 列表项: 提取所有指向 /eng/{id} 的链接
    seen_ids: set[str] = set()
    for link in soup.select("a[href*='/eng/']"):
        href = link.get("href", "")
        match = re.search(r"/eng/(\d+)", href)
        if not match:
            continue
        item_id = match.group(1)
        if item_id in seen_ids:
            continue
        seen_ids.add(item_id)
        img = link.select_one("img")
        title = ""
        if img:
            title = clean_text(img.get("alt", "") or img.get("title", ""))
        image_url = ""
        if img:
            src = img.get("src") or ""
            if src:
                image_url = absolute_url(src, HOBBYSEARCH_BASE)
        # 价格在父元素文本中
        parent = link.find_parent()
        price_text = clean_text(parent.get_text(" ")) if parent else ""
        items.append({
            "source_id": item_id,
            "source": "hobbysearch",
            "url": f"{HOBBYSEARCH_BASE}/eng/{item_id}",
            "title": title,
            "image_url": image_url,
            "price_jpy": parse_price_jpy(price_text),
            "manufacturer": "",
        })
    return items


def hobbysearch_parse_detail_html(html: str, url: str, card: dict[str, Any]) -> dict[str, Any]:
    """解析 Hobby Search 详情页"""
    soup = BeautifulSoup(html, "lxml")
    lines = [clean_text(line) for line in soup.get_text("\n").splitlines() if clean_text(line)]

    h1 = soup.select_one("h1, .title, .product-name")
    title = clean_text(h1.get_text(" ") if h1 else "") or card.get("title", "")

    # 按标签查找
    def find_after_label(labels: list[str]) -> str:
        for i, line in enumerate(lines):
            for label in labels:
                if label.lower() in line.lower() and ":" in line:
                    parts = line.split(":", 1)
                    if len(parts) > 1:
                        return clean_text(parts[1])
            for label in labels:
                if line.lower().rstrip(":") == label.lower():
                    for candidate in lines[i + 1: i + 5]:
                        if candidate.lower().rstrip(":") not in [l.lower() for l in labels]:
                            return candidate
        return ""

    series = find_after_label(["Item series", "Series"])
    manufacturer = find_after_label(["Maker", "Manufacturer"])
    release_text = find_after_label(["Release Date", "Release", "Shipping Date"])
    price_text = find_after_label(["Price"])
    jan_code = find_after_label(["JAN code", "JAN"])
    specs = find_after_label(["Specifications", "Product Description", "Description"])

    # 从描述中提取 sculptor
    sculptor = ""
    sculptor_match = re.search(r"(?:Sculptor|原型|原型制作)[:\s]*(.+?)(?:\n|$)", html, re.IGNORECASE)
    if sculptor_match:
        sculptor = clean_text(sculptor_match.group(1))

    # 图片
    image_url = card.get("image_url", "")
    og_image = soup.select_one("meta[property='og:image']")
    if og_image:
        image_url = absolute_url(og_image.get("content", ""), HOBBYSEARCH_BASE)

    return {
        "source_id": card["source_id"],
        "source": "hobbysearch",
        "hobbysearch_id": card["source_id"],
        "url": url,
        "title": title,
        "description": normalize_description(specs),
        "series": series or "Original Character",
        "manufacturer": manufacturer or "Unknown",
        "sculptor": sculptor,
        "specifications": specs,
        "scale": parse_scale(specs, title),
        "height_mm": parse_height_mm(specs),
        "release_date": parse_release_date(release_text),
        "price_jpy": parse_price_jpy(price_text) or card.get("price_jpy"),
        "jan_code": jan_code,
        "product_line": title.split(" ", 1)[0] if title else "",
        "category_slug": category_slug(title, specs),
        "image_url": image_url,
    }


def hobbysearch_fetch_detail(card: dict[str, Any]) -> dict[str, Any]:
    """获取 Hobby Search 详情页(使用 Playwright)"""
    try:
        html = _playwright_fetch_html(card["url"], timeout_ms=30000)
    except Exception as e:
        print(f"[hobbysearch] detail Playwright failed: {e}", file=sys.stderr)
        return {
            "source_id": card["source_id"],
            "source": "hobbysearch",
            "hobbysearch_id": card["source_id"],
            "url": card["url"],
            "title": card.get("title", ""),
            "description": "",
            "series": "Original Character",
            "manufacturer": "Unknown",
            "sculptor": "",
            "specifications": "",
            "scale": None,
            "height_mm": None,
            "release_date": None,
            "price_jpy": card.get("price_jpy"),
            "jan_code": "",
            "product_line": card.get("title", "").split(" ", 1)[0] if card.get("title") else "",
            "category_slug": "pvc-figure",
            "image_url": card.get("image_url", ""),
        }
    return hobbysearch_parse_detail_html(html, card["url"], card)


def hobbysearch_collect(limit: int, keyword: str = "") -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    page = 1
    while len(candidates) < limit and page <= 20:
        batch = hobbysearch_fetch_list(page, per_page=30, keyword=keyword)
        if not batch:
            break
        candidates.extend(batch[:limit - len(candidates)])
        page += 1
    return candidates[:limit]


# ==================== AmiAmi 适配器 ====================

def amiami_fetch_list(page: int = 1, per_page: int = 30, keyword: str = "") -> list[dict[str, Any]]:
    """从 AmiAmi JSON API 获取列表(使用 curl-cffi 模拟 TLS + Playwright fallback)"""
    # 策略1: curl-cffi with chrome120
    try:
        from curl_cffi import requests as cffi_requests
        cffi_session = cffi_requests.Session()
        headers = {
            "X-User-Key": "amiami_dev",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Origin": "https://www.amiami.com",
            "Referer": "https://www.amiami.com/",
        }
        params = {
            "pagecnt": str(page),
            "pagemax": str(per_page),
            "lang": "eng",
            "age_confirm": "1",
            "s_sortkey": "regtimed",
        }
        if keyword:
            params["s_keywords"] = keyword
        else:
            params["s_cate1"] = "219"

        resp = cffi_session.get(
            f"{AMIAPI_BASE}/items",
            params=params,
            headers=headers,
            impersonate="chrome120",
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("RSuccess"):
                items: list[dict[str, Any]] = []
                for item in data.get("items", []):
                    gcode = item.get("gcode", "")
                    if not gcode:
                        continue
                    thumb = item.get("thumb_url", "")
                    image_url = absolute_url(thumb, AMIAMI_IMG_BASE) if thumb else ""
                    items.append({
                        "source_id": gcode,
                        "source": "amiami",
                        "url": f"https://www.amiami.com/eng/detail/?gcode={gcode}",
                        "title": clean_text(item.get("gname", "")),
                        "image_url": image_url,
                        "price_jpy": item.get("c_price_taxed"),
                        "manufacturer": "",
                    })
                return items
            else:
                print(f"[amiami] API error: {data.get('RMessage', 'unknown')}", file=sys.stderr)
        else:
            print(f"[amiami] curl-cffi returned HTTP {resp.status_code}, trying Playwright", file=sys.stderr)
    except Exception as e:
        print(f"[amiami] curl-cffi failed: {e}, trying Playwright", file=sys.stderr)

    # 策略2: Playwright fallback(渲染 HTML 页面并提取数据)
    try:
        url = f"https://www.amiami.com/eng/search/?s_cate1=219&s_sortkey=regtimed&pagecnt={page}"
        if keyword:
            url = f"https://www.amiami.com/eng/search/?s_keywords={keyword}&s_sortkey=regtimed&pagecnt={page}"
        html = _playwright_fetch_html(url, timeout_ms=30000)
        soup = BeautifulSoup(html, "lxml")
        items: list[dict[str, Any]] = []
        # 从 HTML 中提取商品链接
        for link in soup.select("a[href*='gcode=']"):
            href = link.get("href", "")
            match = re.search(r"gcode=([^&]+)", href)
            if not match:
                continue
            gcode = match.group(1)
            img = link.select_one("img")
            title = ""
            if img:
                title = clean_text(img.get("alt", "") or img.get("title", ""))
            image_url = ""
            if img:
                src = img.get("src") or img.get("data-src") or ""
                if src:
                    image_url = absolute_url(src, AMIAMI_IMG_BASE)
            items.append({
                "source_id": gcode,
                "source": "amiami",
                "url": f"https://www.amiami.com/eng/detail/?gcode={gcode}",
                "title": title,
                "image_url": image_url,
                "price_jpy": None,
                "manufacturer": "",
            })
        return items
    except Exception as e:
        print(f"[amiami] Playwright also failed: {e}", file=sys.stderr)
        return []


def amiami_fetch_detail(card: dict[str, Any]) -> dict[str, Any]:
    """从 AmiAmi JSON API 获取详情(使用 curl-cffi + Playwright fallback)"""
    gcode = card["source_id"]

    # 策略1: curl-cffi
    try:
        from curl_cffi import requests as cffi_requests
        cffi_session = cffi_requests.Session()
        headers = {
            "X-User-Key": "amiami_dev",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://www.amiami.com",
            "Referer": "https://www.amiami.com/",
        }
        resp = cffi_session.get(
            f"{AMIAPI_BASE}/item?gcode={gcode}",
            headers=headers,
            impersonate="chrome120",
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("RSuccess"):
                return _amiami_parse_detail_json(data, card)
            else:
                print(f"[amiami] API error: {data.get('RMessage', 'unknown')}", file=sys.stderr)
        else:
            print(f"[amiami] detail curl-cffi HTTP {resp.status_code}, trying Playwright", file=sys.stderr)
    except Exception as e:
        print(f"[amiami] detail curl-cffi failed: {e}, trying Playwright", file=sys.stderr)

    # 策略2: Playwright fallback
    try:
        html = _playwright_fetch_html(card["url"], timeout_ms=30000)
        soup = BeautifulSoup(html, "lxml")
        # 从 HTML 中提取信息(基本字段)
        h1 = soup.select_one("h1, .product-name, [class*='title']")
        title = clean_text(h1.get_text(" ") if h1 else "") or card.get("title", "")
        og_image = soup.select_one("meta[property='og:image']")
        image_url = card.get("image_url", "")
        if og_image:
            image_url = absolute_url(og_image.get("content", ""), AMIAMI_IMG_BASE)
        return {
            "source_id": gcode,
            "source": "amiami",
            "amiami_id": gcode,
            "url": card["url"],
            "title": title,
            "description": "",
            "series": "Original Character",
            "manufacturer": "Unknown",
            "sculptor": "",
            "specifications": "",
            "scale": None,
            "height_mm": None,
            "release_date": None,
            "price_jpy": card.get("price_jpy"),
            "jan_code": "",
            "product_line": title.split(" ", 1)[0] if title else "",
            "category_slug": "pvc-figure",
            "image_url": image_url,
        }
    except Exception as e:
        print(f"[amiami] detail Playwright also failed: {e}", file=sys.stderr)
        raise RuntimeError(f"AmiAmi detail failed for {gcode}")


def _amiami_parse_detail_json(data: dict[str, Any], card: dict[str, Any]) -> dict[str, Any]:
    """解析 AmiAmi JSON 详情"""
    item = data.get("item", {})
    gcode = card["source_id"]
    title = clean_text(item.get("gname", "")) or card.get("title", "")
    series = clean_text(item.get("series", "")) or "Original Character"
    manufacturer = clean_text(item.get("maker", "")) or "Unknown"
    sculptor = clean_text(item.get("modeler", ""))
    original = clean_text(item.get("original", ""))
    scale = item.get("scale", "")
    size_text = item.get("size", "")
    material = clean_text(item.get("material", ""))
    release_date = parse_release_date(item.get("releasedate", ""))
    price_jpy = item.get("price") or card.get("price_jpy")
    jan_code = item.get("jan", "")
    specs = clean_text(f"{material} {size_text}")
    image_url = card.get("image_url", "")
    if item.get("thumb_url"):
        image_url = absolute_url(item["thumb_url"], AMIAMI_IMG_BASE)
    description = clean_text(item.get("description", "") or item.get("gname", ""))
    return {
        "source_id": gcode,
        "source": "amiami",
        "amiami_id": gcode,
        "url": card["url"],
        "title": title,
        "description": normalize_description(description),
        "series": series or original or "Original Character",
        "manufacturer": manufacturer,
        "sculptor": sculptor,
        "specifications": specs,
        "scale": scale or parse_scale(specs, title),
        "height_mm": parse_height_mm(size_text),
        "release_date": release_date,
        "price_jpy": price_jpy,
        "jan_code": jan_code,
        "product_line": title.split(" ", 1)[0] if title else "",
        "category_slug": category_slug(title, specs),
        "image_url": image_url,
    }


def amiami_collect(limit: int, keyword: str = "") -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    page = 1
    while len(candidates) < limit and page <= 20:
        batch = amiami_fetch_list(page=page, per_page=30, keyword=keyword)
        if not batch:
            break
        candidates.extend(batch[:limit - len(candidates)])
        page += 1
        time.sleep(1)  # AmiAmi rate limit
    return candidates[:limit]


# ==================== 来源调度器 ====================

SOURCES = {
    "goodsmile": {"collect": goodsmile_collect, "fetch_detail": goodsmile_fetch_detail},
    "mfc": {"collect": mfc_collect, "fetch_detail": mfc_fetch_detail},
    "hobbysearch": {"collect": hobbysearch_collect, "fetch_detail": hobbysearch_fetch_detail},
    "amiami": {"collect": amiami_collect, "fetch_detail": amiami_fetch_detail},
}


# ==================== 主程序 ====================

def main() -> int:
    parser = argparse.ArgumentParser(description="Multi-source figure importer for ModelWiki.")
    parser.add_argument("--source", choices=["goodsmile", "mfc", "hobbysearch", "amiami", "all"], default="goodsmile")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--api-base", default="http://127.0.0.1:3001/api/v1")
    parser.add_argument("--token", default=os.environ.get("MODELWIKI_API_TOKEN", ""))
    parser.add_argument("--keyword", default="")
    parser.add_argument("--status", default="1")
    parser.add_argument("--sleep", type=float, default=1.0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--ai-rewrite", action="store_true", help="Enable AI description rewriting")
    parser.add_argument("--skip-watermark-check", action="store_true", help="Skip watermark detection")
    parser.add_argument("--summary-file", default="")
    args = parser.parse_args()

    limit = max(1, min(args.limit, 500))
    api = ApiClient(args.api_base, token=args.token)

    # 确定要抓取的来源列表
    if args.source == "all":
        source_list = ["goodsmile", "mfc", "hobbysearch", "amiami"]
        per_source_limit = max(1, limit // len(source_list))
    else:
        source_list = [args.source]
        per_source_limit = limit

    print(f"=== Multi-source import: {args.source}, limit={limit} (per source: {per_source_limit}) ===")
    print(f"AI rewrite: {'enabled' if args.ai_rewrite else 'disabled'}")
    print(f"Watermark check: {'enabled' if not args.skip_watermark_check else 'disabled'}")
    print("")

    all_imported: list[dict[str, Any]] = []
    all_errors: list[dict[str, str]] = []

    for source_name in source_list:
        source_config = SOURCES.get(source_name)
        if not source_config:
            print(f"[error] Unknown source: {source_name}", file=sys.stderr)
            continue

        print(f"\n=== Source: {source_name} (target: {per_source_limit}) ===")
        try:
            cards = source_config["collect"](per_source_limit, args.keyword)
        except Exception as exc:
            print(f"[error] {source_name} collect failed: {exc}", file=sys.stderr)
            all_errors.append({"source": source_name, "error": f"collect: {exc}"})
            continue

        print(f"Collected {len(cards)} candidates from {source_name}")
        if args.dry_run:
            for card in cards[:5]:
                print(f"  [dry-run] {card['source_id']}: {card.get('title', '?')}")
            all_imported.extend([{"title": c.get("title", ""), "sourceId": c["source_id"], "source": source_name, "dryRun": True} for c in cards])
            continue

        imported_count = 0
        for card in cards:
            if imported_count >= per_source_limit:
                break
            try:
                detail = source_config["fetch_detail"](card)
                if not detail.get("title"):
                    raise RuntimeError("missing product title")

                # AI 洗稿
                if args.ai_rewrite and detail.get("description"):
                    original_desc = detail["description"]
                    detail["description"] = ai_rewrite_description(
                        original_desc,
                        title=detail["title"],
                        source=source_name,
                    )
                    print(f"  [ai] rewritten: {original_desc[:50]}... -> {detail['description'][:50]}...", file=sys.stderr)

                result = api.create_figure(detail)
                figure = result["data"]
                all_imported.append({
                    "id": figure["id"],
                    "slug": figure["slug"],
                    "title": figure["name"],
                    "source": source_name,
                    "imageRecords": result.get("meta", {}).get("imageImport", {}).get("created", 0),
                })
                imported_count += 1
                print(f"[{imported_count:02d}/{per_source_limit}] [{source_name}] {detail['title']}")
                time.sleep(args.sleep)
            except Exception as exc:
                all_errors.append({"source": source_name, "sourceId": card.get("source_id", ""), "url": card.get("url", ""), "error": str(exc)})
                print(f"[error] [{source_name}] {card.get('url', '')}: {exc}", file=sys.stderr)
                time.sleep(args.sleep)

    summary = {
        "source": args.source,
        "sources": source_list,
        "requested": limit,
        "perSource": per_source_limit,
        "imported": len(all_imported),
        "errors": all_errors,
        "items": all_imported,
        "aiRewrite": args.ai_rewrite,
        "watermarkCheck": not args.skip_watermark_check,
        "finishedAt": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if args.summary_file:
        path = Path(args.summary_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    return 0 if len(all_imported) >= 1 else 1


if __name__ == "__main__":
    raise SystemExit(main())
