import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from import_multi_source import ApiClient
from unittest.mock import patch, MagicMock

test_cases = [
    {"name":"Has Material in spec","item":{"title":"T1","scale":"1/7","manufacturer":"GSC","series":"S1","release_date":"2025-06-01","specifications":"Series: S1\nMaterial: PVC, ABS\nHeight: 260mm"}},
    {"name":"No Material only Series","item":{"title":"T2","scale":"Non","manufacturer":"MF","series":"S2","release_date":"2025-07-01","specifications":"Series: The First Descendant\nHeight: 200mm"}},
    {"name":"Material+Series both","item":{"title":"T3","scale":"1/4","manufacturer":"Alter","series":"S3","release_date":"2025-08-01","specifications":"Series: Vocaloid\nMaterial: ABS\nHeight: 400mm"}},
    {"name":"Field order reversed","item":{"title":"T4","scale":"1/8","manufacturer":"Koto","series":"S4","release_date":"2025-09-01","specifications":"Material: PVC\nSeries: Re:Zero\nHeight: 250mm"}},
]

def make_mock_request(captured):
    def mock_req(method, path, **kw):
        r = MagicMock()
        if path.startswith("/figures/") and method == "GET":
            r.json.return_value = {"success":False}; r.status_code = 404
        elif path == "/figures" and method == "POST":
            captured.append(kw.get("json",{}))
            r.json.return_value = {"success":True,"data":{"id":1}}; r.status_code = 200
        elif path == "/categories":
            r.json.return_value = {"data":[{"slug":"pvc-figure","id":25,"name":"PVC","children":[]}]}; r.status_code = 200
        else:
            r.json.return_value = {"data":{"id":1}}; r.status_code = 200
        return r
    return mock_req

failed = 0
for tc in test_cases:
    captured = []
    client = ApiClient("http://localhost:3001/api/v1")
    client.request = make_mock_request(captured)
    with patch.object(client,"ensure_entity",return_value=1), patch.object(client,"ensure_category",return_value=1):
        client.create_figure(tc["item"])
    if not captured:
        print(f"FAIL: {tc['name']} - no POST /figures"); failed+=1; continue
    if "material" in captured[0]:
        print(f"FAIL: {tc['name']} - material={repr(captured[0]['material'])}"); failed+=1
    else:
        print(f"PASS: {tc['name']}")

print(f"\n{len(test_cases)-failed}/{len(test_cases)} passed")
sys.exit(failed)
