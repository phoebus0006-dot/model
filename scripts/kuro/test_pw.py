import sys
sys.stdout.reconfigure(line_buffering=True)
from playwright.sync_api import sync_playwright
import time

print("Starting Playwright stealth test...", flush=True)
with sync_playwright() as p:
    print("Launching browser...", flush=True)
    browser = p.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-gpu",
            "--disable-dev-shm-usage",
        ]
    )
    context = browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport={"width": 1920, "height": 1080},
        locale="en-US",
    )
    context.add_init_script("""
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
        Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
        window.chrome = {runtime: {}};
    """)
    page = context.new_page()
    print("Navigating to MFC...", flush=True)
    try:
        page.goto("https://myfigurecollection.net/item/1675109", wait_until="domcontentloaded", timeout=60000)
        print("DOM loaded, waiting for Cloudflare challenge...", flush=True)
        for i in range(12):
            time.sleep(5)
            html = page.content()
            if "Just a moment" not in html[:500] and len(html) > 1000:
                print(f"Page loaded after {(i+1)*5}s!", flush=True)
                print(f"Page length: {len(html)}", flush=True)
                print(f"Title: {page.title()}", flush=True)
                og_title = page.query_selector('meta[property="og:title"]')
                if og_title:
                    print(f"OG Title: {og_title.get_attribute('content')}", flush=True)
                break
            print(f"  Still waiting... ({(i+1)*5}s)", flush=True)
        else:
            print("Timeout waiting for Cloudflare challenge to complete", flush=True)
            print(f"Final page length: {len(page.content())}", flush=True)
    except Exception as e:
        print(f"Error: {e}", flush=True)
    browser.close()
    print("Done!", flush=True)
