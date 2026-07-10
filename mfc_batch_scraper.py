#!/usr/bin/env python3
"""
[Local Script] ModelWiki Figure Data Scraper
=============================================
Runs locally on the user's machine, NOT on the server.
Connects to the remote API at https://www.phoebusstudio.com/api/v1.
Image processing happens locally; images are uploaded to the server afterward.

Supported sources:
  - MyFigureCollection (MFC): Playwright browser search + requests scraping
  - AmiAmi: Playwright browser search + detail page scraping
  - Hobby Search (1999.co.jp): requests-based scraping (very reliable JAN codes)

Strategy:
  1. Discover items using source-specific search
  2. Scrape full details from each item page
  3. Process images locally (download, WebP convert, SHA-256, multi-size)
  4. Create/merge figures in database via API (JAN Code as merge key)
  5. Upload processed images to server via scp + docker cp

Requirements:
    pip install requests beautifulsoup4 patchright playwright-stealth Pillow
"""

import sys, os, re, time, json, random, requests, hashlib, subprocess, shutil
from urllib.parse import quote, urlparse
from bs4 import BeautifulSoup
from patchright.sync_api import sync_playwright
from playwright_stealth.stealth import Stealth
from crawler_common import JsonlReport, resolve_admin_password, resolve_admin_user, resolve_api_base, submit_review_item

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SITE_URL = "https://www.phoebusstudio.com"
API_BASE = resolve_api_base(SITE_URL)
ADMIN_USER = resolve_admin_user()
DEFAULT_PASSWORD = resolve_admin_password()

MFC_BASE = "https://myfigurecollection.net"
MFC_ITEM_URL = f"{MFC_BASE}/item"
AMIAMI_BASE = "https://www.amiami.com"
AMIAMI_DETAIL_URL = "https://www.amiami.com/eng/detail/"
HOBBYSEARCH_BASE = "https://www.1999.co.jp"
HOBBYSEARCH_SEARCH_URL = "https://www.1999.co.jp/eng/search"
HOBBYSEARCH_DETAIL_URL = "https://www.1999.co.jp/eng"

PLAYWRIGHT_TIMEOUT = 30000
REQUEST_TIMEOUT = 30


class CloudflareBlockError(RuntimeError):
    """Raised when Cloudflare blocks the request (403/429/challenge/captcha).

    The agent should catch this and mark the source as temporarily blocked
    to avoid hammering the site with repeated blocked requests. The job is
    deferred (not failed) so it can be re-claimed after a cooldown.
    """
    pass


def detect_cloudflare_block(resp, html=""):
    """Detect Cloudflare challenge/block/captcha and raise CloudflareBlockError.

    Only DETECTS the block; does NOT attempt to solve the challenge or bypass
    any protection. Called after each HTTP request so the agent can stop the
    source instead of retrying.
    """
    status = getattr(resp, "status_code", 0) if resp else 0
    headers = getattr(resp, "headers", {}) if resp else {}
    cf_mitigated = headers.get("cf-mitigated", "") if hasattr(headers, "get") else ""
    body = html or (getattr(resp, "text", "") or "")[:2000]

    # HTTP 403 + cf-mitigated header = Cloudflare challenge/block
    if status == 403 and cf_mitigated:
        raise CloudflareBlockError(
            f"Cloudflare {cf_mitigated} (HTTP 403) - source temporarily blocked"
        )
    # HTTP 429 Too Many Requests
    if status == 429:
        raise CloudflareBlockError(
            "HTTP 429 Too Many Requests - rate limited"
        )
    # cf-mitigated header on any status (challenge/block/managed)
    if cf_mitigated and cf_mitigated.lower() in ("challenge", "block", "managed"):
        raise CloudflareBlockError(
            f"Cloudflare {cf_mitigated} - source temporarily blocked"
        )
    # Body markers for JS challenge / captcha pages
    body_lower = body.lower()
    if "just a moment" in body_lower[:500] or "cf-turnstile-response" in body_lower:
        raise CloudflareBlockError(
            "Cloudflare JS challenge page detected (Just a Moment)"
        )
    if "captcha" in body_lower and "challenge" in body_lower:
        raise CloudflareBlockError(
            "Captcha challenge page detected"
        )
    # Cloudflare error 1015 (rate limit) or 1020 (access denied)
    if "error 1015" in body_lower or "error 1020" in body_lower:
        raise CloudflareBlockError(
            "Cloudflare error 1015/1020 - blocked by site owner"
        )


DELAY_BETWEEN_FIGURES = 3.0
DELAY_BETWEEN_SEARCHES = 2.0
MAX_IMAGES = 12
# Minimum dimension (max side in px) for a downloaded image to be accepted as
# a detail/raw source image. Images smaller than this are likely thumbnails or
# UI icons and must not be stored as official product images. They may still be
# kept as fallback leads but never as the primary detail/raw variant.
MIN_IMAGE_MAX_DIMENSION = 600
# Threshold below which an image_low_count report event is emitted (per item).
LOW_IMAGE_COUNT_THRESHOLD = 3
PROGRESS_FILE = "batch_scraper_progress.json"
DISCOVERED_FILE = "discovered_items.json"

# Local image processing
ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "figures")
WEBP_SIZES = {
    "raw": None,       # original dimensions
    "detail": 800,     # max 800px
    "thumb": 300,      # max 300px
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    "Referer": "https://myfigurecollection.net/",
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

MANUFACTURER_NAMES = [
    "Good Smile Company", "Alter", "Kotobukiya", "FREEing", "Max Factory",
    "Aniplex", "Kadokawa", "MegaHouse", "Bandai Spirits", "Banpresto",
    "Phat Company", "Ques Q", "Stronger", "Native", "Orchid Seed",
    "eStream", "Union Creative", "Hobby Stock", "Amakuni", "Flare",
    "Pink Charm", "Myethos", "Golden Head", "Prime 1 Studio", "Orange Rouge",
    "SkyTube", "Taito", "SEGA", "FuRyu", "Good Smile Arts Shanghai",
    "WING", "Aquamarine", "Kaitendo", "Medicos Entertainment",
    "Bellfine", "Vertex", "Daiwiki Kogyo", "Emontoys", "Apex Innovation",
]

POPULAR_SERIES = [
    "Fate/Grand Order", "Fate/stay night", "Demon Slayer", "Jujutsu Kaisen",
    "Spy x Family", "Re:Zero", "Hololive", "Genshin Impact", "Honkai Star Rail",
    "One Piece", "Dragon Ball", "Sword Art Online", "Attack on Titan",
    "Chainsaw Man", "My Dress-Up Darling", "Konosuba", "Overlord",
    "Blue Archive", "Azur Lane", "Nikke", "Nier Automata", "Vocaloid",
    "Evangelion", "Bocchi the Rock!", "Oshi no Ko", "Frieren",
    "Mushoku Tensei", "Dandadan", "Solo Leveling", "Lycoris Recoil",
]

SCALE_KEYWORDS = ["1/4", "1/6", "1/7", "1/8"]
TARGET_YEARS = [2024, 2025, 2026]

NON_FIGURE_CANDIDATE_RE = re.compile(
    r"external fuel tank|fuel tank|grenade launcher|gun/|camouflage|buchon|cherokee|"
    r"hi-tech kit|soviet army|t-80|piper pa-|la-5|aircraft|airplane",
    re.IGNORECASE,
)

FIGURE_CANDIDATE_RE = re.compile(
    r"figure|figma|nendoroid|pop up parade|action figure|completed|doll|bjd|garage kit|"
    r"resin cast|plamodel|model kit|model kits|plastic model|statue|tank crew|"
    r"badge|can badge|button badge|acrylic|keychain|key holder|keyholder|rubber keychain|"
    r"rubber strap|tapestry|t-shirt|clear file|mini mini plush|plush|mascot|rubber mat|"
    r"play mat|card supplies|sticker|calendar|catalog|goods catalog|coaster|mug|blanket|"
    r"towel|stand|charm|goods|trading|ichiban kuji|kuji|birthday celebration|"
    r"フィギュア|完成品|プラモデル|ねんどろいど|ドール|可動|アクション|"
    r"アクリル|缶バッジ|キーホルダー|タペストリー|Tシャツ|クリアファイル|"
    r"ステッカー|カレンダー|スタンド|ぬいぐるみ|グッズ|"
    r"\b1/(?:1|4|6|7|8|10|12|35|48|72|100|144)\b",
    re.IGNORECASE,
)

FIGURE_CATEGORY_RE = re.compile(
    r"prepainted|action|dolls|nendoroid|figma|model kits|garage kits|figures",
    re.IGNORECASE,
)

MERCH_CANDIDATE_RE = re.compile(
    r"\bbadge\b|acrylic|key\s*ring|keychain|key holder|"
    r"rubber strap|rubber mat|play mat|card supplies|trading card|clear file|sticker|"
    r"calendar|tapestry|poster|plushie|plush|mascot|coaster|mug|blanket|towel|"
    r"t-?shirt|apparel|charm|anime goods|anime toy|goods store|"
    r"art book|artbook|doujinshi|doujin|fan book|visual book|material book|"
    r"shikishi|canvas board|illustration board|bromide|photo card|"
    r"minini|mini acrylic|campaign mini|trading mini|"
    r"rubber mascot|prize campaign|lottery|"
    r"アクリル|缶バッジ|キーホルダー|ラバーマット|クリアファイル|ステッカー|"
    r"カレンダー|タペストリー|ぬいぐるみ|グッズ|"
    r"ラバーマスコット|アクリルキーホルダー|アクリルスタンド|"
    r"イラストボード|ブロマイド|同人誌",
    re.IGNORECASE,
)

MONTH_NAME_TO_NUMBER = {
    "jan": "01",
    "january": "01",
    "feb": "02",
    "february": "02",
    "mar": "03",
    "march": "03",
    "apr": "04",
    "april": "04",
    "may": "05",
    "jun": "06",
    "june": "06",
    "jul": "07",
    "july": "07",
    "aug": "08",
    "august": "08",
    "sep": "09",
    "sept": "09",
    "september": "09",
    "oct": "10",
    "october": "10",
    "nov": "11",
    "november": "11",
    "dec": "12",
    "december": "12",
}


def infer_merch_product_line(name, category=""):
    """Return a product-line label for anime goods, or None for figure/model items."""
    text = f"{name or ''} {category or ''}".strip()
    if not text or not MERCH_CANDIDATE_RE.search(text):
        return None
    lowered = text.lower()
    if re.search(r"plushie|plush|mascot|ぬいぐるみ", lowered, re.IGNORECASE):
        return "Plush"
    if re.search(r"rubber mat|play mat|card supplies|trading card|deck|sleeve|ラバーマット", lowered, re.IGNORECASE):
        return "Card Supplies"
    if re.search(r"tapestry|poster|タペストリー", lowered, re.IGNORECASE):
        return "Tapestry / Poster"
    if re.search(r"t-?shirt|apparel|blanket|towel|hoodie|shirt", lowered, re.IGNORECASE):
        return "Apparel / Textile Goods"
    if re.search(r"calendar|clear file|sticker|カレンダー|クリアファイル|ステッカー", lowered, re.IGNORECASE):
        return "Stationery"
    return "Anime Goods"


def merch_category_slug(product_line):
    if product_line == "Plush":
        return "plush"
    return "merchandise"


def classify_product_kind(name, category="", scale=""):
    """Classify a scraped product into a coarse productKind for dedup and AI prompts.

    Returns one of:
      figure, merchandise, plush, acrylic-stand, badge, tapestry-poster,
      apparel-accessory, home-living, stationery, book, other-merch

    Figures (scale figures, prize figures, Nendoroid, figma, action figures,
    model kits, dolls) return 'figure'. Everything else returns a merchandise
    subtype so the agent can route it to a non-figure db category without
    skipping it.
    """
    text = f"{name or ''} {category or ''}".strip()
    if not text:
        return "other-merch"
    lowered = text.lower()

    # Obvious non-product junk
    if NON_FIGURE_CANDIDATE_RE.search(text):
        return "other-merch"

    # Merchandise subtypes (checked BEFORE figure so that "Rubber Keychain
    # Ichiban Kuji Premium Figure" classifies as badge/keychain, not figure).
    # Only English keywords are used here to avoid any encoding/mojibake issues
    # in Windows PowerShell logs. MFC's English category names cover the vast
    # majority of cases; Japanese-name-only items will fall through to the
    # MERCH_CANDIDATE_RE / FIGURE_CANDIDATE_RE heuristics below.
    if re.search(r"plushie|plush|mascot", lowered):
        return "plush"
    if re.search(r"acrylic\s*stand|acrylic\s*figure", lowered):
        return "acrylic-stand"
    if re.search(r"\bbadge\b|can\s*badge|button\s*badge", lowered):
        return "badge"
    if re.search(r"tapestry|poster|shikishi|canvas\s*board|illustration\s*board", lowered):
        return "tapestry-poster"
    if re.search(r"t-?shirt|apparel|hoodie|blanket|towel|rubber\s*mat|play\s*mat", lowered):
        return "apparel-accessory" if re.search(r"t-?shirt|apparel|hoodie", lowered) else "home-living"
    if re.search(r"clear\s*file|sticker|calendar|stationery", lowered):
        return "stationery"
    if re.search(r"art\s*book|artbook|doujinshi|doujin|fan\s*book|visual\s*book|material\s*book", lowered):
        return "book"
    if re.search(r"rubber\s*strap|rubber\s*mascot|charm|keychain|key\s*holder|trading\s*mini|campaign\s*mini|minini|mini\s*acrylic", lowered):
        return "merchandise"
    if re.search(r"mug|coaster|bromide|photo\s*card", lowered):
        return "other-merch"
    if MERCH_CANDIDATE_RE.search(text):
        return "merchandise"

    # Figure subtypes
    if re.search(r"nendoroid", lowered):
        return "figure"
    if re.search(r"\bfigma\b", lowered):
        return "figure"
    if re.search(r"pop\s*up\s*parade", lowered):
        return "figure"
    if re.search(r"prize|ichiban\s*kuji", lowered):
        return "figure"
    if scale and re.search(r"\b1/\d+", scale):
        return "figure"
    if category and FIGURE_CATEGORY_RE.search(category):
        return "figure"
    if FIGURE_CANDIDATE_RE.search(text):
        return "figure"
    return "other-merch"


def product_kind_to_db_category(product_kind):
    """Map a productKind to the db category slug used by the API."""
    mapping = {
        "figure": "",  # figure keeps the existing logic (pvc-figure/action-figure/etc.)
        "plush": "plush",
        "acrylic-stand": "other-merch",
        "badge": "other-merch",
        "tapestry-poster": "tapestry-poster",
        "apparel-accessory": "apparel-accessory",
        "home-living": "home-living",
        "stationery": "stationery",
        "book": "other-merch",
        "merchandise": "other-merch",
        "other-merch": "other-merch",
    }
    return mapping.get(product_kind, "other-merch")


def normalize_name_for_match(name):
    """Normalize a product name for soft-match dedup.

    Lowercases, strips punctuation/whitespace, removes edition/version suffixes
    and common scale/size tokens so that "Hatsune Miku (1/7 Scale)" and
    "hatsune miku 1/7 scale figure" can match.
    """
    if not name:
        return ""
    s = name.lower().strip()
    # Remove text in parentheses
    s = re.sub(r"\([^)]*\)", " ", s)
    # Remove edition/version/scale/size tokens
    s = re.sub(r"(?i)\b(ver(?:sion)?|edition|scale|size|cm|mm|figure|statue|complete|completed|prepainted)\b", " ", s)
    # Remove scale patterns like 1/7 1/8
    s = re.sub(r"\b1/\d+\b", " ", s)
    # Collapse non-alphanumeric to single spaces
    s = re.sub(r"[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def filter_hobbysearch_product_images(images, item_id, max_images=MAX_IMAGES):
    """Prefer HobbySearch images whose URL contains the current item id."""
    normalized = []
    seen = set()
    for url in images or []:
        if not url:
            continue
        clean = str(url).split("?")[0]
        lower = clean.lower()
        if any(skip in lower for skip in ["icon", "btn", "logo", "banner", "spacer", "header", "footer", "nav"]):
            continue
        if clean not in seen:
            seen.add(clean)
            normalized.append(str(url))

    item_id = str(item_id or "")
    exact = [url for url in normalized if item_id and item_id in url]
    return (exact or normalized)[:max_images]

# ---------------------------------------------------------------------------
# Term glossary for text cleaning / localization hints
# ---------------------------------------------------------------------------

GLOSSARY = {
    "Scale Figure": {"fr": "Figurine de collection", "de": "Maßstabsfiguren",
                     "es": "Figura a escala", "it": "Figura in scala"},
    "Prize Figure": {"fr": "Figurine de loterie", "de": "Prize-Figur",
                     "es": "Figura de premio", "it": "Figura da premio"},
    "Cast-off": {"fr": "Amovible", "de": "Abnehmbar",
                 "es": "Desmontable", "it": "Rimovibile"},
    "Sculptor": {"fr": "Sculpteur", "de": "Bildhauer",
                 "es": "Escultor", "it": "Scultore"},
    "Nendoroid": {"fr": "Nendoroid", "de": "Nendoroid",
                  "es": "Nendoroid", "it": "Nendoroid"},
    "figma": {"fr": "figma", "de": "figma",
              "es": "figma", "it": "figma"},
    "Pop Up Parade": {"fr": "Pop Up Parade", "de": "Pop Up Parade",
                      "es": "Pop Up Parade", "it": "Pop Up Parade"},
}

SEO_SPAM_PATTERNS = [
    r"(?i)pre-?orders?\s+open\s+now",
    r"(?i)buy\s+now",
    r"(?i)order\s+now",
    r"(?i)limited\s+time\s+offer",
    r"(?i)click\s+here",
    r"(?i)shop\s+now",
    r"(?i)don'?t\s+miss\s+out",
    r"(?i)available\s+now",
    r"(?i)pre-?order\s+available",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def green(text):  return f"\033[92m{text}\033[0m"
def red(text):    return f"\033[91m{text}\033[0m"
def yellow(text): return f"\033[93m{text}\033[0m"
def cyan(text):   return f"\033[96m{text}\033[0m"
def magenta(text):return f"\033[95m{text}\033[0m"


def is_figure_candidate(name, category=""):
    """Return True for figure/model-kit products and False for obvious character goods.

    Merchandise keywords (rubber keychain, acrylic stand, badge, plush, etc.)
    take priority over figure keywords: if the name matches MERCH_CANDIDATE_RE,
    we reject it even if it also contains 'figure' or 'ichiban kuji'.
    """
    text = f"{name or ''} {category or ''}".strip()
    if not text:
        return False
    if NON_FIGURE_CANDIDATE_RE.search(text):
        return False
    # Merchandise filter: reject if name matches merch keywords, even if it also
    # contains figure-like words. This prevents items like "Rubber Keychain
    # Ichiban Kuji Premium Figure" from being classified as a figure.
    if MERCH_CANDIDATE_RE.search(text):
        return False
    if category and FIGURE_CATEGORY_RE.search(category):
        return True
    return bool(FIGURE_CANDIDATE_RE.search(text))


def slugify(text):
    text = text.lower().strip()
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[-\s]+', '-', text)
    text = text.strip("-_")
    return text[:80]


def normalize_manufacturer_name(name):
    """Return the first usable manufacturer name from scraped text."""
    if not name:
        return ""
    value = clean_text(str(name))
    value = re.sub(r"(?i)^(manufacturer|maker|brand)\s*[:：]\s*", "", value).strip()
    if value.startswith("(") and value.endswith(")"):
        value = value[1:-1].strip()
    parts = [p.strip() for p in re.split(r"\s*(?:,|/|;|、|，)\s*", value) if p.strip()]
    for part in parts or [value]:
        candidate = re.sub(r"\s+", " ", part).strip(" -")
        if len(candidate) < 2:
            continue
        if re.fullmatch(r"(?:19|20)\d{2}", candidate):
            continue
        if re.search(r"(?i)\b(ver|version|edition|scale|size|cm|mm)\b", candidate):
            continue
        return candidate
    return ""


def clean_text(text):
    """Remove HTML tags, MFC internal links, SEO spam, and extra whitespace."""
    if not text:
        return ""
    # Remove HTML tags
    text = re.sub(r'<[^>]+>', '', text)
    # Remove MFC internal links like [item=123456] or [item=123456,12345]
    text = re.sub(r'\[item=\d+(?:,\d+)*\]', '', text)
    # Remove MFC user links like [user=12345]
    text = re.sub(r'\[user=\d+\]', '', text)
    # Remove SEO spam
    for pattern in SEO_SPAM_PATTERNS:
        text = re.sub(pattern, '', text)
    # Clean up whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def extract_jan_code(text):
    """Extract a JAN code (8 or 13 digits starting with 45 or 49) from text."""
    if not text:
        return None
    text = str(text).strip()
    # Try 13-digit JAN (starts with 45 or 49)
    m = re.search(r'\b(4[59]\d{11})\b', text)
    if m:
        return m.group(1)
    # Try 8-digit JAN
    m = re.search(r'\b(4[59]\d{6})\b', text)
    if m:
        return m.group(1)
    return None


def parse_release_date(date_str):
    """Parse various date formats into YYYY-MM-DD."""
    if not date_str:
        return None
    date_str = str(date_str).strip()
    cleaned = re.sub(r'\([^)]*\)', '', date_str)
    cleaned = re.sub(r'\b(?:release date|release|released|ships)\b\s*:?', '', cleaned, flags=re.IGNORECASE).strip()
    # YYYY-MM-DD
    m = re.match(r'(\d{4}-\d{2}-\d{2})', cleaned)
    if m:
        return m.group(1)
    # MM/DD/YYYY
    m = re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})', cleaned)
    if m:
        mo, d, y = m.group(1).zfill(2), m.group(2).zfill(2), m.group(3)
        return f"{y}-{mo}-{d}"
    # YYYY/MM/DD or YYYY-MM-DD (partial)
    m = re.match(r'(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?$', cleaned)
    if m:
        y, mo = m.group(1), m.group(2).zfill(2)
        d = m.group(3) or "01"
        return f"{y}-{mo}-{d.zfill(2)}"
    # MM/YYYY
    m = re.match(r'(\d{1,2})/(\d{4})', cleaned)
    if m:
        mo, y = m.group(1).zfill(2), m.group(2)
        return f"{y}-{mo}-01"
    # Month YYYY, e.g. Dec 2026, Mid May 2026, or late Jan-2024 (AmiAmi format)
    m = re.search(
        r'\b(?:early|mid|late)?\s*'
        r'(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|'
        r'aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?[\s\-]+'
        r'(20\d{2})\b',
        cleaned,
        re.IGNORECASE,
    )
    if m:
        mo = MONTH_NAME_TO_NUMBER[m.group(1).lower().rstrip(".")]
        return f"{m.group(2)}-{mo}-01"
    # YYYY alone
    m = re.match(r'(\d{4})$', cleaned)
    if m:
        return f"{m.group(1)}-01-01"
    return None


def extract_price_number(price_str):
    if not price_str:
        return None
    nums = re.findall(r'[\d,]+', str(price_str))
    if nums:
        return int(nums[0].replace(',', ''))
    return None


def month_number(name):
    if not name:
        return None
    return MONTH_NAME_TO_NUMBER.get(str(name).lower().strip().rstrip("."))


def extract_hobbysearch_page_fields(soup):
    """Extract structured product fields from modern HobbySearch pages."""
    data = {}
    spec_pairs = {}
    for dl in soup.select("dl"):
        for row in dl.find_all("div", recursive=False):
            dt = row.find("dt")
            dd = row.find("dd")
            if not dt or not dd:
                continue
            key = clean_text(dt.get_text(" ", strip=True)).lower()
            value = clean_text(dd.get_text(" ", strip=True))
            if key and value:
                spec_pairs[key] = value

    jan = extract_jan_code(spec_pairs.get("jan code", ""))
    if jan:
        data["jan_code"] = jan

    if spec_pairs.get("manufacturer"):
        data["manufacturer"] = spec_pairs["manufacturer"]
    if spec_pairs.get("scale"):
        data["scale"] = spec_pairs["scale"]
    if spec_pairs.get("material"):
        data["material"] = spec_pairs["material"]
    if spec_pairs.get("series title"):
        data["origin"] = spec_pairs["series title"]
    elif spec_pairs.get("original"):
        data["origin"] = spec_pairs["original"]

    price_el = soup.select_one(".c-product-detail__info-price-element")
    if price_el:
        price = extract_price_number(price_el.get_text(" ", strip=True))
        if price:
            data["price"] = str(price)

    release_el = soup.select_one("#masterBody_salesDate")
    if release_el:
        release_text = clean_text(release_el.get_text(" ", strip=True))
        m = re.search(r"Release Date\s*:\s*([^()]+)", release_text, re.IGNORECASE)
        release_value = (m.group(1) if m else release_text).strip()
        if not re.search(r"\b20\d{2}\b", release_value):
            release_month = month_number(release_value)
            preorder = re.search(
                r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
                r"aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+"
                r"\d{1,2},\s*(20\d{2})\s+Pre-order start",
                release_text,
                re.IGNORECASE,
            )
            if release_month and preorder:
                preorder_month = month_number(preorder.group(1))
                year = int(preorder.group(2))
                if preorder_month and int(release_month) < int(preorder_month):
                    year += 1
                release_value = f"{release_value} {year}"
        data["release_date"] = release_value

    return data


# ---------------------------------------------------------------------------
# Local image processing
# ---------------------------------------------------------------------------

def download_image(url, dest_dir, timeout=30):
    """Download an image to dest_dir. Uses curl_cffi chrome120 to bypass Cloudflare.
    Adds source-specific Referer to bypass anti-leech protections."""
    # MFC item thumbnails redirect: /items/2/ -> /items/1/
    urls_to_try = []
    if "/items/2/" in url:
        urls_to_try.append(url.replace("/items/2/", "/items/1/"))
    urls_to_try.append(url)

    # Determine referer from URL
    referer = ""
    if "myfigurecollection.net" in url:
        referer = "https://myfigurecollection.net/"
    elif "amiami.com" in url:
        referer = "https://www.amiami.com/eng/"
    elif "1999.co.jp" in url or "hobbysearch" in url:
        referer = "https://www.1999.co.jp/"

    # Build headers with referer
    img_headers = dict(HEADERS)
    if referer:
        img_headers["Referer"] = referer

    last_error = None
    for candidate_url in urls_to_try:
        # Try curl_cffi (chrome120 TLS fingerprint) first
        try:
            from curl_cffi import requests as crequests
            resp = crequests.get(candidate_url, headers=img_headers, impersonate="chrome120", timeout=timeout, stream=True)
            resp.raise_for_status()
        except Exception as e:
            # Fallback to plain requests with browser UA + referer
            try:
                resp = requests.get(candidate_url, headers=img_headers, timeout=timeout, stream=True)
                resp.raise_for_status()
            except Exception as e2:
                last_error = e2
                continue
        try:
            content_type = resp.headers.get("content-type", "")
            ext = ".jpg"
            if "png" in content_type:
                ext = ".png"
            elif "webp" in content_type:
                ext = ".webp"
            elif "gif" in content_type:
                ext = ".gif"
            url_path = urlparse(candidate_url).path
            if url_path.endswith(".png"):
                ext = ".png"
            elif url_path.endswith(".webp"):
                ext = ".webp"
            os.makedirs(dest_dir, exist_ok=True)
            tmp_path = os.path.join(dest_dir, f"_download_tmp{ext}")
            with open(tmp_path, "wb") as f:
                for chunk in resp.iter_content(8192):
                    f.write(chunk)
            return tmp_path
        except Exception as e:
            last_error = e
            continue
    print(yellow(f"    Download failed for {url[:80]}: {last_error}"))
    return None

def compute_sha256(filepath):
    """Compute SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def convert_to_webp(src_path, dest_path, max_size=None, quality=85):
    """Convert an image to WebP using Pillow. If max_size, resize so longest side = max_size."""
    try:
        from PIL import Image
        img = Image.open(src_path)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGBA")
        else:
            img = img.convert("RGB")
        if max_size:
            img.thumbnail((max_size, max_size), Image.LANCZOS)
        img.save(dest_path, "WEBP", quality=quality, method=6)
        return True
    except ImportError:
        # Fallback: use cwebp CLI
        return _convert_to_webp_cli(src_path, dest_path, max_size)
    except Exception as e:
        print(yellow(f"    WebP conversion failed: {e}"))
        return False


def _convert_to_webp_cli(src_path, dest_path, max_size=None):
    """Fallback: use cwebp command-line tool."""
    cmd = ["cwebp", "-quiet", "-q", "85"]
    if max_size:
        cmd += ["-resize", str(max_size), str(max_size)]
    cmd += [src_path, "-o", dest_path]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=30)
        return True
    except Exception as e:
        print(yellow(f"    cwebp failed: {e}"))
        return False


def has_watermark(local_path, threshold=0.18):
    """
    Detect watermarks by analyzing brightness/edge patterns.
    Returns True if image likely has a watermark overlay.

    Heuristics:
    - Watermarks usually appear as semi-transparent logos/text in corners or center
    - Detect by checking high-contrast edge density in non-content regions
    - Watermark detection: corner edge density >> content edge density
      AND corner content has text-like structure
    """
    try:
        from PIL import Image
        import numpy as np
        img = Image.open(local_path).convert("L")
        arr = np.array(img)
        h, w = arr.shape
        if h < 100 or w < 100:
            return False

        # If image is mostly uniform (no content), don't classify as watermark
        overall_std = arr.std()
        if overall_std < 5:
            return False

        # Compute edge intensity via simple gradient
        grad_x = np.abs(np.diff(arr, axis=1))
        grad_y = np.abs(np.diff(arr, axis=0))
        # Pad to original shape
        gx = np.zeros_like(arr); gx[:, 1:] = grad_x
        gy = np.zeros_like(arr); gy[1:, :] = grad_y
        edge = np.sqrt(gx.astype(float)**2 + gy.astype(float)**2)
        edge_density = (edge > 40).sum() / edge.size

        # Check corner regions (where watermarks often appear)
        corner_h, corner_w = h // 4, w // 4
        corners = [
            arr[:corner_h, :corner_w],          # top-left
            arr[:corner_h, -corner_w:],          # top-right
            arr[-corner_h:, :corner_w],          # bottom-left
            arr[-corner_h:, -corner_w:],          # bottom-right
        ]
        corner_var = np.mean([c.std() for c in corners])
        # Edge density in corners vs center
        corner_edges = []
        for c in corners:
            gx_c = np.abs(np.diff(c, axis=1))
            gy_c = np.abs(np.diff(c, axis=0))
            e_c = np.sqrt(np.pad(gx_c, ((0,0),(0,1))).astype(float)**2 +
                          np.pad(gy_c, ((0,1),(0,0))).astype(float)**2)
            corner_edges.append((e_c > 40).sum() / e_c.size)
        corner_edge_density = np.mean(corner_edges)

        # Check center region (some watermarks centered)
        ch1, ch2 = h // 3, 2 * h // 3
        cw1, cw2 = w // 3, 2 * w // 3
        center = arr[ch1:ch2, cw1:cw2]
        center_std = center.std()
        center_edge = np.sqrt(np.diff(center, axis=0, prepend=0).astype(float)**2 +
                              np.diff(center, axis=1, prepend=0).astype(float)**2)
        center_edge_density = (center_edge > 40).sum() / center_edge.size

        # Heuristic: watermark present when:
        # 1) Corners have HIGH edge density but center is relatively clean
        #    (text logos in corners typically have many high-contrast edges)
        # 2) Corner variance is significantly higher than center variance
        #    (watermark text creates variance in otherwise uniform corners)
        is_watermark = False

        # Rule 1: corner edges >> center edges (watermark logo/text in corners)
        # Require very high corner edge density AND very low center edge density
        if (center_edge_density < 0.03 and corner_edge_density > 0.20
                and corner_var > 35):
            is_watermark = True

        # Rule 2: corner variance >> center variance (text-like content in corners)
        # Require 4x ratio to avoid false positives on busy figure photos
        if (center_std > 5 and corner_var > 4 * center_std
                and corner_var > 40 and corner_edge_density > 0.15):
            is_watermark = True

        return is_watermark
    except Exception as e:
        # If we can't analyze, assume no watermark (don't block import)
        print(yellow(f"    watermark check skipped: {e}"))
        return False


def remove_watermark(local_path):
    """Remove watermark from an image using OpenCV inpainting.

    Detects watermark regions (corners/center with high edge density) and
    uses cv2.inpaint to fill them. Falls back gracefully if OpenCV is missing.
    Returns True if watermark was removed, False if no watermark or failed.
    """
    try:
        import numpy as np
        from PIL import Image
        import cv2
    except ImportError:
        return False

    try:
        img = cv2.imread(local_path)
        if img is None:
            return False
        h, w = img.shape[:2]
        if h < 100 or w < 100:
            return False

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        # Build a mask of watermark-like regions
        mask = np.zeros((h, w), dtype=np.uint8)

        # Detect text/logo regions in corners (where watermarks usually are)
        corner_h, corner_w = h // 4, w // 4
        corners = [
            (0, corner_h, 0, corner_w),           # top-left
            (0, corner_h, w - corner_w, w),        # top-right
            (h - corner_h, h, 0, corner_w),        # bottom-left
            (h - corner_h, h, w - corner_w, w),    # bottom-right
        ]

        for y1, y2, x1, x2 in corners:
            region = gray[y1:y2, x1:x2]
            # Edge detection
            edges = cv2.Canny(region, 50, 150)
            # Find high-edge-density regions (text/logos)
            kernel = np.ones((5, 5), np.uint8)
            dilated = cv2.dilate(edges, kernel, iterations=1)
            # Add to mask where edge density is high
            mask_region = dilated > 100
            mask[y1:y2, x1:x2][mask_region] = 255

        # Also check center for large watermark text
        ch1, ch2 = h // 3, 2 * h // 3
        cw1, cw2 = w // 3, 2 * w // 3
        center = gray[ch1:ch2, cw1:cw2]
        center_edges = cv2.Canny(center, 50, 150)
        center_dilated = cv2.dilate(center_edges, kernel, iterations=1)
        # Only mark center if there's significant edge content (watermark text)
        if (center_dilated > 100).sum() > (center_dilated.size * 0.05):
            mask_region = center_dilated > 100
            mask[ch1:ch2, cw1:cw2][mask_region] = 255

        # If mask is mostly empty, no watermark to remove
        if mask.sum() < 500:
            return False

        # Inpaint (TELEA algorithm — fast, good for small regions)
        result = cv2.inpaint(img, mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
        cv2.imwrite(local_path, result, [cv2.IMWRITE_JPEG_QUALITY, 95])
        return True
    except Exception as e:
        print(yellow(f"    watermark removal failed: {e}"))
        return False


def process_image(source_url, jan_code, sort_order=0, meta=None):
    """
    Full image processing pipeline:
    1. Download from source URL
    2. Compute SHA-256
    3. Convert to WebP at 3 sizes (raw, detail, thumb)
    4. Save to assets/figures/{jan_code}/ or assets/figures/no-jancode/

    Returns dict with image metadata or None on failure.
    """
    # Determine directory
    dir_name = jan_code if jan_code else "no-jancode"
    base_dir = os.path.join(ASSETS_DIR, dir_name)
    os.makedirs(base_dir, exist_ok=True)

    # Download
    tmp_path = download_image(source_url, base_dir)
    if not tmp_path:
        return None

    # Extract optional metadata (e.g. official_item_thumbnail markers).
    _meta = meta or {}
    _source_kind = _meta.get("_source_kind", "")
    _official_thumb = (_source_kind == "official_item_thumbnail")

    try:
        # Dimension check: reject thumbnails / UI icons as source images.
        # A downloaded image whose max side is below MIN_IMAGE_MAX_DIMENSION
        # is a thumbnail, not a real product image - it must not be stored as
        # the raw/detail variant. Thumbnails can only be generated locally
        # from a real source image, never imported from the remote site.
        try:
            from PIL import Image as _PILImg
            with _PILImg.open(tmp_path) as _img:
                _w, _h = _img.size
            # Official item thumbnails are small (~200x200) but are the official
            # product image; accept them at >=150px instead of the normal 600px.
            _min_dim = 150 if _official_thumb else MIN_IMAGE_MAX_DIMENSION
            if max(_w, _h) < _min_dim:
                print(yellow(
                    f"    Skipping small image (max side {max(_w, _h)}px < "
                    f"{_min_dim}px): {source_url[:60]}"
                ))
                return None
            # Aspect ratio check: reject banner/strip images (e.g. 800x120)
            # and tall strips. Suspicious if max/min > 4 (matches DB audit rule).
            _min_side = min(_w, _h)
            if _min_side > 0:
                _ratio = max(_w, _h) / float(_min_side)
                if _ratio > 4.0:
                    print(yellow(
                        f"    Skipping suspicious aspect ratio image "
                        f"({_w}x{_h}, ratio={_ratio:.1f}): {source_url[:60]}"
                    ))
                    return None
        except Exception as _dim_err:
            # If we can't read dimensions (corrupt download), skip rather than
            # risk storing a bad image as a source.
            print(yellow(f"    Skipping image (cannot read dimensions): {source_url[:60]}"))
            return None

        # Watermark detection and removal - don't skip, try to remove
        if has_watermark(tmp_path):
            print(yellow(f"    Watermark detected, attempting removal: {source_url[:60]}"))
            removed = remove_watermark(tmp_path)
            if removed:
                print(green(f"    Watermark removed via inpainting"))
            else:
                print(yellow(f"    Watermark removal skipped/failed, keeping original"))

        sha256 = compute_sha256(tmp_path)

        result = {
            "source": source_url,
            "alt": "",
            "sortOrder": sort_order,
            "sha256": sha256,
            "localPaths": {},
        }

        # Convert temporary _ prefixed metadata into the `data` JSONB field
        # expected by the API's isSafeDisplayImage() check.
        if _source_kind:
            result["data"] = {
                "source_kind": _source_kind,
                "safe_display": bool(_meta.get("_safe_display")),
                "safety_reason": _meta.get("_safety_reason", ""),
            }

        # Convert to WebP at each size
        for size_name, max_px in WEBP_SIZES.items():
            dest_filename = f"{sha256}_{size_name}.webp"
            dest_path = os.path.join(base_dir, dest_filename)
            if os.path.exists(dest_path):
                # Already processed (dedup)
                result["localPaths"][size_name] = dest_path
                continue
            ok = convert_to_webp(tmp_path, dest_path, max_size=max_px)
            if ok:
                result["localPaths"][size_name] = dest_path
            else:
                print(yellow(f"    Failed to convert {size_name} for {sha256[:12]}"))

        return result
    finally:
        # Clean up temp download
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def upload_assets_to_server(assets_dir=None, server_user="root", server_host=None):
    """
    Upload the local assets/figures/ directory to the server via scp,
    then docker cp into the API container.

    This is a best-effort operation. Requires ssh access to the server.
    """
    if assets_dir is None:
        assets_dir = ASSETS_DIR
    if not os.path.exists(assets_dir):
        print(yellow("  No assets directory to upload"))
        return

    if not server_host:
        print(yellow("  No server host specified, skipping upload. "
                      "Upload manually: scp the assets/figures/ directory to the server, "
                      "then docker cp into the API container."))
        return

    remote_tmp = f"/tmp/modelwiki_figures_{int(time.time())}"
    print(cyan(f"  Uploading assets to {server_host}:{remote_tmp}..."))

    # scp
    scp_cmd = ["scp", "-r", assets_dir, f"{server_user}@{server_host}:{remote_tmp}"]
    try:
        subprocess.run(scp_cmd, check=True, timeout=300)
        print(green(f"  SCP upload complete"))
    except Exception as e:
        print(red(f"  SCP failed: {e}"))
        return

    # docker cp
    container = "modelwiki-api"  # assumed container name
    docker_cp_cmd = [
        "ssh", f"{server_user}@{server_host}",
        f"docker cp {remote_tmp}/figures/. {container}:/app/assets/figures/ && rm -rf {remote_tmp}"
    ]
    try:
        subprocess.run(docker_cp_cmd, check=True, timeout=120)
        print(green(f"  Docker cp complete"))
    except Exception as e:
        print(red(f"  Docker cp failed: {e}"))


# ==================== AI Rewrite ====================

AI_BASE = os.environ.get("MODELWIKI_AI_BASE", "https://key.phoebusstudio.com/v1")
AI_KEY = os.environ.get("MODELWIKI_AI_KEY", "")
AI_REWRITE_MODEL = os.environ.get("MODELWIKI_REWRITE_MODEL", "gemini-3.1-flash-lite")


def ai_rewrite_description(description, title="", source="", product_kind="figure"):
    """Use AI to clean marketing copy into neutral encyclopedia-style text.

    product_kind adjusts the prompt wording so merchandise is not described as
    a scale figure (no invented scale/material/height).
    """
    if not description or len(description) < 20:
        return description
    if not AI_KEY or not AI_BASE:
        return description
    is_merch = product_kind != "figure"
    if is_merch:
        subject = "collectible product / character goods (merchandise)"
        spec_line = ("- Preserve any real specs mentioned (size, material) BUT do NOT invent scale, height, or sculptor - merchandise usually has none")
    else:
        subject = "collectible figure"
        spec_line = "- Preserve key specifications (size, material, series, sculptor if mentioned)"
    prompt = f"""Rewrite the following {subject} product description into a clean, neutral, encyclopedia-style entry. Requirements:
- Remove all marketing language, promotional phrases, and call-to-action text
- Remove any copyright notices, website URLs, or watermarks text
- Keep it factual and objective
{spec_line}
- Output in English
- Keep it under 300 characters

Product: {title}
Source: {source}
Original description:
{description}

Cleaned description:"""
    try:
        import requests as _req
        resp = _req.post(
            f"{AI_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {AI_KEY}", "Content-Type": "application/json"},
            json={"model": AI_REWRITE_MODEL, "messages": [{"role": "user", "content": prompt}],
                  "temperature": 0.3, "max_tokens": 200},
            timeout=30,
        )
        if resp.status_code != 200:
            print(yellow(f"  [ai] rewrite HTTP {resp.status_code}, keeping original"))
            return description
        data = resp.json()
        cleaned = (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
        if cleaned and len(cleaned) > 20:
            return cleaned[:900]
        return description
    except Exception as e:
        print(yellow(f"  [ai] rewrite error: {e}"))
        return description


def ai_generate_description(title, manufacturer="", scale="", category="",
                            character="", origin="", release_date="", price_jpy="",
                            source="", product_kind="figure"):
    """Generate an encyclopedia-style description when none was scraped.

    product_kind controls the prompt: figures are described as collectible
    figures (with scale/series), merchandise as collectible products /
    character goods (no invented scale/material/height).
    """
    if not AI_KEY or not AI_BASE:
        return ""
    if not title:
        return ""

    # Build context from available metadata. For merchandise, omit scale (it
    # has none) and label the product as a merchandise item, not a figure.
    is_merch = product_kind != "figure"
    if is_merch:
        context_parts = [f"Product: {title}", f"Product type: {product_kind} (merchandise / character goods)"]
    else:
        context_parts = [f"Figure: {title}"]
    if manufacturer:
        context_parts.append(f"Manufacturer: {manufacturer}")
    if scale and not is_merch:
        context_parts.append(f"Scale: {scale}")
    if category:
        context_parts.append(f"Category: {category}")
    if character:
        context_parts.append(f"Character: {character}")
    if origin:
        context_parts.append(f"Series/Origin: {origin}")
    if release_date:
        context_parts.append(f"Release date: {release_date}")
    if price_jpy:
        context_parts.append(f"Price: {price_jpy} JPY")
    context = "\n".join(context_parts)

    if is_merch:
        prompt = f"""Write a concise, factual, encyclopedia-style description for this collectible product / character goods item based on the available metadata. Requirements:
- Write in English, 2-4 sentences (100-300 characters)
- Be factual and objective - no marketing language, no call-to-action
- Describe what the product is, its character/series, manufacturer, and notable features
- If the product is from a known anime/game series, mention the series name
- Do NOT invent scale, height, material, or sculptor - merchandise usually has none of these; only mention a spec if it was explicitly provided in the metadata
- Do NOT include pricing or availability info
- Output ONLY the description text, no labels or prefixes

Metadata:
{context}

Description:"""
    else:
        prompt = f"""Write a concise, factual, encyclopedia-style description for this collectible figure based on the available metadata. Requirements:
- Write in English, 2-4 sentences (100-300 characters)
- Be factual and objective - no marketing language
- Describe what the figure is, its character/series, manufacturer, scale, and notable features
- If the figure is from a known anime/game series, mention the series name
- Do NOT invent specifications not provided (height, material, sculptor) - only use given info
- Do NOT include pricing or availability info
- Output ONLY the description text, no labels or prefixes

Metadata:
{context}

Description:"""
    try:
        import requests as _req
        resp = _req.post(
            f"{AI_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {AI_KEY}", "Content-Type": "application/json"},
            json={"model": AI_REWRITE_MODEL, "messages": [{"role": "user", "content": prompt}],
                  "temperature": 0.4, "max_tokens": 250},
            timeout=30,
        )
        if resp.status_code != 200:
            print(yellow(f"  [ai] generate HTTP {resp.status_code}"))
            return ""
        data = resp.json()
        generated = (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
        if generated and len(generated) > 30:
            return generated[:900]
        return ""
    except Exception as e:
        print(yellow(f"  [ai] generate error: {e}"))
        return ""


# ---------------------------------------------------------------------------
# Main scraper class
# ---------------------------------------------------------------------------

class FigureScraper:
    """Multi-source figure scraper with JAN Code merge support."""

    SOURCES = {
        "mfc": {
            "name": "MyFigureCollection",
            "base_url": MFC_BASE,
            "item_url": MFC_ITEM_URL,
        },
        "amiami": {
            "name": "AmiAmi",
            "base_url": AMIAMI_BASE,
            "detail_url": AMIAMI_DETAIL_URL,
        },
        "hobbysearch": {
            "name": "Hobby Search",
            "base_url": HOBBYSEARCH_BASE,
            "search_url": HOBBYSEARCH_SEARCH_URL,
            "detail_url": HOBBYSEARCH_DETAIL_URL,
        },
    }

    def __init__(self, password=None, source="mfc", dry_run=False, report_path=None, submit_review=False, ai_rewrite=False):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.token = None
        self.pw = None
        self.ctx = None
        self.page = None
        self.password = password or DEFAULT_PASSWORD
        self.source = source
        self.dry_run = dry_run
        self.submit_review = submit_review
        self.ai_rewrite = ai_rewrite
        self.report = JsonlReport(report_path)
        self.sources_to_run = [source] if source != "all" else ["mfc", "amiami", "hobbysearch"]
        self.manufacturers = {}
        self.category_map = {}
        self.discovered = {}
        self.progress = {"completed": [], "failed": [], "skipped": [], "merged": []}
        self.stats = {"discovered": 0, "created": 0, "skipped": 0, "failed": 0, "merged": 0}
        self.processed_images = []  # track for batch upload
        # MFC cookie cache: dict of name->value for myfigurecollection.net domain.
        # Populated lazily from the Chrome profile SQLite DB, or refreshed after
        # a Cloudflare clearance is obtained via the stealth browser. Invalidated
        # whenever a curl_cffi request hits a CF block so the next attempt will
        # re-read the profile / re-solve the challenge.
        self._mfc_cookie_cache = None
        # Path to the persistent Chrome profile used for MFC Cloudflare clearance.
        # This profile accumulates cf_clearance + session cookies across runs,
        # which dramatically improves the success rate of curl_cffi requests.
        self._chrome_profile_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "patchright_profile2")

    # ------------------------------------------------------------------
    # Auth & API helpers
    # ------------------------------------------------------------------

    def login(self):
        pwd = self.password
        resp = self.session.post(f"{API_BASE}/auth/login",
                                  json={"username": ADMIN_USER, "password": pwd})
        data = resp.json()
        if data.get("success"):
            self.token = data["data"]["token"]
            print(green("Logged in."))
        else:
            print(red(f"Login failed: {data}"))
            sys.exit(1)

    def api_headers(self):
        return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}

    def find_figure_by_jan(self, jan_code):
        """Check if a figure with this JAN code already exists. Returns figure data or None."""
        if not jan_code:
            return None
        try:
            resp = self.session.get(
                f"{API_BASE}/figures",
                params={"search": jan_code},
                headers=self.api_headers(),
            )
            data = resp.json()
            if data.get("success") and data.get("data"):
                for fig in data["data"]:
                    if fig.get("janCode") == jan_code:
                        return fig
        except Exception as e:
            print(yellow(f"  JAN lookup error: {e}"))
        return None

    def find_figure_by_slug(self, slug):
        """Check if a figure with this exact slug already exists."""
        if not slug:
            return None
        try:
            resp = self.session.get(
                f"{API_BASE}/figures/{slug}",
                headers=self.api_headers(),
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code == 404:
                return None
            data = resp.json()
            if data.get("success") and data.get("data"):
                return data["data"]
        except Exception as e:
            print(yellow(f"  Slug lookup error: {e}"))
        return None

    def find_figure_by_source_id(self, field, value):
        """Find an existing figure by source-specific ID when the API search supports it."""
        if not value:
            return None
        try:
            resp = self.session.get(
                f"{API_BASE}/figures",
                params={"search": str(value), "perPage": 10},
                headers=self.api_headers(),
                timeout=REQUEST_TIMEOUT,
            )
            data = resp.json()
            if data.get("success") and data.get("data"):
                for fig in data["data"]:
                    if str(fig.get(field) or "") == str(value):
                        return fig
        except Exception as e:
            print(yellow(f"  Source ID lookup error ({field}={value}): {e}"))
        return None

    def find_existing_figure(self, payload):
        """Return an existing figure and the reason it matched, or (None, None).

        Matching priority:
        1. Strong match: JAN code
        2. Strong match: source-specific ID (mfcId / amiamiId / hobbySearchId)
        3. Exact slug match
        4. Soft match: normalized name + manufacturer + release year + productKind
           High-confidence soft matches are returned for merge; low-confidence
           matches are NOT returned here (they are only used for slug-conflict
           review inside _create_figure).
        """
        jan_code = payload.get("janCode")
        if jan_code:
            existing = self.find_figure_by_jan(jan_code)
            if existing:
                return existing, f"JAN {jan_code}"

        for field in ("mfcId", "amiamiId", "hobbySearchId"):
            value = payload.get(field)
            if not value:
                continue
            existing = self.find_figure_by_source_id(field, value)
            if existing:
                return existing, f"{field} {value}"

        slug = payload.get("slug")
        existing = self.find_figure_by_slug(slug)
        if existing:
            return existing, f"slug {slug}"

        # Soft match: search by normalized name and score candidates
        soft_existing, soft_reason = self._soft_match_lookup(payload)
        if soft_existing:
            return soft_existing, soft_reason

        return None, None

    def _soft_match_lookup(self, payload):
        """Search the API for name-based candidates and return a high-confidence match.

        Returns (existing, reason) or (None, None). Only high-confidence candidates
        are returned for automatic merge; low-confidence ones require human review
        and are surfaced only via _soft_match_confidence() in the slug-conflict path.
        """
        name = payload.get("name") or payload.get("nameEn") or ""
        if not name or len(name) < 4:
            return None, None
        try:
            # Use the API search with the raw name
            resp = self.session.get(
                f"{API_BASE}/figures",
                params={"search": name, "perPage": 20},
                headers=self.api_headers(),
                timeout=REQUEST_TIMEOUT,
            )
            data = resp.json()
            if not data.get("success") or not data.get("data"):
                return None, None
            candidates = data.get("data", [])
        except Exception as e:
            print(yellow(f"  soft-match search error: {e}"))
            return None, None

        payload_norm = normalize_name_for_match(name)
        if not payload_norm:
            return None, None

        best = None
        best_reason = None
        best_score = 0.0
        for cand in candidates:
            # Skip candidates that differ on a strong key (JAN / source ID)
            payload_jan = (payload.get("janCode") or "").strip()
            cand_jan = (cand.get("janCode") or "").strip()
            if payload_jan and cand_jan and payload_jan != cand_jan:
                continue
            confident, reason, score = self._soft_match_confidence(payload, cand, _return_score=True)
            if confident and score > best_score:
                best = cand
                best_reason = reason
                best_score = score
        if best:
            return best, f"soft-match:{best_reason}"
        return None, None

    def _soft_match_confidence(self, payload, existing, _return_score=False):
        """Return (confident, reason) for whether payload and existing are the same product.

        Confidence is high when:
        - normalized names are identical (or one contains the other), AND
        - manufacturer matches OR release year matches OR productKind matches, AND
        - no strong key conflicts (JAN / source ID)

        If _return_score is True, also returns the numeric score as the third
        element (used internally to pick the best candidate).
        """
        payload_name = payload.get("name") or payload.get("nameEn") or ""
        existing_name = existing.get("name") or existing.get("nameEn") or ""
        payload_norm = normalize_name_for_match(payload_name)
        existing_norm = normalize_name_for_match(existing_name)
        if not payload_norm or not existing_norm:
            if _return_score:
                return False, "empty_name", 0.0
            return False, "empty_name"

        # Strong key conflict -> never match
        for field in ("janCode", "mfcId", "amiamiId", "hobbySearchId"):
            pv = (payload.get(field) or "").strip()
            ev = (existing.get(field) or "").strip()
            if pv and ev and pv != ev:
                if _return_score:
                    return False, f"{field}_conflict", 0.0
                return False, f"{field}_conflict"

        # Name match: exact normalized, or one contains the other
        name_match = False
        if payload_norm == existing_norm:
            name_match = True
        elif payload_norm in existing_norm or existing_norm in payload_norm:
            name_match = True
        elif len(payload_norm) > 8 and len(existing_norm) > 8:
            # Token overlap ratio
            p_tokens = set(payload_norm.split())
            e_tokens = set(existing_norm.split())
            if p_tokens and e_tokens:
                overlap = len(p_tokens & e_tokens) / max(len(p_tokens), len(e_tokens))
                if overlap >= 0.8:
                    name_match = True
        if not name_match:
            if _return_score:
                return False, "name_mismatch", 0.0
            return False, "name_mismatch"

        # Secondary signal: manufacturer / release year / productKind
        score = 0.5 if name_match else 0.0
        reasons = []
        payload_mfr = normalize_manufacturer_name(payload.get("manufacturer") or "")
        existing_mfr = normalize_manufacturer_name(existing.get("manufacturer") or "")
        if payload_mfr and existing_mfr and payload_mfr.lower() == existing_mfr.lower():
            score += 0.2
            reasons.append("manufacturer")
        # Release year
        payload_year = ""
        if payload.get("releaseDate"):
            ym = re.findall(r"\b(20\d{2})\b", str(payload.get("releaseDate")))
            if ym:
                payload_year = ym[0]
        existing_year = ""
        if existing.get("releaseDate"):
            ym = re.findall(r"\b(20\d{2})\b", str(existing.get("releaseDate")))
            if ym:
                existing_year = ym[0]
        if payload_year and existing_year and payload_year == existing_year:
            score += 0.15
            reasons.append("release_year")
        # productKind: payload may carry product_kind; existing we infer from name/category
        payload_kind = payload.get("product_kind") or classify_product_kind(
            payload_name, payload.get("category", ""), payload.get("scale", "")
        )
        existing_kind = classify_product_kind(
            existing_name, existing.get("category", ""), existing.get("scale", "")
        )
        if payload_kind and existing_kind and payload_kind == existing_kind:
            score += 0.15
            reasons.append("productKind")

        # High confidence threshold: name match + at least one secondary signal
        confident = score >= 0.65
        reason = "name+" + "+".join(reasons) if reasons else "name_only"
        if _return_score:
            return confident, reason, score
        return confident, reason

    def update_figure(self, figure_slug, payload):
        """Update an existing figure (merge mode)."""
        try:
            resp = self.session.put(
                f"{API_BASE}/figures/{figure_slug}",
                json=payload,
                headers=self.api_headers(),
            )
            if resp.status_code in (200, 201):
                print(green(f"    Merged into figure {figure_slug}"))
                result = resp.json()
                meta = result.get("meta", {})
                image_import = meta.get("imageImport") or {}
                if image_import.get("errors"):
                    print(yellow(f"    Image import warnings: {len(image_import.get('errors', []))} failed"))
                    self.report.write("figure_image_import_warning", slug=figure_slug, meta=meta)
                return result.get("data", {})
            else:
                print(red(f"    Merge update failed [{resp.status_code}]: {resp.text[:200]}"))
                return None
        except Exception as e:
            print(red(f"    Merge update exception: {e}"))
            return None

    # ------------------------------------------------------------------
    # Progress & data loading
    # ------------------------------------------------------------------

    def load_progress(self):
        if os.path.exists(PROGRESS_FILE):
            with open(PROGRESS_FILE) as f:
                self.progress = json.load(f)
        if os.path.exists(DISCOVERED_FILE):
            with open(DISCOVERED_FILE) as f:
                self.discovered = json.load(f)
            print(cyan(f"Loaded {len(self.discovered)} discovered items"))

    def save_progress(self):
        with open(PROGRESS_FILE, "w") as f:
            json.dump(self.progress, f, ensure_ascii=False)

    def save_discovered(self):
        with open(DISCOVERED_FILE, "w") as f:
            json.dump(self.discovered, f, ensure_ascii=False, indent=2)

    def load_manufacturers(self):
        print(cyan("Loading manufacturers from API..."))
        try:
            self.manufacturers = {}
            page = 1
            while True:
                resp = self.session.get(
                    f"{API_BASE}/manufacturers",
                    params={"perPage": 100, "page": page},
                    headers=self.api_headers(),
                    timeout=REQUEST_TIMEOUT,
                )
                data = resp.json()
                if not data.get("success"):
                    break
                for m in data.get("data", []):
                    self._remember_manufacturer(m)
                meta = data.get("meta") or {}
                if page >= int(meta.get("totalPages") or 1):
                    break
                page += 1
            print(f"  Loaded {len(self.manufacturers)} manufacturer aliases")
        except Exception as e:
            print(yellow(f"  Warning: Could not load manufacturers: {e}"))

    def _remember_manufacturer(self, manufacturer):
        for name_key in ("name", "nameEn", "nameJp"):
            value = manufacturer.get(name_key)
            if value:
                self.manufacturers[value.lower().strip()] = manufacturer

    def load_categories(self):
        print(cyan("Loading categories from API..."))
        try:
            resp = self.session.get(f"{API_BASE}/categories",
                                     headers=self.api_headers())
            data = resp.json()
            if data.get("success"):
                def collect(cats):
                    for c in cats:
                        self.category_map[c["slug"]] = c["id"]
                        if c.get("children"):
                            collect(c["children"])
                collect(data.get("data", []))
                print(f"  Loaded {len(self.category_map)} category entries")
        except Exception as e:
            print(yellow(f"  Warning: Could not load categories: {e}"))

    def match_manufacturer(self, name):
        name = normalize_manufacturer_name(name)
        if not name:
            return None
        name_lower = name.lower().strip()
        if name_lower in self.manufacturers:
            return self.manufacturers[name_lower]

        # Punctuation-insensitive normalization for fuzzy matching
        # e.g., "Phat Company" should match "Phat! Company"
        def _strip_punct(s):
            return re.sub(r'[^a-z0-9]', '', s.lower())

        name_nopunct = _strip_punct(name)

        for db_name, mfr in self.manufacturers.items():
            if name_lower in db_name or db_name in name_lower:
                return mfr
            if name_lower.split()[0] == db_name.split()[0] and len(name_lower.split()[0]) > 3:
                return mfr
            # Punctuation-insensitive exact match (handles "Phat!" vs "Phat")
            if name_nopunct and name_nopunct == _strip_punct(db_name):
                return mfr
        return None

    def ensure_manufacturer(self, name):
        """Find or create a manufacturer for high-confidence scraped names."""
        name = normalize_manufacturer_name(name)
        if not name:
            return None
        existing = self.match_manufacturer(name)
        if existing:
            return existing
        if self.dry_run:
            return None

        slug_base = slugify(name) or f"manufacturer-{abs(hash(name)) % 100000}"
        payload = {
            "slug": slug_base[:80],
            "name": name,
            "nameEn": name,
        }
        try:
            resp = self.session.post(
                f"{API_BASE}/manufacturers",
                json=payload,
                headers=self.api_headers(),
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code in (200, 201):
                manufacturer = resp.json().get("data")
                if manufacturer:
                    self._remember_manufacturer(manufacturer)
                    self.report.write("manufacturer_created", name=name, slug=manufacturer.get("slug"), id=manufacturer.get("id"))
                    print(cyan(f"    Created manufacturer: {name}"))
                    return manufacturer
            if resp.status_code == 409:
                self.load_manufacturers()
                return self.match_manufacturer(name)
            self.report.write("manufacturer_create_failed", name=name, status=resp.status_code, error=resp.text[:300])
            print(yellow(f"    Could not create manufacturer {name}: {resp.status_code}"))
        except Exception as exc:
            self.report.write("manufacturer_create_exception", name=name, error=str(exc))
            print(yellow(f"    Manufacturer create exception for {name}: {exc}"))
        return None

    # ------------------------------------------------------------------
    # Browser management
    # ------------------------------------------------------------------

    def start_browser(self):
        print(cyan("Starting visible browser (Chrome + Stealth)..."))
        self.pw = sync_playwright().start()
        profile = os.path.join(os.path.dirname(__file__), "patchright_profile2")
        self.ctx = self.pw.chromium.launch_persistent_context(
            user_data_dir=profile,
            channel="chrome",
            headless=False,
            no_viewport=True,
            locale="en-US",
            timezone_id="Europe/Paris",
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        self.page = self.ctx.new_page()
        s = Stealth(
            navigator_languages=["en-US", "en"],
            navigator_vendor="Google Inc.",
            navigator_platform="Win32",
            webgl_vendor="Intel Inc.",
            webgl_renderer_override="Intel Iris OpenGL Engine",
            hairline=True,
        )
        s.apply_stealth_sync(self.page)
        print(green("  Browser ready"))

    def stop_browser(self):
        if self.ctx:
            try:
                self.ctx.close()
            except Exception:
                pass
        if self.pw:
            try:
                self.pw.stop()
            except Exception:
                pass

    @staticmethod
    def _upgrade_amiami_image_url(url):
        """Upgrade an AmiAmi product image URL to a larger variant when possible.

        AmiAmi image path layout:
            /images/product/{thumb|main|review|review_big}/NNN/ID(_NN).jpg

        - /thumb/      ~75px  (search result thumbnails)  -> upgrade to /main/
        - /main/       ~500px (detail page main image)    -> keep as-is
        - /review/     ~500px (detail page gallery thumbnails) -> keep as-is
        - /review_big/ ~1000px (full-size gallery images) -> keep as-is

        We only upgrade /thumb/ to /main/ (which is always available for any
        product that has a thumbnail). We do NOT aggressively rewrite to
        /review_big/ because not all products have that variant, causing 404s.
        """
        if not url:
            return url
        # Only upgrade /thumb/ to /main/ (safe: if thumb exists, main exists too)
        upgraded = re.sub(
            r'/images/product/thumb/',
            '/images/product/main/',
            url,
        )
        return upgraded

    # ------------------------------------------------------------------
    # MFC scraping
    # ------------------------------------------------------------------

    def _load_mfc_cookies_from_chrome_profile(self):
        """Read MFC cookies directly from the Chrome profile SQLite DB.

        Returns a dict {name: value} for cookies matching *.myfigurecollection.net.
        Returns {} if the DB cannot be read or no MFC cookies exist. Does NOT
        launch a browser - this is a cheap read for cached cf_clearance.
        """
        if self._mfc_cookie_cache is not None:
            return self._mfc_cookie_cache
        cookies = {}
        db_path = os.path.join(self._chrome_profile_path, "Default", "Cookies")
        if not os.path.exists(db_path):
            self._mfc_cookie_cache = {}
            return cookies
        try:
            import sqlite3
            import shutil
            import tempfile
            # Chrome may hold a lock on the DB; copy it to a temp file to read.
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=".db")
            os.close(tmp_fd)
            shutil.copy2(db_path, tmp_path)
            try:
                conn = sqlite3.connect(tmp_path)
                cur = conn.cursor()
                # Chrome cookie schema (v20+): host_key, name, value, encrypted_value, ...
                # encrypted_value is empty for non-sensitive cookies like cf_clearance
                # in many cases; we skip encrypted ones we cannot decrypt.
                cur.execute(
                    "SELECT host_key, name, value, encrypted_value FROM cookies "
                    "WHERE host_key LIKE '%myfigurecollection.net%'"
                )
                for host_key, name, value, encrypted in cur.fetchall():
                    if value:
                        cookies[name] = value
                    # encrypted_value requires OS keychain to decrypt; skip silently
                conn.close()
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
        except Exception as e:
            print(f"  warn: could not read Chrome profile cookies: {e}")
        self._mfc_cookie_cache = cookies
        return cookies

    def _invalidate_mfc_cookie_cache(self):
        """Force next _load to re-read the profile / re-solve CF."""
        self._mfc_cookie_cache = None

    def _solve_mfc_cloudflare_via_browser(self, target_url=None):
        """Launch stealth Chrome, visit MFC, wait for Cloudflare clearance,
        then extract cookies and cache them.

        Visits target_url if given (preferred - solves CF on the actual item page),
        otherwise visits MFC_BASE. Waits up to 30s for the "Just a Moment"
        challenge to resolve (page title changes from "Just a moment..." to
        something else, or cf_clearance cookie appears).

        Returns dict {name: value} of MFC cookies on success, {} on failure.
        Does NOT raise - the caller decides whether to defer.
        """
        cookies_out = {}
        visit_url = target_url or MFC_BASE
        # Use the dedicated MFC browser launcher so we do not disturb the
        # amiami/hobbysearch browser context that may already be running.
        pw = None
        ctx = None
        try:
            from patchright.sync_api import sync_playwright
            from playwright_stealth.stealth import Stealth
            pw = sync_playwright().start()
            ctx = pw.chromium.launch_persistent_context(
                user_data_dir=self._chrome_profile_path,
                channel="chrome",
                headless=False,
                no_viewport=True,
                locale="en-US",
                timezone_id="Europe/Paris",
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            )
            page = ctx.new_page()
            s = Stealth(
                navigator_languages=["en-US", "en"],
                navigator_vendor="Google Inc.",
                navigator_platform="Win32",
                webgl_vendor="Intel Inc.",
                webgl_renderer_override="Intel Iris OpenGL Engine",
                hairline=True,
            )
            s.apply_stealth_sync(page)
            try:
                page.goto(visit_url, wait_until="domcontentloaded", timeout=PLAYWRIGHT_TIMEOUT)
            except Exception as e:
                print(f"  CF solver: initial goto failed: {e}")
            # Wait up to 30s for CF challenge to clear. Detection heuristics:
            #   - title no longer contains "just a moment"
            #   - cf_clearance cookie appears in context cookies
            import time as _t
            deadline = _t.time() + 30
            cleared = False
            while _t.time() < deadline:
                try:
                    title = page.title() or ""
                except Exception:
                    title = ""
                if "just a moment" not in title.lower():
                    cleared = True
                    break
                _t.sleep(1.0)
            # Give a small grace period for cookies to settle after clearance
            if cleared:
                _t.sleep(2.0)
            # Extract MFC cookies from the browser context
            try:
                raw_cookies = ctx.cookies(urls=[MFC_BASE, f"{MFC_BASE}/"])
                for c in raw_cookies:
                    name = c.get("name", "")
                    value = c.get("value", "")
                    if name and value:
                        cookies_out[name] = value
            except Exception as e:
                print(f"  CF solver: cookie extraction failed: {e}")
            # Specifically check for cf_clearance to report success
            has_cf = "cf_clearance" in cookies_out
            print(f"  CF solver: cleared={cleared} cf_clearance={has_cf} cookies={len(cookies_out)}")
        except Exception as e:
            print(f"  CF solver error: {type(e).__name__}: {e}")
        finally:
            if ctx:
                try:
                    ctx.close()
                except Exception:
                    pass
            if pw:
                try:
                    pw.stop()
                except Exception:
                    pass
        if cookies_out:
            self._mfc_cookie_cache = cookies_out
        return cookies_out

    def _mfc_fetch_via_curl_cffi(self, url, cookies=None):
        """Fetch a URL via curl_cffi impersonating chrome, with optional cookies.

        Returns (resp, html_or_empty). Raises CloudflareBlockError if the
        response is a CF block. Raises other exceptions on network errors.
        """
        from curl_cffi import requests as crequests
        headers = dict(HEADERS)
        resp = crequests.get(
            url,
            headers=headers,
            cookies=cookies or {},
            impersonate="chrome120",
            timeout=REQUEST_TIMEOUT,
        )
        detect_cloudflare_block(resp)
        html = resp.text if resp.status_code == 200 else ""
        return resp, html

    def search_mfc(self, query, max_results=30):
        encoded = quote(query)
        url = (
            f"{MFC_BASE}/?keywords={encoded}"
            f"&_tb=item&tb=item&root=0&isDraft=0&output=2&separator=0"
            f"&current=category&listId=0&noReleaseDate=0&releaseTypeId=0&ratingId=0"
            f"&sort=release&order=desc"
        )
        try:
            self.page.goto(url, wait_until="domcontentloaded", timeout=PLAYWRIGHT_TIMEOUT)
        except Exception:
            return []
        for attempt in range(4):
            cf_present = self.page.query_selector("input[name='cf-turnstile-response']")
            has_items = self.page.query_selector("a[href*='/item/'][href*='/item/1']")
            if not cf_present and has_items:
                break
            if cf_present and attempt == 3:
                return []
            time.sleep(5)
            try:
                self.page.reload(wait_until="domcontentloaded", timeout=15000)
            except Exception:
                pass
        time.sleep(1.5 + random.uniform(0.5, 2))

        results = []
        seen = set()

        item_icons = self.page.query_selector_all(".item-icon")
        for icon in item_icons:
            if len(results) >= max_results:
                break
            link = icon.query_selector("a[href*='/item/']")
            if not link:
                continue
            href = link.get_attribute("href") or ""
            m = re.search(r'/item/(\d+)', href)
            if not m or len(m.group(1)) < 6:
                continue
            item_id = m.group(1)
            if item_id in seen:
                continue
            seen.add(item_id)

            img = icon.query_selector("img")
            raw_name = (img.get_attribute("alt") or "").strip() if img else ""
            if not raw_name:
                raw_name = link.inner_text().strip()
            if not raw_name or raw_name.upper() == "DRAFT" or len(raw_name) < 2:
                continue

            results.append({"id": item_id, "name": raw_name, "url": f"{MFC_ITEM_URL}/{item_id}"})

        if not results:
            links = self.page.query_selector_all("a[href*='/item/']")
            for link in links:
                href = link.get_attribute("href") or ""
                m = re.search(r'/item/(\d+)', href)
                if not m or len(m.group(1)) < 6:
                    continue
                item_id = m.group(1)
                if item_id in seen:
                    continue
                seen.add(item_id)
                img = link.query_selector("img")
                raw_name = (img.get_attribute("alt") or "").strip() if img else ""
                if not raw_name:
                    raw_name = link.inner_text().strip()
                if raw_name and raw_name.upper() != "DRAFT" and len(raw_name) > 2:
                    results.append({"id": item_id, "name": raw_name, "url": f"{MFC_ITEM_URL}/{item_id}"})
                if len(results) >= max_results:
                    break
        return results

    def _extract_mfc_full_images_via_browser(self, item_url, cookies, item_id, soup_thumbnail_hrefs):
        """Phase A + B: Use Playwright to click thumbnails / open picture pages
        and extract full-size image URLs.

        Called when static HTML parsing yielded insufficient /upload/pictures/
        large images. Launches a stealth Chrome browser (separate context, like
        _solve_mfc_cloudflare_via_browser), navigates to the item page, collects
        thumbnail candidates, and for each one tries:
          a. If thumbnail is inside an <a href> pointing to /picture/{id}, open
             that picture page and extract the full image.
          b. Otherwise, click the thumbnail and wait for a modal/lightbox, then
             extract the full image from the modal.

        Returns (full_image_urls, stats_dict) where stats_dict contains:
          thumbnail_candidates_count, full_image_candidates_count,
          clicked_thumbnail_count, modal_open_success_count,
          picture_page_success_count, rejected_thumbnail_count
        """
        stats = {
            "thumbnail_candidates_count": 0,
            "full_image_candidates_count": 0,
            "clicked_thumbnail_count": 0,
            "modal_open_success_count": 0,
            "picture_page_success_count": 0,
            "rejected_thumbnail_count": 0,
            "image_relevance_checked_count": 0,
            "image_relevance_pass_count": 0,
            "image_relevance_fail_count": 0,
            "rejected_unrelated_picture_count": 0,
        }
        full_images = []
        pw = None
        ctx = None
        try:
            pw = sync_playwright().start()
            ctx = pw.chromium.launch_persistent_context(
                user_data_dir=self._chrome_profile_path,
                channel="chrome",
                headless=False,
                no_viewport=True,
                locale="en-US",
                timezone_id="Europe/Paris",
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            )
            # Inject cookies if provided so the session is authenticated.
            if cookies:
                try:
                    pw_cookies = []
                    for name, value in cookies.items():
                        pw_cookies.append({
                            "name": name,
                            "value": value,
                            "domain": ".myfigurecollection.net",
                            "path": "/",
                        })
                    ctx.add_cookies(pw_cookies)
                except Exception as e:
                    print(f"  MFC img browser: add_cookies failed: {e}")

            page = ctx.new_page()
            s = Stealth(
                navigator_languages=["en-US", "en"],
                navigator_vendor="Google Inc.",
                navigator_platform="Win32",
                webgl_vendor="Intel Inc.",
                webgl_renderer_override="Intel Iris OpenGL Engine",
                hairline=True,
            )
            s.apply_stealth_sync(page)

            try:
                page.goto(item_url, wait_until="domcontentloaded", timeout=PLAYWRIGHT_TIMEOUT)
            except Exception as e:
                print(f"  MFC img browser: initial goto failed: {e}")
            # Bail out immediately if a CF challenge is still showing.
            try:
                title = page.title() or ""
            except Exception:
                title = ""
            if "just a moment" in title.lower():
                print("  MFC img browser: CF challenge detected, aborting browser phase")
                return full_images, stats

            time.sleep(3.0)

            # --- Phase A: collect thumbnail candidates ---
            # Each candidate is a dict: {href, src, alt, kind}
            #   kind="picture"  -> <a href="/picture/{id}"> wrapping an <img>
            #   kind="click"    -> <img src="/upload/..."> without a picture link
            candidates = []
            seen_keys = set()

            # a. Anchors pointing to /picture/{id}
            try:
                anchors = page.query_selector_all("a[href*='/picture/']")
            except Exception:
                anchors = []
            for a in anchors:
                try:
                    href = a.get_attribute("href") or ""
                    img_el = a.query_selector("img")
                    src = ""
                    alt = ""
                    if img_el:
                        src = img_el.get_attribute("src") or ""
                        alt = img_el.get_attribute("alt") or ""
                    if not href:
                        continue
                    full_href = href if href.startswith("http") else f"{MFC_BASE}{href}"
                    key = full_href
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    candidates.append({
                        "href": full_href,
                        "src": src,
                        "alt": alt,
                        "kind": "picture",
                    })
                except Exception:
                    continue
                if len(candidates) >= MAX_IMAGES:
                    break

            # b. Raw <img src*='/upload/'> from myfigurecollection (no picture link)
            if len(candidates) < MAX_IMAGES:
                try:
                    imgs = page.query_selector_all("img[src*='/upload/']")
                except Exception:
                    imgs = []
                for img_el in imgs:
                    try:
                        src = img_el.get_attribute("src") or ""
                        alt = img_el.get_attribute("alt") or ""
                        if not src or "myfigurecollection" not in src:
                            continue
                        # Skip /upload/items/ related-item thumbnails: they are
                        # not pictures of this item. Only accept if the src
                        # looks like a real product image (pictures or large).
                        if "/upload/items/" in src and "/upload/pictures/" not in src:
                            continue
                        key = src
                        if key in seen_keys:
                            continue
                        seen_keys.add(key)
                        candidates.append({
                            "href": "",
                            "src": src,
                            "alt": alt,
                            "kind": "click",
                        })
                    except Exception:
                        continue
                    if len(candidates) >= MAX_IMAGES:
                        break

            # Also honour picture hrefs collected from the static soup, in case
            # the DOM query above missed some (lazy-loaded, etc.).
            for href in (soup_thumbnail_hrefs or []):
                if href in seen_keys:
                    continue
                seen_keys.add(href)
                candidates.append({
                    "href": href,
                    "src": "",
                    "alt": "",
                    "kind": "picture",
                })
                if len(candidates) >= MAX_IMAGES:
                    break

            stats["thumbnail_candidates_count"] = len(candidates)
            print(f"  MFC img browser: {len(candidates)} thumbnail candidates for item {item_id}")

            # --- Phase B: process each candidate ---
            for cand in candidates:
                if len(full_images) >= MAX_IMAGES:
                    break
                href = cand.get("href") or ""
                try:
                    if cand["kind"] == "picture" and href:
                        # Open the picture page and extract the full image.
                        try:
                            page.goto(href, wait_until="domcontentloaded", timeout=PLAYWRIGHT_TIMEOUT)
                        except Exception as e:
                            print(f"  MFC img browser: goto picture page failed: {e}")
                            stats["rejected_thumbnail_count"] += 1
                            continue
                        time.sleep(2.0)
                        # Abort if CF challenge appears on the picture page.
                        try:
                            ptitle = page.title() or ""
                        except Exception:
                            ptitle = ""
                        if "just a moment" in ptitle.lower():
                            print("  MFC img browser: CF challenge on picture page, aborting")
                            stats["rejected_thumbnail_count"] += 1
                            break
                        stats["image_relevance_checked_count"] += 1
                        pic_url = self._extract_full_image_from_picture_page(page, item_id=item_id)
                        if pic_url:
                            full_images.append(pic_url)
                            stats["picture_page_success_count"] += 1
                            stats["clicked_thumbnail_count"] += 1
                            stats["image_relevance_pass_count"] += 1
                        else:
                            stats["rejected_thumbnail_count"] += 1
                            stats["image_relevance_fail_count"] += 1
                            stats["rejected_unrelated_picture_count"] += 1
                        # Return to the item page for the next candidate.
                        try:
                            page.goto(item_url, wait_until="domcontentloaded", timeout=PLAYWRIGHT_TIMEOUT)
                            time.sleep(1.0)
                        except Exception:
                            pass
                    else:
                        # Click the thumbnail and wait for a modal/lightbox.
                        target_el = None
                        try:
                            if cand.get("src"):
                                target_el = page.query_selector(f"img[src='{cand['src']}']")
                            if not target_el and cand.get("href"):
                                target_el = page.query_selector(f"a[href*='{cand['href']}']")
                        except Exception:
                            target_el = None
                        if not target_el:
                            stats["rejected_thumbnail_count"] += 1
                            continue
                        try:
                            target_el.scroll_into_view_if_needed(timeout=5000)
                        except Exception:
                            pass
                        try:
                            target_el.click(timeout=5000)
                        except Exception as e:
                            print(f"  MFC img browser: click failed: {e}")
                            stats["rejected_thumbnail_count"] += 1
                            continue
                        stats["clicked_thumbnail_count"] += 1
                        # Wait for a modal / lightbox / large image to appear.
                        modal_sel = "div[class*='modal'], div[class*='lightbox'], img[class*='large'], img[class*='big']"
                        modal_found = False
                        try:
                            page.wait_for_selector(modal_sel, timeout=5000)
                            modal_found = True
                        except Exception:
                            modal_found = False
                        if modal_found:
                            modal_url = self._extract_full_image_from_modal(page)
                            if modal_url:
                                full_images.append(modal_url)
                                stats["modal_open_success_count"] += 1
                            else:
                                stats["rejected_thumbnail_count"] += 1
                            # Close the modal: Escape first, then close button.
                            try:
                                page.keyboard.press("Escape")
                            except Exception:
                                pass
                            try:
                                close_btn = page.query_selector("button[class*='close'], a[class*='close'], .modal-close")
                                if close_btn:
                                    close_btn.click(timeout=2000)
                            except Exception:
                                pass
                            time.sleep(0.5)
                        else:
                            stats["rejected_thumbnail_count"] += 1
                except Exception as e:
                    print(f"  MFC img browser: candidate error: {type(e).__name__}: {e}")
                    stats["rejected_thumbnail_count"] += 1
                    continue
                # Human-like delay between clicks.
                time.sleep(random.uniform(1.5, 4.0))

            # Deduplicate by URL (without query string).
            seen_urls = set()
            deduped = []
            for u in full_images:
                clean = u.split("?")[0]
                if clean and clean not in seen_urls:
                    seen_urls.add(clean)
                    deduped.append(u)
            full_images = deduped[:MAX_IMAGES]
            stats["full_image_candidates_count"] = len(full_images)
            print(
                f"  MFC img browser: extracted {len(full_images)} full images "
                f"(picture_pages={stats['picture_page_success_count']} "
                f"modals={stats['modal_open_success_count']} "
                f"rejected={stats['rejected_thumbnail_count']})"
            )
        except Exception as e:
            print(f"  MFC img browser error: {type(e).__name__}: {e}")
        finally:
            if ctx:
                try:
                    ctx.close()
                except Exception:
                    pass
            if pw:
                try:
                    pw.stop()
                except Exception:
                    pass
        return full_images, stats

    def _extract_full_image_from_picture_page(self, page, item_id=None):
        """Extract a /upload/pictures/ full image URL from a picture page.

        Performs an itemId relevance check when item_id is provided: verifies
        the picture page actually references the current item (looks for an
        /item/{item_id} link or HTML reference). Returns "" if relevance
        cannot be confirmed, to prevent unrelated/collection/user pictures
        from being imported as this item's images.
        """
        try:
            # Relevance check: picture page must reference the current item.
            if item_id:
                item_id_str = str(item_id)
                relevance_ok = False
                try:
                    item_links = page.query_selector_all(f"a[href*='/item/{item_id_str}']")
                    if item_links:
                        relevance_ok = True
                    else:
                        try:
                            html_snippet = page.content()[:80000]
                            if f"/item/{item_id_str}" in html_snippet:
                                relevance_ok = True
                        except Exception:
                            pass
                except Exception:
                    pass
                if not relevance_ok:
                    print(yellow(f"    MFC img browser: picture page does not reference item {item_id_str}, rejecting"))
                    return ""
            # 1. og:image meta
            og = page.query_selector("meta[property='og:image']")
            if og:
                content = og.get_attribute("content") or ""
                if content and "/upload/pictures/" in content:
                    return content
            # 2. link[rel='image_src']
            link_el = page.query_selector("link[rel='image_src']")
            if link_el:
                href = link_el.get_attribute("href") or ""
                if href and "/upload/pictures/" in href:
                    return href
            # 3. <img> with srcset - pick the largest candidate containing /upload/pictures/
            imgs = page.query_selector_all("img")
            best_url = ""
            best_w = 0
            for img_el in imgs:
                try:
                    srcset = img_el.get_attribute("srcset") or ""
                    if srcset:
                        for part in srcset.split(","):
                            part = part.strip()
                            if not part:
                                continue
                            tokens = part.split()
                            url_part = tokens[0]
                            w = 0
                            if len(tokens) > 1 and tokens[1].endswith("w"):
                                try:
                                    w = int(tokens[1][:-1])
                                except Exception:
                                    w = 0
                            if "/upload/pictures/" in url_part and w > best_w:
                                best_w = w
                                best_url = url_part
                except Exception:
                    continue
            if best_url:
                return best_url
            # 4. Plain <img src> containing /upload/pictures/
            for img_el in imgs:
                try:
                    src = img_el.get_attribute("src") or ""
                    if src and "/upload/pictures/" in src:
                        return src
                except Exception:
                    continue
        except Exception as e:
            print(f"  MFC img browser: picture page extract error: {type(e).__name__}: {e}")
        return ""

    def _extract_full_image_from_modal(self, page):
        """Extract a full image URL from an open modal/lightbox.

        Accepts URLs that either contain /upload/pictures/ or whose rendered
        natural width is >= MIN_IMAGE_MAX_DIMENSION.
        """
        try:
            # Prefer img elements inside modal/lightbox containers.
            containers = page.query_selector_all(
                "div[class*='modal'], div[class*='lightbox'], img[class*='large'], img[class*='big']"
            )
            candidates = list(containers)
            # Also consider any img with a /upload/pictures/ src.
            candidates.extend(page.query_selector_all("img[src*='/upload/pictures/']"))
            best_url = ""
            best_w = 0
            for el in candidates:
                try:
                    tag = el.evaluate("e => e.tagName.toLowerCase()")
                except Exception:
                    tag = ""
                img_el = el if tag == "img" else None
                if img_el is None:
                    try:
                        img_el = el.query_selector("img")
                    except Exception:
                        img_el = None
                if img_el is None:
                    continue
                try:
                    src = img_el.get_attribute("src") or ""
                except Exception:
                    src = ""
                try:
                    current_src = img_el.get_attribute("currentSrc") or img_el.evaluate("e => e.currentSrc") or ""
                except Exception:
                    current_src = ""
                # srcset largest
                try:
                    srcset = img_el.get_attribute("srcset") or ""
                except Exception:
                    srcset = ""
                pick = current_src or src
                # Prefer /upload/pictures/ URLs.
                if pick and "/upload/pictures/" in pick:
                    return pick
                # Try srcset for a /upload/pictures/ candidate.
                if srcset:
                    for part in srcset.split(","):
                        part = part.strip()
                        if not part:
                            continue
                        tokens = part.split()
                        url_part = tokens[0]
                        w = 0
                        if len(tokens) > 1 and tokens[1].endswith("w"):
                            try:
                                w = int(tokens[1][:-1])
                            except Exception:
                                w = 0
                        if "/upload/pictures/" in url_part and w >= MIN_IMAGE_MAX_DIMENSION and w > best_w:
                            best_w = w
                            best_url = url_part
                # Fallback: naturalWidth >= MIN_IMAGE_MAX_DIMENSION
                if not best_url and pick:
                    try:
                        nat_w = img_el.evaluate("e => e.naturalWidth") or 0
                        nat_h = img_el.evaluate("e => e.naturalHeight") or 0
                    except Exception:
                        nat_w = 0
                        nat_h = 0
                    if max(nat_w, nat_h) >= MIN_IMAGE_MAX_DIMENSION and pick not in ("", best_url):
                        return pick
            if best_url:
                return best_url
        except Exception as e:
            print(f"  MFC img browser: modal extract error: {type(e).__name__}: {e}")
        return ""

    def scrape_mfc_item(self, item_id):
        """Scrape figure details from MFC item page.

        Fetch path (per requirement - no plain requests as primary):
          1. curl_cffi (chrome120 impersonation) + MFC cookies loaded from the
             local Chrome profile SQLite DB. This is the primary path.
          2. If no cf_clearance is present, OR curl_cffi returns 403 / CF
             challenge, launch stealth Chrome on the persistent profile to
             visit the item page and let Cloudflare clearance settle, then
             extract the fresh cookies (incl. cf_clearance).
          3. Retry curl_cffi with the fresh cookies.
          4. If the retry is still blocked, raise CloudflareBlockError so the
             agent defers the job with notBefore + 30min source cooldown.
        """
        url = f"{MFC_ITEM_URL}/{item_id}"
        html = ""

        # --- Step 1: curl_cffi + cached Chrome profile cookies ---
        cookies = self._load_mfc_cookies_from_chrome_profile()
        has_cf = "cf_clearance" in cookies
        if has_cf:
            try:
                _resp, html = self._mfc_fetch_via_curl_cffi(url, cookies=cookies)
            except CloudflareBlockError:
                # CF block with cached cookies - they may be stale. Invalidate
                # and fall through to the browser solver path below.
                self._invalidate_mfc_cookie_cache()
                html = ""
            except Exception as e:
                print(f"  mfc fetch step1 (curl_cffi+cookies) error: {type(e).__name__}: {e}")
                html = ""
        else:
            # No cf_clearance in cache - go straight to the browser solver.
            print("  mfc fetch: no cf_clearance in cached cookies, invoking browser solver")

        # --- Step 2: solve CF via stealth browser if step 1 did not yield HTML ---
        if not html:
            fresh_cookies = self._solve_mfc_cloudflare_via_browser(target_url=url)
            if not fresh_cookies:
                # Browser solver failed entirely (no cookies extracted). Defer.
                raise CloudflareBlockError(
                    "Cloudflare clearance could not be obtained via stealth browser "
                    "(no cookies extracted) - source temporarily blocked"
                )
            # --- Step 3: retry curl_cffi with fresh cookies ---
            try:
                _resp, html = self._mfc_fetch_via_curl_cffi(url, cookies=fresh_cookies)
            except CloudflareBlockError:
                # --- Step 4: still blocked after retry -> defer ---
                raise CloudflareBlockError(
                    "Cloudflare block persists after stealth browser clearance + "
                    "curl_cffi retry - source temporarily blocked"
                )
            except Exception as e:
                print(f"  mfc fetch step3 (curl_cffi+fresh cookies) error: {type(e).__name__}: {e}")
                html = ""

        if not html:
            return None

        soup = BeautifulSoup(html, "html.parser")
        data = {"item_id": item_id, "url": url, "source": "mfc", "mfcId": item_id}

        # Name
        og_title = soup.find("meta", property="og:title")
        if og_title:
            og_name = og_title.get("content", "").strip()
            if "MyFigureCollection" not in og_name:
                data["name"] = og_name
        if not data.get("name"):
            title_tag = soup.find("h1")
            if title_tag:
                data["name"] = title_tag.get_text(strip=True)

        # Images: collect large pictures from the item page.
        # MFC's <meta name="pictures"> contains ALL images on the page including
        # "related items" thumbnails. We must filter to only keep images that
        # belong to THIS item (URL contains /{item_id}-).
        item_id_str = str(item_id)
        large_images = []   # /upload/pictures/ paths (full-size)
        item_thumbs = []    # /upload/items/1/{item_id}- paths (thumbnails)

        # 1. Collect large images from <a> tags pointing to /picture/ or /upload/pictures/
        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"]
            if "/upload/pictures/" in href or "/picture/" in href:
                # Find the actual image URL inside the <a> tag
                img_tag = a_tag.find("img")
                if img_tag and img_tag.get("src"):
                    src = img_tag["src"]
                    if "myfigurecollection" in src:
                        full = src.replace("/items/2/", "/items/1/")
                        item_thumbs.append(full)
                # Also check for data-full or href as picture URL
                if "/upload/pictures/" in href:
                    large_images.append(href)

        # 2. From meta pictures, only keep images belonging to this item
        for meta in soup.find_all("meta", attrs={"name": "pictures"}):
            content = meta.get("content", "")
            if content:
                try:
                    import urllib.parse
                    decoded = urllib.parse.unquote(content)
                    pic_data = json.loads(decoded)
                    for pic in pic_data:
                        src = pic.get("src", "")
                        if src and "myfigurecollection" in src:
                            full = src.replace("/items/2/", "/items/1/")
                            # Only keep if URL contains this item's ID
                            if f"/{item_id_str}-" in full:
                                item_thumbs.append(full)
                            # /upload/pictures/ paths are large images — keep them
                            if "/upload/pictures/" in full:
                                large_images.append(full)
                except Exception:
                    pass

        # 3. og:image as fallback
        for meta in soup.find_all("meta", property="og:image"):
            content = meta.get("content", "")
            if content and "myfigurecollection" in content:
                if "/upload/pictures/" in content:
                    large_images.append(content)
                elif f"/{item_id_str}-" in content:
                    item_thumbs.append(content)

        # Only use /upload/pictures/ large images as official source images.
        # /upload/items/ thumbnails (item_thumbs) are NOT used as source images
        # because:
        #   1. They are small thumbnails, not real product images.
        #   2. MFC thumbnail URLs (/upload/items/1/...) cannot be reliably
        #      upgraded to /upload/pictures/ large URLs by URL manipulation -
        #      they use a different path structure based on upload date.
        #   3. Using thumbnails as source images would store low-res variants
        #      as the raw/detail variant, which violates the image quality rule.
        # If no /upload/pictures/ URLs are found, data["images"] stays empty
        # and the image_low_count report event will fire in build_figure_payload.
        seen = set()
        final_images = []
        for url in large_images:
            clean = url.split("?")[0]
            if clean not in seen:
                seen.add(clean)
                final_images.append(url)

        # Phase A + B: browser-based image extraction if insufficient large images
        if item_thumbs and len(final_images) < MAX_IMAGES:
            picture_hrefs = []
            for a_tag in soup.find_all("a", href=True):
                href = a_tag["href"]
                if "/picture/" in href:
                    picture_hrefs.append(href if href.startswith("http") else f"{MFC_BASE}{href}")
            if picture_hrefs or item_thumbs:
                try:
                    browser_images, img_stats = self._extract_mfc_full_images_via_browser(
                        url, cookies, item_id, picture_hrefs
                    )
                    for img_url in browser_images:
                        clean = img_url.split("?")[0]
                        if clean not in seen:
                            seen.add(clean)
                            final_images.append(img_url)
                    data["_mfc_image_extraction_stats"] = img_stats
                except Exception as e:
                    print(f"  MFC browser image extraction failed: {type(e).__name__}: {e}")
                    data["_mfc_image_extraction_stats"] = {
                        "thumbnail_candidates_count": 0,
                        "full_image_candidates_count": 0,
                        "clicked_thumbnail_count": 0,
                        "modal_open_success_count": 0,
                        "picture_page_success_count": 0,
                        "rejected_thumbnail_count": 0,
                    }
            else:
                data["_mfc_image_extraction_stats"] = None
        else:
            data["_mfc_image_extraction_stats"] = None

        # Official thumbnail fallback: if browser extraction still yielded
        # insufficient images, use MFC item page official thumbnails
        # (/upload/items/) as a last-resort source. These are small (~200x200)
        # but are the official product thumbnail, not user room photos. Marked
        # source_kind='official_item_thumbnail' + safe_display=true so the API's
        # isSafeDisplayImage() accepts them.
        if item_thumbs and len(final_images) < MAX_IMAGES:
            for thumb_url in item_thumbs:
                clean = thumb_url.split("?")[0]
                if clean not in seen:
                    seen.add(clean)
                    final_images.append({
                        "url": thumb_url,
                        "source": thumb_url,
                        "_source_kind": "official_item_thumbnail",
                        "_safe_display": True,
                        "_safety_reason": "MFC item page official thumbnail",
                    })
                    if len(final_images) >= MAX_IMAGES:
                        break

        if final_images:
            data["images"] = final_images[:MAX_IMAGES]
            data["_image_sources"] = {
                "large": list(final_images[:MAX_IMAGES]),
                "thumb_fallback": [],  # thumbnails are no longer used as fallback
            }
        # Record how many thumbnails were available but unused, for diagnostics.
        if item_thumbs and not final_images:
            data["_thumbnail_only"] = True
            data["_thumbnail_count"] = len(item_thumbs)

        # Parse detail fields
        for field in soup.find_all("div", class_="data-field"):
            label_div = field.find("div", class_="data-label")
            value_div = field.find("div", class_="data-value")
            if not label_div or not value_div:
                continue
            key = label_div.get_text(strip=True).lower()

            if "category" in key:
                stamp = value_div.find("a", class_="item-stamp")
                if stamp:
                    data["category"] = stamp.get_text(strip=True)

            if "company" in key:
                entries = value_div.find_all("a", class_="item-entry")
                items = [e.get_text(strip=True) for e in entries]
                if items:
                    data["manufacturer"] = items[0]

            if "release" in key:
                time_tag = value_div.find("a", class_="time")
                if time_tag:
                    data["release_date"] = time_tag.get_text(strip=True)
                text = value_div.get_text(strip=True)
                price_match = re.search(r'([\d,]+)\s*JPY', text)
                if price_match:
                    data["price"] = price_match.group(1).replace(",", "")

            if "origin" in key or "series" in key:
                entries = value_div.find_all("a", class_="item-entry")
                items = [e.get_text(strip=True) for e in entries]
                if items:
                    data["origin"] = items[0]

            if "character" in key:
                entries = value_div.find_all("a", class_="item-entry")
                items = [e.get_text(strip=True) for e in entries]
                if items:
                    data["characters"] = items

            if "sculptor" in key or "sculpt" in key:
                entries = value_div.find_all("a", class_="item-entry")
                items = [e.get_text(strip=True) for e in entries]
                if items:
                    data["sculptors"] = items

            if "dimension" in key:
                scale_link = value_div.find("a", class_="item-scale")
                if scale_link:
                    data["scale"] = scale_link.get_text(strip=True)
                text = value_div.get_text(strip=True)
                h_match = re.search(r'H=(\d+)mm', text)
                if h_match:
                    data["height_mm"] = int(h_match.group(1))

            if "material" in key:
                text = value_div.get_text(strip=True)
                if text:
                    data["material"] = text

            if "product line" in key or "product" in key:
                entries = value_div.find_all("a", class_="item-entry")
                items = [e.get_text(strip=True) for e in entries]
                if items:
                    data["product_line"] = items

            if "jan" in key or "barcode" in key or "jancode" in key:
                text = value_div.get_text(strip=True)
                jan = extract_jan_code(text)
                if jan:
                    data["jan_code"] = jan

            if "notes" in key or "description" in key:
                text = value_div.get_text(strip=True)
                if text:
                    data["description"] = clean_text(text)[:1000]

        # Fallback: scale from name
        if not data.get("scale"):
            name = data.get("name", "")
            scale_match = re.search(r'(1/\d+(\.\d+)?)', name)
            if scale_match:
                data["scale"] = scale_match.group(1)

        return data

    # ------------------------------------------------------------------
    # AmiAmi scraping
    # ------------------------------------------------------------------

    def search_amiami(self, query, max_results=30):
        """Search AmiAmi via Playwright browser.

        AmiAmi is a Nuxt SPA, so we must wait for the search results to render.
        Product links contain gcode=FIGURE-NNNNNN or GOODS-NNNNNNN.
        """
        if not self.page:
            return []
        encoded = quote(query)
        # Search ALL items (not just preorders) by omitting s_st_list_preorder=1.
        # s_cate_tag=14 filters to the figure category; s_list_limit=30 per page.
        # We also add pageno parameter to support pagination when max_results > 30.
        url = f"https://www.amiami.com/eng/search/list/?s_cate_tag=14&s_list_limit=30&s_keyword={encoded}"
        try:
            self.page.goto(url, wait_until="domcontentloaded", timeout=PLAYWRIGHT_TIMEOUT)
            # Wait for SPA to render
            try:
                self.page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            # Wait for product links to appear
            try:
                self.page.wait_for_selector("a[href*='gcode=']", timeout=10000)
            except Exception:
                pass
            time.sleep(3 + random.uniform(1, 3))

            results = []
            seen = set()
            html = self.page.content()
            soup = BeautifulSoup(html, "html.parser")

            # Find all links to detail pages with gcode parameter
            for link in soup.find_all("a", href=True):
                if len(results) >= max_results:
                    break
                href = link.get("href", "")
                gcode_match = re.search(r'gcode=([A-Z]+-\d+)', href)
                if not gcode_match:
                    continue
                gcode = gcode_match.group(1)
                if gcode in seen:
                    continue
                seen.add(gcode)

                # Find the item container (parent with product info)
                # Walk up to find a container with the name and price
                container = link
                for _ in range(6):
                    if container.parent:
                        container = container.parent
                        # Check if this container has a name-like element
                        name_el = container.find(class_=re.compile(r'(?:item|product).*name|title'))
                        if name_el:
                            break
                    else:
                        break

                name = ""
                if name_el:
                    name = name_el.get_text(strip=True)
                if not name:
                    name = link.get_text(strip=True)
                if not name or len(name) < 3:
                    # Try the link's title or aria-label
                    name = link.get("title", "") or link.get("aria-label", "")
                if not name or len(name) < 3:
                    continue

                # Find image
                img = container.find("img") if container else None
                image_url = ""
                if img:
                    image_url = img.get("src", "") or img.get("data-src", "")
                    if image_url:
                        if image_url.startswith("//"):
                            image_url = f"https:{image_url}"
                        elif not image_url.startswith("http"):
                            image_url = f"https://www.amiami.com{image_url}"

                # Find price
                price_jpy = 0
                price_el = container.find(class_=re.compile(r'price')) if container else None
                if price_el:
                    price_match = re.search(r'[\d,]+', price_el.get_text())
                    if price_match:
                        price_jpy = int(price_match.group().replace(',', ''))

                results.append({
                    "id": gcode,
                    "name": name,
                    "url": f"https://www.amiami.com/eng/detail/?gcode={gcode}",
                    "price_jpy": price_jpy,
                    "image": image_url,
                    "release_date": "",
                })
            return results
        except Exception as e:
            print(yellow(f"  AmiAmi search error: {e}"))
            return []

    def scrape_amiami_item(self, gcode):
        """Scrape figure details from AmiAmi detail page via Playwright.

        AmiAmi migrated to a Nuxt.js SPA, so we must wait for the page to
        render before extracting data. The spec data lives in
        dl.item-about__data blocks (dt.item-about__data-title +
        dd.item-about__data-text).
        """
        if not self.page:
            return None
        url = f"https://www.amiami.com/eng/detail/?gcode={gcode}"
        try:
            # Navigate and wait for SPA hydration
            self.page.goto(url, wait_until="domcontentloaded", timeout=PLAYWRIGHT_TIMEOUT)
            # Wait for network idle so the JS app finishes rendering
            try:
                self.page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            # Wait for the product title to appear (confirms SPA rendered)
            try:
                self.page.wait_for_selector("h2.item-detail__section-title", timeout=10000)
            except Exception:
                pass
            # Extra human-like delay
            time.sleep(2 + random.uniform(1, 2))

            html = self.page.content()
            soup = BeautifulSoup(html, "html.parser")

            result = {"item_id": gcode, "source": "amiami", "url": url, "amiamiId": gcode}

            # Name: h2.item-detail__section-title (second h2 after "Category:...")
            name_el = soup.select_one("h2.item-detail__section-title")
            if name_el:
                result["name"] = name_el.get_text(strip=True)
            else:
                # Fallback: any h2 that's not a section header
                for h2 in soup.find_all("h2"):
                    txt = h2.get_text(strip=True)
                    if txt and not txt.startswith("Category:") and txt not in (
                        "About this item", "Viewed Items", "Pickup",
                        "Series", "Product Line", "Brands",
                    ):
                        result["name"] = txt
                        break

            # Parse spec table: dl.item-about__data blocks
            # Each dl may contain MULTIPLE dt/dd pairs, so iterate all of them
            spec_map = {}
            for dl in soup.select("dl.item-about__data"):
                dts = dl.find_all("dt", class_="item-about__data-title")
                dds = dl.find_all("dd", class_="item-about__data-text")
                # Pair them up by position
                for dt, dd in zip(dts, dds):
                    key = dt.get_text(strip=True).lower()
                    val = dd.get_text(" ", strip=True)
                    if key and val:
                        spec_map[key] = val

            # Extract structured fields from spec_map
            if spec_map.get("release date"):
                result["release_date"] = parse_release_date(spec_map["release date"])
            if spec_map.get("list price"):
                price_match = re.search(r'[\d,]+', spec_map["list price"])
                if price_match:
                    result["price"] = price_match.group().replace(',', '')
            if spec_map.get("jan code"):
                result["jan_code"] = spec_map["jan code"].strip()
            if spec_map.get("brand"):
                result["manufacturer"] = spec_map["brand"].strip()
            if spec_map.get("product line"):
                result["product_line"] = spec_map["product line"].strip()
            if spec_map.get("series title"):
                result["series"] = spec_map["series title"].strip()
            if spec_map.get("specifications"):
                result["description"] = clean_text(spec_map["specifications"])[:1000]

            # Images: find product images in section.item-detail
            # Product images have src containing "img.amiami.com/images/product"
            images = []
            detail_section = soup.find("section", class_="item-detail")
            search_root = detail_section or soup
            for img in search_root.find_all("img"):
                src = img.get("src", "") or img.get("data-src", "")
                if not src:
                    continue
                # Only accept product images (not UI icons)
                if "img.amiami.com/images/product" not in src:
                    continue
                if src.startswith("//"):
                    src = f"https:{src}"
                elif not src.startswith("http"):
                    src = f"https://www.amiami.com{src}"
                # Upgrade thumbnail URL to full-size image.
                # AmiAmi paths: /images/product/{thumb|main|review|review_big}/NNN/ID(_NN).jpg
                # Prefer /review_big/ (largest) > /main/ > /review/ > /thumb/
                src = self._upgrade_amiami_image_url(src)
                images.append(src)

            # Fallback: og:image
            if not images:
                og_img = soup.find("meta", property="og:image")
                if og_img:
                    src = og_img.get("content", "")
                    if src:
                        if src.startswith("//"):
                            src = f"https:{src}"
                        images.append(src)

            # Dedupe and limit
            if images:
                seen = set()
                unique = []
                for u in images:
                    clean = u.split("?")[0]
                    if clean not in seen:
                        seen.add(clean)
                        unique.append(u)
                result["images"] = unique[:MAX_IMAGES]

            # Try to extract scale from spec text or name
            all_spec_text = " ".join(spec_map.values())
            scale_match = re.search(r'(1/\d+)', all_spec_text)
            if scale_match:
                result["scale"] = scale_match.group(1)
            elif not result.get("scale"):
                name = result.get("name", "")
                scale_match = re.search(r'(1/\d+)', name)
                if scale_match:
                    result["scale"] = scale_match.group(1)

            # Size from spec
            size_match = re.search(r'(\d+)\s*(?:mm|cm)', all_spec_text)
            if size_match:
                val = int(size_match.group(1))
                # "cm" values need conversion
                if "cm" in all_spec_text and val < 100:
                    val = val * 10
                result["height_mm"] = val

            return result
        except Exception as e:
            print(yellow(f"  AmiAmi detail error: {e}"))
            return None

    # ------------------------------------------------------------------
    # Hobby Search scraping
    # ------------------------------------------------------------------

    def search_hobbysearch(self, query, max_results=30):
        """Search Hobby Search (1999.co.jp/eng) via curl_cffi to bypass Cloudflare."""
        encoded = quote(query)
        url = f"{HOBBYSEARCH_SEARCH_URL}?typ1=&typ2=&kwd={encoded}"
        try:
            # Use curl_cffi chrome120 to bypass Cloudflare
            try:
                from curl_cffi import requests as crequests
                resp = crequests.get(url, headers=HEADERS, impersonate="chrome120", timeout=REQUEST_TIMEOUT)
            except Exception:
                # Fallback to plain requests
                resp = self.session.get(url, timeout=REQUEST_TIMEOUT)
            if resp.status_code != 200:
                return []
            soup = BeautifulSoup(resp.text, "html.parser")
            results = []
            seen = set()

            # Hobby Search search results have links to /eng/{item_id}
            for link in soup.find_all("a", href=True):
                href = link.get("href", "")
                m = re.search(r'/eng/(\d{5,})', href)
                if not m:
                    continue
                item_id = m.group(1)
                if item_id in seen:
                    continue
                seen.add(item_id)

                # Get name from link text or nearby element
                name = link.get_text(strip=True)
                if not name or len(name) < 3:
                    # Try parent element
                    parent = link.parent
                    if parent:
                        name = parent.get_text(strip=True)[:100]
                if not name or len(name) < 3:
                    continue

                results.append({
                    "id": item_id,
                    "name": name,
                    "url": f"{HOBBYSEARCH_DETAIL_URL}/{item_id}",
                })
                if len(results) >= max_results:
                    break

            return results
        except Exception as e:
            print(yellow(f"  Hobby Search search error: {e}"))
            return []

    def scrape_hobbysearch_item(self, item_id):
        """Scrape figure details from Hobby Search product page via requests."""
        url = f"{HOBBYSEARCH_DETAIL_URL}/{item_id}"
        html = None
        try:
            resp = self.session.get(url, timeout=REQUEST_TIMEOUT)
            detect_cloudflare_block(resp)
            if resp.status_code == 200:
                html = resp.text
        except CloudflareBlockError:
            raise  # Re-raise to let the agent handle source-level cooldown
        except Exception:
            html = None

        if not html:
            try:
                from curl_cffi import requests as crequests
                resp = crequests.get(url, headers=HEADERS, impersonate="chrome120", timeout=REQUEST_TIMEOUT)
                detect_cloudflare_block(resp)
                if resp.status_code == 200:
                    html = resp.text
            except CloudflareBlockError:
                raise  # Re-raise to stop source
            except Exception:
                html = None

        if not html:
            return None

        soup = BeautifulSoup(html, "html.parser")
        data = {"item_id": item_id, "url": url, "source": "hobbysearch", "hobbySearchId": item_id}

        # Name - usually in a specific heading or title area
        title_el = soup.find("h1") or soup.find("h2") or soup.find(class_=re.compile(r'item.*name|product.*name|title'))
        if title_el:
            data["name"] = title_el.get_text(strip=True)
        if not data.get("name"):
            og_title = soup.find("meta", property="og:title")
            if og_title:
                data["name"] = og_title.get("content", "").strip()

        # Images - look for product images
        images = []
        # Common patterns for Hobby Search images
        for img in soup.select(".product-image img, .item-image img, #productImg img, "
                               "[class*='gallery'] img, [class*='slider'] img, "
                               ".detail-img img, [id*='img'] img"):
            src = img.get("src", "") or img.get("data-src", "") or img.get("data-original", "")
            if not src:
                continue
            if src.startswith("//"):
                src = f"https:{src}"
            elif not src.startswith("http"):
                src = f"{HOBBYSEARCH_BASE}{src}" if src.startswith("/") else f"{HOBBYSEARCH_BASE}/{src}"
            # Filter out tiny icons / UI elements
            if any(skip in src.lower() for skip in ["icon", "btn", "logo", "banner", "spacer"]):
                continue
            images.append(src)

        # Fallback: og:image
        if not images:
            og_img = soup.find("meta", property="og:image")
            if og_img:
                src = og_img.get("content", "")
                if src:
                    if src.startswith("//"):
                        src = f"https:{src}"
                    elif not src.startswith("http"):
                        src = f"{HOBBYSEARCH_BASE}{src}"
                    images.append(src)

        # Broader fallback: all images on the page that look like product images
        if not images:
            for img in soup.find_all("img", src=True):
                src = img.get("src", "")
                if not src:
                    continue
                if any(skip in src.lower() for skip in ["icon", "btn", "logo", "banner", "spacer", "header", "footer", "nav"]):
                    continue
                if src.startswith("//"):
                    src = f"https:{src}"
                elif not src.startswith("http"):
                    src = f"{HOBBYSEARCH_BASE}{src}" if src.startswith("/") else f"{HOBBYSEARCH_BASE}/{src}"
                # Only include if it looks like a product image (large enough, from their CDN)
                if "1999.co.jp" in src or "hobbysearch" in src:
                    images.append(src)

        if images:
            data["images"] = filter_hobbysearch_product_images(images, item_id)

        # Extract specifications from the page text
        page_text = soup.get_text(separator="\n")
        data.update(extract_hobbysearch_page_fields(soup))
        merch_line = infer_merch_product_line(data.get("name", ""), page_text)
        if merch_line:
            data["product_line"] = merch_line
            data["category"] = "merchandise"
            data["scale"] = ""

        # JAN code - Hobby Search is very reliable for this
        if not data.get("jan_code"):
            jan = extract_jan_code(page_text)
            if jan:
                data["jan_code"] = jan

        # Price
        if not data.get("price"):
            price_match = re.search(r'[¥￥]\s*([\d,]+)', page_text)
            if price_match:
                data["price"] = price_match.group(1).replace(",", "")
            else:
                price_match = re.search(r'(\d{3,})\s*(?:yen|JPY)', page_text, re.IGNORECASE)
                if price_match:
                    data["price"] = price_match.group(1).replace(",", "")

        # Scale
        if not data.get("scale") and not merch_line:
            scale_match = re.search(r'(1/\d+)', page_text)
            if scale_match:
                data["scale"] = scale_match.group(1)

        # Manufacturer
        if not data.get("manufacturer"):
            mfr_match = re.search(r'(?:Manufacturer|Maker|メーカー)[:\s]*([^\n,;]+)', page_text, re.IGNORECASE)
            if mfr_match:
                data["manufacturer"] = mfr_match.group(1).strip()

        # Release date
        if not data.get("release_date"):
            date_match = re.search(r'(?:Release|Release Date|発売|Ships)[:\s]*(\d{4}[/\-]\d{1,2}([/\-]\d{1,2})?)', page_text, re.IGNORECASE)
            if date_match:
                data["release_date"] = date_match.group(1).replace("/", "-")

        # Size/height
        size_match = re.search(r'(\d+)\s*(?:mm|cm)', page_text)
        if size_match:
            data["height_mm"] = int(size_match.group(1))

        # Material
        if not data.get("material"):
            mat_match = re.search(r'(?:Material|材質)[:\s]*([^\n,;]+)', page_text, re.IGNORECASE)
            if mat_match:
                data["material"] = mat_match.group(1).strip()

        # Description
        desc_el = soup.find(class_=re.compile(r'description|detail|comment|note'))
        if desc_el:
            data["description"] = clean_text(desc_el.get_text())[:1000]

        # Fallback: scale from name
        if not data.get("scale"):
            name = data.get("name", "")
            scale_match = re.search(r'(1/\d+)', name)
            if scale_match:
                data["scale"] = scale_match.group(1)

        return data

    # ------------------------------------------------------------------
    # Query generation
    # ------------------------------------------------------------------

    def generate_search_queries(self, source="mfc"):
        queries = []
        if source == "mfc":
            for year in TARGET_YEARS:
                for mfr in MANUFACTURER_NAMES[:10]:
                    queries.append(("manufacturer_year", f"{mfr} {year}"))
                for series in POPULAR_SERIES[:8]:
                    queries.append(("series_year", f"{series} {year}"))
                for scale in SCALE_KEYWORDS:
                    queries.append(("scale_year", f"{scale} scale {year}"))
        elif source == "amiami":
            for year in TARGET_YEARS:
                for mfr in MANUFACTURER_NAMES[:15]:
                    queries.append(("manufacturer", mfr))
                for series in POPULAR_SERIES[:15]:
                    queries.append(("series", series))
                for scale in ["1/4", "1/6", "1/7", "1/8"]:
                    queries.append(("scale", f"{scale} figure"))
        elif source == "hobbysearch":
            for year in TARGET_YEARS:
                for mfr in MANUFACTURER_NAMES[:15]:
                    queries.append(("manufacturer", f"{mfr} {year}"))
                for series in POPULAR_SERIES[:15]:
                    queries.append(("series", f"{series} {year}"))
                for scale in ["1/4", "1/6", "1/7", "1/8"]:
                    queries.append(("scale", f"{scale} scale figure {year}"))
        seen = set()
        unique = []
        for category, q in queries:
            if q not in seen:
                seen.add(q)
                unique.append((category, q))
        return unique

    # ------------------------------------------------------------------
    # Discovery phase
    # ------------------------------------------------------------------

    def discover_items(self, max_per_search=15):
        print(cyan(f"\n=== Phase 1: Discovering items ==="))

        for source in self.sources_to_run:
            print(cyan(f"\n--- Source: {source.upper()} ---"))
            if source == "mfc":
                self._discover_mfc(max_per_search)
            elif source == "amiami":
                self._discover_amiami(max_per_search)
            elif source == "hobbysearch":
                self._discover_hobbysearch(max_per_search)

        self.save_discovered()
        print(green(f"\n  Discovery complete: {len(self.discovered)} unique items found"))
        self.stats["discovered"] = len(self.discovered)

    def _discover_mfc(self, max_per_search=15):
        queries = self.generate_search_queries("mfc")
        print(f"  Will run {len(queries)} search queries")
        for i, (category, query) in enumerate(queries):
            if len(self.discovered) >= 500:
                print(yellow(f"  Reached 500 discovered items limit"))
                break
            print(f"  [{i+1}/{len(queries)}] [{category}] \"{query[:60]}\"", end="")
            items = self.search_mfc(query, max_results=max_per_search)
            new_count = 0
            filtered_count = 0
            for item in items:
                # Only filter truly invalid results (no id or no name).
                # Merchandise must enter discovered so fetch_item + prepare_scraped_item
                # can classify and ingest it into the right non-figure category.
                if not item.get("id") or not item.get("name"):
                    filtered_count += 1
                    continue
                item_id = f"mfc-{item['id']}"
                if item_id not in self.discovered:
                    self.discovered[item_id] = {
                        "id": item["id"],
                        "name": item["name"],
                        "url": item["url"],
                        "source": "mfc",
                        "discovery_query": query,
                        "discovery_category": category,
                        "scraped": False,
                    }
                    new_count += 1
            print(f" -> {len(items)} results, {green(str(new_count))} new, {filtered_count} filtered (total: {len(self.discovered)})")
            if (i + 1) % 20 == 0:
                self.save_discovered()
            time.sleep(DELAY_BETWEEN_SEARCHES + random.uniform(0.5, 1.5))

    def _discover_amiami(self, max_per_search=15):
        queries = self.generate_search_queries("amiami")
        print(f"  Will run {len(queries)} search queries")
        for i, (category, query) in enumerate(queries):
            if len(self.discovered) >= 500:
                print(yellow(f"  Reached 500 discovered items limit"))
                break
            print(f"  [{i+1}/{len(queries)}] [{category}] \"{query[:60]}\"", end="")
            items = self.search_amiami(query, max_results=max_per_search)
            new_count = 0
            filtered_count = 0
            for item in items:
                # Only filter truly invalid results (no id or no name).
                # Merchandise must enter discovered so fetch_item + prepare_scraped_item
                # can classify and ingest it into the right non-figure category.
                if not item.get("id") or not item.get("name"):
                    filtered_count += 1
                    continue
                item_id = f"amiami-{item['id']}"
                if item_id not in self.discovered:
                    self.discovered[item_id] = {
                        "id": item["id"],
                        "name": item["name"],
                        "url": item["url"],
                        "source": "amiami",
                        "discovery_query": query,
                        "discovery_category": category,
                        "scraped": False,
                        "price_jpy": item.get("price_jpy", 0),
                        "image": item.get("image", ""),
                        "release_date": item.get("release_date", ""),
                    }
                    new_count += 1
            print(f" -> {len(items)} results, {green(str(new_count))} new, {filtered_count} filtered (total: {len(self.discovered)})")
            if (i + 1) % 20 == 0:
                self.save_discovered()
            time.sleep(2.0 + random.uniform(0.5, 1.5))

    def _discover_hobbysearch(self, max_per_search=15):
        queries = self.generate_search_queries("hobbysearch")
        print(f"  Will run {len(queries)} search queries")
        for i, (category, query) in enumerate(queries):
            if len(self.discovered) >= 500:
                print(yellow(f"  Reached 500 discovered items limit"))
                break
            print(f"  [{i+1}/{len(queries)}] [{category}] \"{query[:60]}\"", end="")
            items = self.search_hobbysearch(query, max_results=max_per_search)
            new_count = 0
            filtered_count = 0
            for item in items:
                # Only filter truly invalid results (no id or no name).
                # Merchandise must enter discovered so fetch_item + prepare_scraped_item
                # can classify and ingest it into the right non-figure category.
                if not item.get("id") or not item.get("name"):
                    filtered_count += 1
                    continue
                item_id = f"hs-{item['id']}"
                if item_id not in self.discovered:
                    self.discovered[item_id] = {
                        "id": item["id"],
                        "name": item["name"],
                        "url": item["url"],
                        "source": "hobbysearch",
                        "discovery_query": query,
                        "discovery_category": category,
                        "scraped": False,
                    }
                    new_count += 1
            print(f" -> {len(items)} results, {green(str(new_count))} new, {filtered_count} filtered (total: {len(self.discovered)})")
            if (i + 1) % 20 == 0:
                self.save_discovered()
            time.sleep(1.0 + random.uniform(0.5, 1.0))

    # ------------------------------------------------------------------
    # Scrape phase
    # ------------------------------------------------------------------

    def scrape_and_filter_items(self):
        print(cyan(f"\n=== Phase 2: Scraping item details ==="))
        items_to_scrape = [
            (item_key, data) for item_key, data in self.discovered.items()
            if not data.get("scraped")
        ]

        print(f"  {len(items_to_scrape)} items to scrape")

        valid_items = []
        for i, (item_key, data) in enumerate(items_to_scrape):
            if len(valid_items) >= 200:
                print(yellow(f"  Reached 200 valid items limit"))
                break

            source = data.get("source", "mfc")
            item_id = data["id"]
            print(f"  [{i+1}/{len(items_to_scrape)}] [{source.upper()}] #{item_id}...", end="")

            if source == "amiami":
                scraped = self.scrape_amiami_item(item_id)
            elif source == "hobbysearch":
                scraped = self.scrape_hobbysearch_item(item_id)
            else:
                scraped = self.scrape_mfc_item(item_id)

            if not scraped:
                data["scraped"] = True
                data["valid"] = False
                print(red(" FAILED"))
                time.sleep(DELAY_BETWEEN_FIGURES)
                continue

            release_year = None
            release_str = scraped.get("release_date", "")
            if release_str:
                years = re.findall(r'\b(20\d{2})\b', release_str)
                if years:
                    release_year = int(years[0])

            full_name = scraped.get("name", data.get("name", ""))
            scale = (scraped.get("scale", "") or "").strip()
            merch_line = infer_merch_product_line(full_name, scraped.get("category", ""))
            if merch_line:
                scale = ""

            # Category mapping
            category = (scraped.get("category", "") or "").lower()
            # Non-figure items are NOT skipped here. Merchandise is classified
            # via classify_product_kind() and routed to the correct non-figure
            # db category so it can be ingested alongside figures. Only truly
            # invalid items (no name) are skipped, and that was handled above
            # by the `if not scraped` check.

            MFC_CATEGORY_MAP = {
                "prepainted": "pvc-figure",
                "action": "action-figure",
                "dolls": "action-figure",
                "nendoroid": "nendoroid",
                "figma": "figma",
                "model kits": "action-figure",
                "hanged up": "other-merch",
                "misc": "other-merch",
                "stationeries": "stationery",
                "apparel": "apparel-accessory",
                "linens": "home-living",
                "on walls": "tapestry-poster",
                "dishes": "home-living",
                "books": "other-merch",
                "music": "other-merch",
                "accessories": "apparel-accessory",
            }

            db_category_slug = None
            for mfc_cat, db_slug in MFC_CATEGORY_MAP.items():
                if mfc_cat in category:
                    db_category_slug = db_slug
                    break

            if merch_line:
                db_category_slug = merch_category_slug(merch_line)
            elif source == "amiami" and not db_category_slug:
                db_category_slug = "pvc-figure"
            elif source == "hobbysearch" and not db_category_slug:
                db_category_slug = "pvc-figure"
            elif not db_category_slug and category:
                db_category_slug = "other-merch"

            # Determine product line
            product_line = ""
            pl = scraped.get("product_line", [])
            if isinstance(pl, list) and pl:
                product_line = pl[0]
            elif isinstance(pl, str):
                product_line = pl
            if merch_line:
                product_line = merch_line
            elif not product_line:
                name_lower = full_name.lower()
                if "nendoroid" in name_lower:
                    product_line = "Nendoroid"
                elif "figma" in name_lower:
                    product_line = "figma"
                elif "pop up parade" in name_lower:
                    product_line = "Pop Up Parade"
                elif "prize" in name_lower or "ichiban kuji" in name_lower:
                    product_line = "Prize Figure"
                elif scale:
                    product_line = "Scale Figure"

            data.update({
                "scraped": True,
                "full_name": full_name,
                "release_date": scraped.get("release_date", ""),
                "manufacturer": scraped.get("manufacturer", ""),
                "scale": scale,
                "price": scraped.get("price", ""),
                "origin": scraped.get("origin", ""),
                "material": scraped.get("material", ""),
                "height_mm": scraped.get("height_mm", ""),
                "category": scraped.get("category", ""),
                "db_category_slug": db_category_slug or "",
                "images": scraped.get("images", []),
                "release_year": release_year,
                "description": scraped.get("description", ""),
                "sculptors": scraped.get("sculptors", []),
                "source": source,
                "amiamiId": scraped.get("amiamiId", ""),
                "hobbySearchId": scraped.get("hobbySearchId", ""),
                "mfcId": scraped.get("mfcId", ""),
                "jan_code": scraped.get("jan_code", ""),
                "product_line": product_line,
                "characters": scraped.get("characters", []),
            })

            # Accept all categories - no NON_FIGURE_CATEGORIES filtering
            if release_year and release_year in TARGET_YEARS:
                data["valid"] = True
                valid_items.append((item_key, data))
                print(green(f"  [{release_year}] {scale} {full_name[:40]}"))
            elif not release_year:
                # Accept items with price from retailer sources even without year
                if source in ("amiami", "hobbysearch") and scraped.get("price"):
                    data["valid"] = True
                    valid_items.append((item_key, data))
                    print(green(f"  [{source.upper()}] {scale} {full_name[:40]}"))
                else:
                    data["valid"] = False
                    print(f" ? (no year) {full_name[:40]}")
            else:
                data["valid"] = False
                print(f"  (year={release_year}, not in range) {full_name[:40]}")

            if (i + 1) % 10 == 0:
                self.save_discovered()

            time.sleep(DELAY_BETWEEN_FIGURES + random.uniform(0.5, 1.5))

        self.save_discovered()
        print(green(f"\n  Valid items (2024-2026): {len(valid_items)}"))
        return valid_items

    def scrape_source_item(self, source, item_id):
        """Scrape one item from a configured source."""
        if source == "mfc":
            return self.scrape_mfc_item(item_id)
        if source == "hobbysearch":
            return self.scrape_hobbysearch_item(item_id)
        if source == "amiami":
            self.start_browser()
            try:
                return self.scrape_amiami_item(item_id)
            finally:
                self.stop_browser()
        raise ValueError(f"Unsupported source for single item: {source}")

    def prepare_scraped_item(self, scraped, source):
        """Normalize one scraped item into the same shape used by the import phase.

        Non-figure items are NOT skipped anymore. Instead they are tagged with
        a productKind (merchandise/plush/badge/...) and routed to a non-figure
        db category so they can be ingested separately from figures. Returns
        None only when there is no usable data at all (no name).
        """
        if not scraped:
            return None

        # CRITICAL: Clear processed_images from previous item.
        # The scraper instance is reused across jobs (cached in agent.scrapers),
        # so without this, images from a previous figure bleed into the next one.
        self.processed_images = []

        release_year = None
        release_str = scraped.get("release_date", "")
        if release_str:
            years = re.findall(r'\b(20\d{2})\b', release_str)
            if years:
                release_year = int(years[0])

        full_name = scraped.get("full_name", "") or scraped.get("name", "")
        if not full_name:
            return None
        scale = (scraped.get("scale", "") or "").strip()
        category = (scraped.get("category", "") or "").lower()

        # --- Classify product kind (figure vs merchandise subtype) ---
        product_kind = classify_product_kind(full_name, category, scale)
        is_merch = product_kind != "figure"

        merch_line = infer_merch_product_line(full_name, category)
        # Merchandise must not carry a misleading scale (badges/plush/etc have no scale)
        if is_merch:
            scale = ""

        mfc_category_map = {
            "prepainted": "pvc-figure",
            "action": "action-figure",
            "dolls": "action-figure",
            "nendoroid": "nendoroid",
            "figma": "figma",
            "model kits": "action-figure",
            "hanged up": "other-merch",
            "misc": "other-merch",
            "stationeries": "stationery",
            "apparel": "apparel-accessory",
            "linens": "home-living",
            "on walls": "tapestry-poster",
            "dishes": "home-living",
            "books": "other-merch",
            "music": "other-merch",
            "accessories": "apparel-accessory",
        }

        db_category_slug = None
        for mfc_cat, db_slug in mfc_category_map.items():
            if mfc_cat in category:
                db_category_slug = db_slug
                break

        if is_merch:
            # Route merchandise to its dedicated non-figure category. This MUST
            # override any figure-looking MFC category so merch never lands in
            # pvc-figure/action-figure/nendoroid/figma.
            merch_slug = product_kind_to_db_category(product_kind)
            if merch_slug:
                db_category_slug = merch_slug
            elif merch_line:
                db_category_slug = merch_category_slug(merch_line)
            else:
                db_category_slug = "other-merch"
        elif merch_line:
            db_category_slug = merch_category_slug(merch_line)
        elif source in ("amiami", "hobbysearch") and not db_category_slug:
            db_category_slug = "pvc-figure"
        elif not db_category_slug and category:
            db_category_slug = "other-merch"

        product_line = ""
        pl = scraped.get("product_line", [])
        if isinstance(pl, list) and pl:
            product_line = pl[0]
        elif isinstance(pl, str):
            product_line = pl
        if merch_line:
            product_line = merch_line
        elif not product_line:
            name_lower = full_name.lower()
            if "nendoroid" in name_lower:
                product_line = "Nendoroid"
            elif "figma" in name_lower:
                product_line = "figma"
            elif "pop up parade" in name_lower:
                product_line = "Pop Up Parade"
            elif "prize" in name_lower or "ichiban kuji" in name_lower:
                product_line = "Prize Figure"
            elif scale:
                product_line = "Scale Figure"

        data = dict(scraped)
        data.update({
            "scraped": True,
            "full_name": full_name,
            "release_date": scraped.get("release_date", ""),
            "manufacturer": scraped.get("manufacturer", ""),
            "scale": scale,
            "price": scraped.get("price", ""),
            "origin": scraped.get("origin", ""),
            "material": scraped.get("material", ""),
            "height_mm": scraped.get("height_mm", ""),
            "category": scraped.get("category", ""),
            "db_category_slug": db_category_slug or "",
            "images": scraped.get("images", []),
            "release_year": release_year,
            "description": scraped.get("description", ""),
            "sculptors": scraped.get("sculptors", []),
            "source": source,
            "amiamiId": scraped.get("amiamiId", ""),
            "hobbySearchId": scraped.get("hobbySearchId", ""),
            "mfcId": scraped.get("mfcId", ""),
            "jan_code": scraped.get("jan_code", ""),
            "product_line": product_line,
            "characters": scraped.get("characters", []),
            "product_kind": product_kind,
            "is_merch": is_merch,
        })
        return data

    # ------------------------------------------------------------------
    # Build API payload
    # ------------------------------------------------------------------

    def build_figure_payload(self, scraped_data):
        """Build the API payload for creating/updating a figure."""
        name = scraped_data.get("full_name", "") or scraped_data.get("name", "")
        if not name:
            return None

        jan_code = scraped_data.get("jan_code", "")
        scale = scraped_data.get("scale", "")
        material = scraped_data.get("material", "")
        height_str = scraped_data.get("height_mm", "")
        mfr_name = normalize_manufacturer_name(scraped_data.get("manufacturer", ""))
        price_str = scraped_data.get("price", "")
        release_date_str = scraped_data.get("release_date", "")
        origin = scraped_data.get("origin", "")
        description = scraped_data.get("description", "")
        source = scraped_data.get("source", "mfc")
        characters = scraped_data.get("characters", [])
        character_name = characters[0] if characters else ""
        category = (scraped_data.get("category", "") or "").lower()

        if self.ai_rewrite and description:
            # Rewrite existing description into encyclopedia style
            try:
                description = ai_rewrite_description(
                    description, title=name, source=source,
                    product_kind=scraped_data.get("product_kind", "figure"),
                )
            except Exception as _e:
                print(yellow(f"  [ai] rewrite skipped: {_e}"))
        elif self.ai_rewrite and not description:
            # No description scraped - generate one from metadata via AI.
            # The prompt adapts to productKind so merchandise is not described
            # as a scale figure (no invented scale/material/height).
            try:
                generated = ai_generate_description(
                    title=name,
                    manufacturer=mfr_name,
                    scale=scale,
                    category=category,
                    character=character_name,
                    origin=origin,
                    release_date=release_date_str,
                    price_jpy=price_str,
                    source=source,
                    product_kind=scraped_data.get("product_kind", "figure"),
                )
                if generated:
                    description = generated
                    print(green(f"  [ai] generated description ({len(description)} chars)"))
            except Exception as _e:
                print(yellow(f"  [ai] generate skipped: {_e}"))
        product_line = scraped_data.get("product_line", "")
        images = scraped_data.get("images", [])

        slug = slugify(name)
        if len(slug) < 3:
            source_slug = slugify(str(scraped_data.get("item_id", ""))) or str(scraped_data.get("item_id", "")).lower()
            slug = source_slug if source_slug.startswith("figure-") else f"figure-{source_slug}"

        # Add source ID to slug for uniqueness
        mfc_id = scraped_data.get("mfcId", "") or (scraped_data.get("item_id", "") if source == "mfc" else "")
        amiami_id = scraped_data.get("amiamiId", "")
        hs_id = scraped_data.get("hobbySearchId", "")

        if mfc_id:
            slug = f"{slug}-mfc{mfc_id}"
        elif amiami_id:
            source_slug = slugify(str(amiami_id)) or str(amiami_id).lower()
            slug = f"{slug}-ami-{source_slug}"
        elif hs_id:
            slug = f"{slug}-hs{hs_id}"
        if len(slug) > 120:
            slug = slug[:120]

        # Manufacturer
        manufacturer_id = None
        mfr = self.ensure_manufacturer(mfr_name) if mfr_name else None
        if mfr:
            manufacturer_id = mfr["id"]

        # Release date
        release_date = parse_release_date(release_date_str)

        # Price
        price_jpy = extract_price_number(price_str)

        # Height
        height_mm = None
        if height_str:
            if isinstance(height_str, int):
                height_mm = height_str
            else:
                mm_match = re.search(r'(\d+)\s*mm', str(height_str))
                if mm_match:
                    height_mm = int(mm_match.group(1))

        # Category IDs
        # IMPORTANT: merchandise must NEVER fall back to pvc-figure. If the
        # scraped item is merch (product_kind != "figure"), we only accept the
        # db_cat_slug or "other-merch". If neither exists in category_map, we
        # leave category_ids empty and write a report event so a human can fix
        # the category mapping. Only figure items may fall back to pvc-figure.
        category_ids = []
        db_cat_slug = scraped_data.get("db_category_slug", "")
        product_kind = scraped_data.get("product_kind") or "figure"
        is_merch = scraped_data.get("is_merch", product_kind != "figure")
        if is_merch or product_kind != "figure":
            # Merchandise path - never fall back to pvc-figure
            if db_cat_slug and db_cat_slug in self.category_map:
                category_ids = [self.category_map[db_cat_slug]]
            elif "other-merch" in self.category_map:
                category_ids = [self.category_map["other-merch"]]
            else:
                # No suitable merchandise category exists - do NOT fall back
                # to pvc-figure. Leave empty and report for human review.
                if not self.dry_run:
                    self.report.write(
                        "category_missing_merch",
                        source=source,
                        itemId=scraped_data.get("item_id"),
                        product_kind=product_kind,
                        db_cat_slug=db_cat_slug,
                        name=name,
                    )
        else:
            # Figure path - existing logic, pvc-figure fallback is allowed
            if db_cat_slug and db_cat_slug in self.category_map:
                category_ids = [self.category_map[db_cat_slug]]
            elif "pvc-figure" in self.category_map:
                category_ids = [self.category_map["pvc-figure"]]

        # Localized data
        character_name = characters[0] if characters else ""
        localized = [{
            "language": "en",
            "title": name,
            "origin": origin,
            "character": character_name,
            "description": description,
        }]

        # Release data
        releases = []
        if release_date or price_jpy:
            release_entry = {
                "edition": "Original",
                "isRerelease": False,
            }
            if release_date:
                release_entry["releaseDate"] = release_date
            if price_jpy:
                release_entry["priceJpy"] = price_jpy
            releases.append(release_entry)

        # Process images locally
        image_entries = []
        for i, img_entry in enumerate(images[:MAX_IMAGES]):
            # Entries may be plain URL strings (large images) or dicts
            # (official_item_thumbnail with metadata).
            if isinstance(img_entry, dict):
                img_url = img_entry.get("url", "")
                img_meta = img_entry
            else:
                img_url = img_entry
                img_meta = {}
            if self.dry_run:
                image_entries.append({
                    "source": img_url,
                    "alt": "",
                    "sortOrder": i,
                })
                continue

            processed = process_image(img_url, jan_code, sort_order=i, meta=img_meta)
            if processed:
                # Store processed image for later upload via /figures/images/upload-processed.
                # We do NOT include image entries in the figure creation payload because
                # the server's createFigureSchema requires `source` (a URL it would try to
                # download, which fails with 403 from Cloudflare). Instead, we create the
                # figure WITHOUT images, then upload processed images separately.
                self.processed_images.append(processed)
            else:
                # Skip - don't include source URL, server would try to download (and fail)
                print(yellow(f"    Skipping image (download/watermark/size): {img_url[:60]}"))
            # Random delay between image downloads to look human
            import random as _r
            time.sleep(_r.uniform(1.5, 3.0))

        # Report low image count so we can track items that ended up with too
        # few usable images (after thumbnail/size filtering). This is a report
        # event only - we do NOT retry the site to avoid hammering it.
        if not self.dry_run and len(self.processed_images) < LOW_IMAGE_COUNT_THRESHOLD:
            self.report.write(
                "image_low_count",
                source=source,
                itemId=scraped_data.get("item_id"),
                imageCount=len(self.processed_images),
                requestedCount=len(images[:MAX_IMAGES]),
                reason="below_threshold_after_filter",
            )

        # Build payload
        # IMPORTANT: Only include `images` in dry_run mode. In production, images are
        # uploaded separately via /figures/images/upload-processed after figure creation,
        # because the server's figure creation endpoint requires `source` URL and would
        # try to download it (failing with 403 from Cloudflare for MFC/AmiAmi images).
        payload = {
            "slug": slug,
            "name": name,
            "nameEn": name,
            "localized": localized,
            "releases": releases,
        }
        if self.dry_run and image_entries:
            payload["images"] = image_entries
        # In production mode, do NOT include images in payload — upload separately

        if release_date:
            payload["releaseDate"] = release_date
        if price_jpy:
            payload["priceJpy"] = price_jpy
        if jan_code:
            payload["janCode"] = jan_code
        if scale:
            payload["scale"] = scale
        if material:
            payload["material"] = material
        if height_mm:
            payload["heightMm"] = height_mm
        if mfc_id:
            payload["mfcId"] = mfc_id
        if amiami_id:
            payload["amiamiId"] = amiami_id
        if hs_id:
            payload["hobbySearchId"] = hs_id
        if product_line:
            payload["productLine"] = product_line
        if manufacturer_id:
            payload["manufacturerId"] = manufacturer_id
        if category_ids:
            payload["categoryIds"] = category_ids
        # NOTE: product_kind is intentionally NOT sent in the API payload.
        # The backend createFigureSchema/updateFigureSchema/Prisma Figure model
        # does not have a productKind field. We keep product_kind internally for
        # classification, AI prompt selection, report events, and dedup only.
        # Persistence of productKind would require a separate schema migration.

        # Age rating heuristic
        name_lower = name.lower()
        if any(term in name_lower for term in ["18+", "r18", "adult", "cast-off", "native"]):
            payload["ageRating"] = "18+"
        elif any(term in name_lower for term in ["15+", "mature"]):
            payload["ageRating"] = "15+"
        else:
            payload["ageRating"] = "All Ages"

        return payload

    # ------------------------------------------------------------------
    # Create / merge figure via API
    # ------------------------------------------------------------------

    def create_or_merge_figure(self, scraped_data):
        """Create a figure or merge with an existing JAN/source-ID/slug match."""
        payload = self.build_figure_payload(scraped_data)
        if not payload:
            self.report.write("figure_payload_failed", source=scraped_data.get("source"), itemId=scraped_data.get("item_id"))
            return None

        jan_code = payload.get("janCode", "")
        existing, match_reason = self.find_existing_figure(payload)
        if existing:
            print(magenta(f"    {match_reason} matches existing figure #{existing.get('id')}"))
            if self.dry_run:
                review_payload = {
                    "action": "merge",
                    "matchReason": match_reason,
                    "figure": payload,
                    "existing": {
                        "id": existing.get("id"),
                        "slug": existing.get("slug"),
                        "janCode": existing.get("janCode"),
                        "mfcId": existing.get("mfcId"),
                        "amiamiId": existing.get("amiamiId"),
                        "hobbySearchId": existing.get("hobbySearchId"),
                    },
                }
                self.report.write(
                    "figure_would_merge",
                    source=scraped_data.get("source"),
                    itemId=scraped_data.get("item_id"),
                    existingId=existing.get("id"),
                    existingSlug=existing.get("slug"),
                    matchReason=match_reason,
                    janCode=jan_code,
                    payload=payload,
                )
                if self.submit_review:
                    submit_review_item(API_BASE, self.api_headers(), {
                        "type": "figure_import",
                        "title": f"Merge candidate: {payload.get('name') or payload.get('slug')}"[:180],
                        "source": f"mfc_batch_scraper:{scraped_data.get('source')}",
                        "status": "pending",
                        "priority": 1,
                        "confidence": 0.9 if jan_code else 0.65,
                        "figureSlug": existing.get("slug"),
                        "payload": review_payload,
                        "automation": {"provider": "manual", "workflow": "figure-import-review"},
                    })
                return {"dryRun": True, "merged": True, "slug": existing.get("slug")}
            return self._merge_figure(existing, scraped_data, payload)

        # No match - create new figure
        if self.dry_run:
            review_payload = {"action": "create", "figure": payload}
            self.report.write(
                "figure_would_create",
                source=scraped_data.get("source"),
                itemId=scraped_data.get("item_id"),
                janCode=jan_code,
                slug=payload.get("slug"),
                payload=payload,
            )
            if self.submit_review:
                submit_review_item(API_BASE, self.api_headers(), {
                    "type": "figure_import",
                    "title": f"Create candidate: {payload.get('name') or payload.get('slug')}"[:180],
                    "source": f"mfc_batch_scraper:{scraped_data.get('source')}",
                    "status": "pending",
                    "priority": 1,
                    "confidence": 0.7 if jan_code else 0.45,
                    "figureSlug": payload.get("slug"),
                    "payload": review_payload,
                    "automation": {"provider": "manual", "workflow": "figure-import-review"},
                })
            print(cyan(f"    Would create (dry-run): slug={payload.get('slug')}"))
            return {"dryRun": True, "slug": payload.get("slug")}
        return self._create_figure(payload)

    def _create_figure(self, payload):
        """Create a new figure via the API.

        On 409 (slug conflict) we do NOT auto-suffix the slug to create a new
        product - that would silently manufacture duplicates. Instead we look up
        the existing slug, attempt a confident merge, and if we can't confirm
        it is the same product we write a review candidate for a human instead
        of creating a duplicate.

        On 500 (server error) we stop - this is NOT a slug conflict and must
        never be treated as one. We record the failure and return None so the
        caller can defer the job.
        """
        try:
            resp = self.session.post(f"{API_BASE}/figures",
                                      json=payload, headers=self.api_headers())
            if resp.status_code in (200, 201):
                result = resp.json()
                print(green(f"    Created! slug={payload['slug']}"))
                meta = result.get("meta", {})
                if (meta.get("imageImport") or {}).get("errors"):
                    print(yellow(f"    Image import warnings: {len(meta['imageImport'].get('errors', []))} failed"))
                self.report.write("figure_created", slug=payload.get("slug"), response=result.get("data", {}), meta=meta)
                return result.get("data", {})
            elif resp.status_code == 409:
                # Slug conflict: an existing figure already uses this slug.
                # Do NOT auto-suffix. Look up the existing figure and try a
                # confident merge; otherwise write a review candidate.
                print(yellow(f"    Slug conflict (409) for slug={payload['slug']}, looking up existing..."))
                existing = self.find_figure_by_slug(payload["slug"])
                if existing:
                    # Confirm it is the same product via soft-match before merge
                    confident, reason = self._soft_match_confidence(payload, existing)
                    if confident:
                        print(magenta(f"    409 -> confident merge with #{existing.get('id')} ({reason})"))
                        self.report.write(
                            "figure_slug_conflict_merged",
                            slug=payload["slug"],
                            existingId=existing.get("id"),
                            matchReason=reason,
                        )
                        return self._merge_figure(existing, payload, payload)
                    else:
                        # Low confidence - do NOT create a duplicate, write review
                        print(yellow(f"    409 -> low-confidence match, writing review candidate"))
                        self.report.write(
                            "figure_slug_conflict_review",
                            slug=payload["slug"],
                            existingId=existing.get("id"),
                            matchReason=reason,
                            payloadName=payload.get("name"),
                            existingName=existing.get("name"),
                        )
                        if self.submit_review:
                            submit_review_item(API_BASE, self.api_headers(), {
                                "type": "figure_import",
                                "title": f"Slug conflict review: {payload.get('name')}"[:180],
                                "source": f"mfc_batch_scraper:slug409",
                                "status": "pending",
                                "priority": 2,
                                "confidence": 0.4,
                                "figureSlug": existing.get("slug"),
                                "payload": {
                                    "action": "slug_conflict_review",
                                    "newPayload": payload,
                                    "existing": {
                                        "id": existing.get("id"),
                                        "slug": existing.get("slug"),
                                        "name": existing.get("name"),
                                        "janCode": existing.get("janCode"),
                                        "mfcId": existing.get("mfcId"),
                                        "amiamiId": existing.get("amiamiId"),
                                        "hobbySearchId": existing.get("hobbySearchId"),
                                    },
                                    "matchReason": reason,
                                },
                                "automation": {"provider": "manual", "workflow": "slug-conflict-review"},
                            })
                        return None
                else:
                    # 409 but slug lookup returned nothing (race or deleted?)
                    # Write review instead of creating a duplicate with suffix.
                    print(yellow(f"    409 -> existing slug not found, writing review (no auto-suffix)"))
                    self.report.write(
                        "figure_slug_conflict_orphan",
                        slug=payload["slug"],
                        status=409,
                        error=resp.text[:300],
                    )
                    return None
            elif resp.status_code == 500:
                # Server error: NOT a slug conflict. Record and stop - do NOT
                # retry with a different slug, that would hide the real failure.
                print(red(f"    Server error 500 (NOT a slug conflict), stopping: {resp.text[:200]}"))
                self.report.write(
                    "figure_create_server_error",
                    slug=payload.get("slug"),
                    status=500,
                    error=resp.text[:500],
                )
                return None
            else:
                print(red(f"    API error [{resp.status_code}]: {resp.text[:200]}"))
                self.report.write("figure_create_failed", slug=payload.get("slug"), status=resp.status_code, error=resp.text[:500])
                return None
        except Exception as e:
            print(red(f"    Exception: {e}"))
            self.report.write("figure_create_exception", slug=payload.get("slug"), error=str(e))
            return None

    def _merge_figure(self, existing, scraped_data, payload):
        """Merge new data into an existing figure."""
        figure_id = existing.get("id")
        figure_slug = existing.get("slug")
        update_payload = {}

        # Add missing source IDs
        source_fields = {
            "mfcId": scraped_data.get("mfcId", ""),
            "amiamiId": scraped_data.get("amiamiId", ""),
            "hobbySearchId": scraped_data.get("hobbySearchId", ""),
        }
        for field, value in source_fields.items():
            if value and not existing.get(field):
                update_payload[field] = value

        # Add missing localized entries
        existing_localized = existing.get("localized", [])
        existing_langs = {loc.get("language") for loc in existing_localized}
        new_localized = payload.get("localized", [])
        for loc in new_localized:
            if loc.get("language") not in existing_langs:
                existing_localized.append(loc)
        if len(existing_localized) > len(existing.get("localized", [])):
            update_payload["localized"] = existing_localized

        # Add missing release entries
        existing_releases = existing.get("releases", [])
        new_releases = payload.get("releases", [])
        for rel in new_releases:
            # Check if this release already exists (by date + price)
            is_dup = False
            for er in existing_releases:
                if (er.get("releaseDate") == rel.get("releaseDate") and
                        er.get("priceJpy") == rel.get("priceJpy")):
                    is_dup = True
                    break
            if not is_dup:
                existing_releases.append(rel)
        if len(existing_releases) > len(existing.get("releases", [])):
            update_payload["releases"] = existing_releases

        # Add missing images (dedup by sha256 or source URL)
        existing_images = existing.get("images", [])
        existing_sha256s = {img.get("sha256") for img in existing_images if img.get("sha256")}
        existing_sources = {img.get("source", "").split("?")[0] for img in existing_images}
        new_images = payload.get("images", [])
        for img in new_images:
            img_source_clean = img.get("source", "").split("?")[0]
            img_sha256 = img.get("sha256", "")
            if img_sha256 and img_sha256 in existing_sha256s:
                continue
            if img_source_clean and img_source_clean in existing_sources:
                continue
            existing_images.append(img)
        if len(existing_images) > len(existing.get("images", [])):
            update_payload["images"] = existing_images

        # Fill in missing basic fields (do NOT overwrite non-empty human-curated values)
        fillable = ["scale", "material", "heightMm", "productLine", "ageRating", "manufacturerId", "releaseDate", "priceJpy", "description", "janCode"]
        for field in fillable:
            if not existing.get(field) and payload.get(field):
                update_payload[field] = payload[field]
        # Record fields the source could not provide, so callers can tell
        # a genuinely-incomplete record from one that simply lacks source data.
        source_missing_fields = []
        for _f in ("scale", "material", "releaseDate", "priceJpy", "heightMm", "janCode"):
            if not payload.get(_f):
                source_missing_fields.append(_f)

        # Merge categoryIds: ensure merchandise is not stranded in a figure
        # category (pvc-figure/action-figure) after merge, and vice versa.
        existing_cat_ids = set()
        existing_categories = existing.get("categories") or []
        if isinstance(existing_categories, list):
            for cat in existing_categories:
                cat_id = cat.get("id") if isinstance(cat, dict) else cat
                if cat_id:
                    existing_cat_ids.add(str(cat_id))
        # Also check categoryIds field (some API responses use this)
        for cid in (existing.get("categoryIds") or []):
            existing_cat_ids.add(str(cid))

        new_cat_ids = payload.get("categoryIds") or []
        new_cat_id_set = {str(cid) for cid in new_cat_ids}

        if new_cat_ids:
            if not existing_cat_ids:
                # Existing item has no categories at all - add ours
                update_payload["categoryIds"] = new_cat_ids
            elif not existing_cat_ids.intersection(new_cat_id_set):
                # Existing item has categories but none overlap with ours.
                # This may mean the existing item was filed under the wrong
                # category (e.g. a plush filed as pvc-figure). Replace with
                # the new, correctly-classified category rather than leaving
                # merchandise stranded in a figure bucket.
                update_payload["categoryIds"] = new_cat_ids
            # If there IS overlap, the existing category is already correct - no change needed.

        if not update_payload:
            print(cyan(f"    No new data to merge for figure #{figure_id}"))
            self.report.write("figure_merge_noop", existingId=figure_id, existingSlug=figure_slug)
            return existing

        if not figure_slug:
            print(red(f"    Cannot merge figure #{figure_id}: missing slug"))
            self.report.write("figure_merge_failed", existingId=figure_id, reason="missing_slug")
            return existing

        self.report.write("figure_merge_update", existingId=figure_id, existingSlug=figure_slug, payload=update_payload)
        return self.update_figure(figure_slug, update_payload)

    # ------------------------------------------------------------------
    # Import phase
    # ------------------------------------------------------------------

    def import_figures(self, valid_items):
        print(cyan(f"\n=== Phase 3: Importing {len(valid_items)} figures to database ==="))

        already_done = set(self.progress.get("completed", []))

        for i, (item_key, data) in enumerate(valid_items):
            if item_key in already_done:
                print(f"  [{i+1}/{len(valid_items)}] {item_key} - already imported, skipping")
                continue

            name = data.get("full_name", "") or data.get("name", "")
            print(f"  [{i+1}/{len(valid_items)}] {item_key}: {name[:60]}")

            result = self.create_or_merge_figure(data)
            if result:
                if result.get("dryRun"):
                    self.stats["skipped"] += 1
                else:
                    self.progress.setdefault("completed", []).append(item_key)
                    if result.get("merged"):
                        self.stats["merged"] += 1
                    else:
                        self.stats["created"] += 1
            else:
                self.progress.setdefault("failed", []).append(item_key)
                self.stats["failed"] += 1

            if (i + 1) % 10 == 0:
                self.save_progress()

            time.sleep(DELAY_BETWEEN_FIGURES + random.uniform(0.5, 1.5))

        self.save_progress()

    # ------------------------------------------------------------------
    # Main run
    # ------------------------------------------------------------------

    def run(self, phases="all"):
        self.login()
        self.load_progress()
        self.load_manufacturers()
        self.load_categories()

        need_discover = phases == "all" or "discover" in phases
        need_scrape = phases == "all" or "scrape" in phases
        need_import = phases == "all" or "import" in phases

        if not need_discover and (need_scrape or need_import) and not self.discovered:
            print(yellow("No discovered items found, auto-enabling discover phase"))
            need_discover = True

        valid_items = []

        # Discovery phase
        if need_discover:
            # Need browser for MFC and AmiAmi search
            need_browser = any(s in self.sources_to_run for s in ("mfc", "amiami"))
            if need_browser:
                self.start_browser()
            try:
                self.discover_items()
            finally:
                if need_browser:
                    self.stop_browser()

        # Scrape phase
        if need_scrape:
            # Need browser for AmiAmi detail pages; MFC and HobbySearch use requests
            need_browser = "amiami" in self.sources_to_run
            if need_browser:
                self.start_browser()
            try:
                valid_items = self.scrape_and_filter_items()
            finally:
                if need_browser:
                    self.stop_browser()

        # Import phase
        if need_import:
            if not valid_items:
                print(yellow("No valid items to import"))
            else:
                self.import_figures(valid_items)

        # Upload images
        if self.processed_images:
            print(cyan(f"\n=== Phase 4: Uploading {len(self.processed_images)} processed images ==="))
            if self.dry_run:
                print(yellow("  Dry-run enabled, skipping asset upload"))
            else:
                upload_assets_to_server()

        print(f"\n{'='*60}")
        print(f"  Batch Scraper Complete! (sources: {', '.join(self.sources_to_run)})")
        print(f"  Discovered: {self.stats['discovered']}")
        print(f"  Created:    {self.stats['created']}")
        print(f"  Merged:     {self.stats['merged']}")
        print(f"  Failed:     {self.stats['failed']}")
        print(f"  Images:     {len(self.processed_images)} processed locally")
        print(f"  Report:     {self.report.path}")
        print(f"{'='*60}")

    def run_single_item(self, item_id):
        """Scrape and import one source item."""
        if self.source == "all":
            raise ValueError("--item-id requires a single --source value")

        self.login()
        self.load_manufacturers()
        self.load_categories()

        print(cyan(f"\n=== Single item import: {self.source}:{item_id} ==="))
        scraped = self.scrape_source_item(self.source, str(item_id))
        if not scraped or not scraped.get("name"):
            self.report.write("single_item_scrape_failed", source=self.source, itemId=item_id)
            raise RuntimeError(f"No usable data found for {self.source}:{item_id}")
        # Non-figure items are NOT rejected here. prepare_scraped_item will
        # classify them via classify_product_kind() and route merchandise to the
        # appropriate non-figure category so it can be ingested alongside figures.
        data = self.prepare_scraped_item(scraped, self.source)
        if not data:
            self.report.write("single_item_prepare_failed", source=self.source, itemId=item_id)
            raise RuntimeError(f"Prepare returned no usable data for {self.source}:{item_id}")
        result = self.create_or_merge_figure(data)
        if not result:
            raise RuntimeError(f"Import failed for {self.source}:{item_id}")

        self.report.write("single_item_imported", source=self.source, itemId=item_id, name=data.get("full_name"), result=result)
        print(green(f"  Single item done: {data.get('full_name')}"))
        print(f"  Report: {self.report.path}")
        return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    global API_BASE
    import argparse
    parser = argparse.ArgumentParser(description="Figure Batch Scraper for 2024-2026 figures")
    parser.add_argument("--password", type=str, default=DEFAULT_PASSWORD,
                        help="Admin password or MODELWIKI_ADMIN_PASSWORD")
    parser.add_argument("--api-base", type=str, default=API_BASE,
                        help="API base URL")
    parser.add_argument("--phases", type=str, default="all",
                        help="Phases to run: all, discover, scrape, import, scrape+import")
    parser.add_argument("--max-search", type=int, default=15,
                        help="Max results per search query")
    parser.add_argument("--source", type=str, default="mfc",
                        choices=["mfc", "amiami", "hobbysearch", "all"],
                        help="Data source (default: mfc). 'all' runs all three sources.")
    parser.add_argument("--item-id", type=str, default="",
                        help="Scrape and import a single source item ID instead of running batch phases")
    parser.add_argument("--dry-run", action="store_true",
                        help="Build payloads and reports without creating/updating figures")
    parser.add_argument("--submit-review", action="store_true",
                        help="Submit dry-run create/merge candidates to the admin review queue")
    parser.add_argument("--report", type=str, default=None,
                        help="JSONL report path")
    args = parser.parse_args()

    API_BASE = args.api_base.rstrip("/")
    scraper = FigureScraper(
        password=args.password,
        source=args.source,
        dry_run=args.dry_run,
        report_path=args.report,
        submit_review=args.submit_review,
    )
    if args.item_id:
        scraper.run_single_item(args.item_id)
    else:
        scraper.run(phases=args.phases)


if __name__ == "__main__":
    main()
