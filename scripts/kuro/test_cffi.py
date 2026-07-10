from curl_cffi import requests
r = requests.get("https://myfigurecollection.net/item/1675109", impersonate="chrome131", timeout=30)
print("Status:", r.status_code)
print("First 300 chars:", r.text[:300])
