import sqlite3, json

DB = "/var/lib/docker/volumes/n8n_data/_data/database.sqlite"
conn = sqlite3.connect(DB)
rows = conn.execute("SELECT name, nodes FROM workflow_entity").fetchall()

for name, nodes_json in rows:
    nodes = json.loads(nodes_json)
    print(f"\n=== {name} ===")
    for n in nodes:
        ntype = n.get("type", "")
        nid = n.get("id", "")
        nname = n.get("name", "")
        params = n.get("parameters", {})
        
        # Check IF nodes for combinator location
        if ntype.endswith("if"):
            combo_in_params = "combinator" in params
            combo_in_conds = "combinator" in params.get("conditions", {})
            param_combo = params.get("combinator", "NOT_FOUND")
            cond_combo = params.get("conditions", {}).get("combinator", "NOT_IN_CONDS")
            print(f"  [IF] {nname} (id={nid})")
            print(f"       combo_in_params={combo_in_params}  combo_in_conds={combo_in_conds}")
            print(f"       params[combinator]={param_combo}  conditions[combinator]={cond_combo}")
        
        # Check Label node
        if nid == "84c91f89-7fd7-41eb-ae29-a1c387e585a3":
            top = "addLabelIds" in params
            uf = params.get("updateFields", {})
            uf_label = uf.get("addLabelIds", "NOT_IN_UF") if isinstance(uf, dict) else "UF_NOT_DICT"
            print(f"  [LABEL] {nname}")
            print(f"       top-level addLabelIds={top}  updateFields.addLabelIds={uf_label}")
        
        # Check Gmail Send
        if params.get("operation") == "send":
            send_to = params.get("sendTo", "MISSING")
            cred = n.get("credentials", {})
            cred_id = cred.get("gmailOAuth2", {}).get("id", "MISSING") if cred else "MISSING"
            print(f"  [GMAIL SEND] {nname} (id={nid})")
            print(f"       sendTo={send_to}  credentialId={cred_id}")
        
        # Check Gmail Get
        if params.get("operation") in ("getAll", "get", "getMany"):
            print(f"  [GMAIL GET] {nname} (id={nid})")
            print(f"       operation={params.get('operation')}  returnAll={params.get('returnAll')}  simple={params.get('simple')}")
            filters = params.get("filters", {})
            if isinstance(filters, dict):
                print(f"       filters={json.dumps(filters)}")

conn.close()
