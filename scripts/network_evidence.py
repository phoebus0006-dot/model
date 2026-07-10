import os, json, sys, time
from playwright.sync_api import sync_playwright

USERNAME = os.environ.get("MW_ADMIN_USERNAME")
PASSWORD = os.environ.get("MW_ADMIN_PASSWORD")
BASE = os.environ.get("MW_BASE_URL", "https://www.phoebusstudio.com")

if not USERNAME:
    print("FATAL: MW_ADMIN_USERNAME not set", file=sys.stderr)
    sys.exit(1)
if not PASSWORD:
    print("FATAL: MW_ADMIN_PASSWORD not set", file=sys.stderr)
    sys.exit(1)


def classify(url: str):
    u = url.lower()
    if "/review/image-proxy" in u:
        return "image-proxy"
    if "/figures/" in u and "/admin" not in u:
        return "figure"
    if "/admin/review/items" in u or "/admin/review" in u:
        return "review"
    return "other"


def count_phase(reqs):
    return {
        "review": sum(1 for r in reqs if r["type"] == "review"),
        "figure": sum(1 for r in reqs if r["type"] == "figure"),
        "proxy": sum(1 for r in reqs if r["type"] == "image-proxy"),
        "429": sum(1 for r in reqs if r["status"] == 429),
    }


def login_if_needed(page):
    try:
        page.wait_for_selector("#login-username", timeout=3000)
        page.fill("#login-username", USERNAME)
        page.fill("#login-password", PASSWORD)
        page.click("#login-btn")
        page.wait_for_selector('[data-section="review"]', timeout=15000)
    except:
        pass  # already logged in


def wait_review(page):
    try:
        page.wait_for_selector('[data-section="review"]', timeout=10000)
        page.click('[data-section="review"]')
        page.wait_for_timeout(8000)
    except:
        page.wait_for_timeout(5000)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()

        all_reqs = []
        page_errors = []

        def on_response(resp):
            all_reqs.append({
                "url": resp.url,
                "status": resp.status,
                "type": classify(resp.url),
            })

        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("response", on_response)

        # === PHASE A: first login + review ===
        page.goto(f"{BASE}/guanli/", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2000)
        login_if_needed(page)
        wait_review(page)
        time.sleep(2)
        phase_a_off = len(all_reqs)

        # === PHASE B: page.reload() + review ===
        page.reload(wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2000)
        login_if_needed(page)  # sessionStorage persists, usually auto-login
        wait_review(page)
        time.sleep(2)
        phase_b_off = len(all_reqs)

        # === PHASE C: dashboard -> review switch (no reload) ===
        try:
            page.wait_for_selector('[data-section="dashboard"]', timeout=5000)
            page.click('[data-section="dashboard"]')
            page.wait_for_timeout(4000)
        except:
            pass
        wait_review(page)
        time.sleep(2)
        phase_c_off = len(all_reqs)

        browser.close()

    # === REPORT ===
    phase_a = count_phase(all_reqs[:phase_a_off])
    phase_b = count_phase(all_reqs[phase_a_off:phase_b_off])
    phase_c = count_phase(all_reqs[phase_b_off:phase_c_off])

    labels = {
        "A (login + first review)": phase_a,
        "B (page.reload + review)": phase_b,
        "C (dashboard -> review switch)": phase_c,
    }

    lines = []
    for label, counts in labels.items():
        lines.append(f"=== {label} ===")
        lines.append(f"  review API requests:      {counts['review']}")
        lines.append(f"  figure API requests:      {counts['figure']}")
        lines.append(f"  image-proxy requests:     {counts['proxy']}")
        lines.append(f"  429 count:                {counts['429']}")
        lines.append("")

    total = count_phase(all_reqs)
    lines.append("=== SESSION TOTALS ===")
    lines.append(f"  review API requests:      {total['review']}")
    lines.append(f"  figure API requests:      {total['figure']}")
    lines.append(f"  image-proxy requests:     {total['proxy']}")
    lines.append(f"  429 count:                {total['429']}")
    lines.append(f"  pageerror count:          {len(page_errors)}")
    for pe in page_errors[:5]:
        lines.append(f"    {str(pe)[:120]}")

    summary = {"A": phase_a, "B": phase_b, "C": phase_c, "total": total, "page_errors": len(page_errors)}
    lines.append(f"\nMACHINE_SUMMARY|{json.dumps(summary)}")

    return "\n".join(lines)


if __name__ == "__main__":
    print(run())
