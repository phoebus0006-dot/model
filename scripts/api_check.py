#!/usr/bin/env python3
import json, urllib.request, ssl
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def api(path, params=""):
    url = f"https://www.phoebusstudio.com/wp-json/modelwiki/v1/{path}{params}"
    try:
        req = urllib.request.Request(url, headers={"Host": "www.phoebusstudio.com"})
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            data = json.loads(resp.read())
            return data
    except Exception as e:
        return f"ERROR: {e}"

# Check figures
figs = api("figures", "?per_page=3")
print("=== FIGURES ===")
if isinstance(figs, list):
    print(f"Type: list, count: {len(figs)}")
    for f in figs[:2]:
        print(f"  slug={f.get('slug')}, name={f.get('name')}, id={f.get('id')}")
elif isinstance(figs, dict):
    print(f"Type: dict, keys: {list(figs.keys())[:8]}")
    for k in ['total', 'pages', 'items', 'data', 'figures']:
        if k in figs:
            v = figs[k]
            if isinstance(v, list):
                print(f"  {k}: list({len(v)})")
                if v:
                    print(f"    first: {v[0].get('slug', '?') if isinstance(v[0], dict) else v[0]}")
            else:
                print(f"  {k}: {v}")
else:
    print(figs)

# Check series
series = api("series", "?per_page=3")
print("\n=== SERIES ===")
if isinstance(series, list):
    print(f"Type: list, count: {len(series)}")
    for s in series[:3]:
        print(f"  slug={s.get('slug')}, name={s.get('name')}")
elif isinstance(series, dict):
    print(f"Type: dict, keys: {list(series.keys())[:8]}")
    for k in ['total', 'pages', 'items', 'data']:
        if k in series:
            v = series[k]
            if isinstance(v, list):
                print(f"  {k}: list({len(v)})")
                for i in v[:2]:
                    print(f"    {i.get('slug','?')} - {i.get('name','?')}")
            else:
                print(f"  {k}: {v}")
else:
    print(series)

# Check manufacturers
mans = api("manufacturers", "?per_page=3")
print("\n=== MANUFACTURERS ===")
if isinstance(mans, list):
    print(f"Type: list, count: {len(mans)}")
elif isinstance(mans, dict):
    print(f"Type: dict, keys: {list(mans.keys())[:8]}")
    for k in ['total', 'pages', 'items', 'data']:
        if k in mans:
            v = mans[k]
            if isinstance(v, list):
                print(f"  {k}: list({len(v)})")
            else:
                print(f"  {k}: {v}")
else:
    print(mans)

print("\n=== DONE ===")