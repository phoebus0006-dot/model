#!/usr/bin/env python3
"""Comprehensive data audit: series names, figure images, data integrity"""
import subprocess, json

def api(path):
    cmd = f"sudo docker exec mw-wordpress curl -s -m5 'http://api:3000/api/v1/{path}' 2>/dev/null"
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except:
        return result.stdout[:500]

print("=== 1. SERIES: nameEn vs name ===")
series_data = api("series?per_page=10")
if isinstance(series_data, list):
    for s in series_data[:10]:
        print(f"  nameEn={s.get('nameEn')} | name={s.get('name')} | slug={s.get('slug')}")
    # Count how many have nameEn
    with_en = sum(1 for s in series_data if s.get('nameEn'))
    print(f"  Total: {len(series_data)}, have nameEn: {with_en}")

print("\n=== 2. FIGURES: Check images and seriesId ===")
fig_data = api("figures?per_page=10&sort=createdAt:desc")
if isinstance(fig_data, list) or (isinstance(fig_data, dict) and 'data' in fig_data):
    items = fig_data if isinstance(fig_data, list) else fig_data.get('data', [])
    for f in items[:5]:
        imgs = f.get('images', [])
        first_img = imgs[0].get('url', 'NONE') if imgs else 'NO_IMAGE'
        print(f"  slug={f.get('slug')}")
        print(f"    nameEn={f.get('nameEn')}")
        print(f"    seriesId={f.get('seriesId')}  series={f.get('series')}")
        print(f"    manufacturerId={f.get('manufacturerId')}  images={len(imgs)}  first={first_img[:80]}")
    # Stats
    with_series = sum(1 for f in items if f.get('seriesId'))
    with_images = sum(1 for f in items if f.get('images'))
    print(f"  Total: {len(items)}, have seriesId: {with_series}, have images: {with_images}")

print("\n=== 3. MANUFACTURERS: nameEn vs name ===")
man_data = api("manufacturers?per_page=10")
if isinstance(man_data, list):
    for m in man_data[:5]:
        print(f"  nameEn={m.get('nameEn')} | name={m.get('name')} | slug={m.get('slug')}")
    with_en = sum(1 for m in man_data if m.get('nameEn'))
    print(f"  Total: {len(man_data)}, have nameEn: {with_en}")

print("\n=== 4. SCULPTORS: nameEn vs name ===")
sc_data = api("sculptors?per_page=10")
if isinstance(sc_data, list):
    for s in sc_data[:5]:
        print(f"  nameEn={s.get('nameEn')} | name={s.get('name')} | slug={s.get('slug')}")
    with_en = sum(1 for s in sc_data if s.get('nameEn'))
    print(f"  Total: {len(sc_data)}, have nameEn: {with_en}")

print("\n=== 5. Check specific figure with multiple images ===")
fig_data2 = api("figures?per_page=20")
if isinstance(fig_data2, list):
    for f in fig_data2:
        imgs = f.get('images', [])
        if len(imgs) > 1:
            print(f"  Multi-image figure: {f.get('slug')}")
            for i, img in enumerate(imgs):
                print(f"    [{i}] url={img.get('url')}  alt={img.get('alt')}")
            break
    else:
        print("  No figure has more than 1 image!")

print("\n=== DONE ===")