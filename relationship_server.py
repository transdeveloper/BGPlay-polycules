#!/usr/bin/env python3
"""Serve BGPlay with shareable, database-backed polycules."""
import argparse, base64, hashlib, hmac, json, re, secrets, sqlite3, struct, threading, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB = ROOT / "polycule.db"
SEED = ROOT / "polycule.json"
VALID_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

def conn():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE IF NOT EXISTS polycules (id TEXT PRIMARY KEY, document TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT '')")
    return c

def clean(doc):
    people = [{"id": str(p["id"]), "name": str(p["name"])} for p in doc.get("people", [])]
    rels = [{"id": str(r["id"]), "source": str(r["source"]), "target": str(r["target"]), "type": str(r.get("type", "relationship")), "start": int(r.get("start", doc.get("starttime", 0))), "end": r.get("end")} for r in doc.get("relationships", [])]
    return {"starttime": int(doc.get("starttime", 0)), "endtime": int(doc.get("endtime", 2147483647)), "people": people, "relationships": rels}

def pwhash(password):
    if not password: return ""
    salt = secrets.token_bytes(16); key = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return base64.b64encode(salt).decode() + "$" + base64.b64encode(key).decode()

def matches(password, saved):
    if not saved: return True
    try:
        salt, key = [base64.b64decode(x) for x in saved.split("$", 1)]
        return hmac.compare_digest(hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1), key)
    except (ValueError, TypeError): return False

def row(pid):
    with conn() as c: return c.execute("SELECT * FROM polycules WHERE id=?", (pid,)).fetchone()
def save(pid, doc):
    with conn() as c: c.execute("UPDATE polycules SET document=? WHERE id=?", (json.dumps(doc), pid))
def init():
    if not row("default"):
        with conn() as c: c.execute("INSERT INTO polycules VALUES (?, ?, '')", ("default", json.dumps(clean(json.loads(SEED.read_text())))))
def new_id(): return secrets.token_urlsafe(9).rstrip("=")

def send(ws, message):
    data = json.dumps(message, separators=(",", ":")).encode(); n = len(data)
    head = bytes([129, n]) if n < 126 else bytes([129, 126]) + struct.pack("!H", n)
    ws.sendall(head + data)

class Hub:
    def __init__(self): self.clients, self.lock = {}, threading.Lock()
    def sub(self, pid, ws):
        with self.lock: self.clients.setdefault(pid, set()).add(ws)
        item = row(pid); send(ws, {"type":"polycule", "event":"snapshot" if item else "not-found", "polyculeId":pid, "document":json.loads(item["document"]) if item else None})
    def un(self, pid, ws):
        with self.lock: self.clients.get(pid, set()).discard(ws)
    def publish(self, pid, doc):
        with self.lock: sockets = list(self.clients.get(pid, set()))
        for ws in sockets:
            try: send(ws, {"type":"polycule", "event":"updated", "polyculeId":pid, "document":doc})
            except OSError: self.un(pid, ws)
HUB = Hub()

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT), **kwargs)
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket": return self.ws()
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/new")
            self.end_headers()
            return
        if path == "/new":
            self.path = "/index.html"
            return super().do_GET()
        if re.fullmatch(r"/polycule/[A-Za-z0-9_-]{1,64}", path):
            self.path = "/index.html"
            return super().do_GET()
        match = re.fullmatch(r"/api/polycules/([^/]+)", path)
        if match:
            item = row(match.group(1)); return self.out(json.loads(item["document"]) if item else {"error":"Polycule not found."}, 200 if item else 404)
        return super().do_GET()
    def do_POST(self):
        if self.path == "/api/polycules":
            body = self.body(); pid = new_id(); doc = clean(body.get("document", {}))
            with conn() as c: c.execute("INSERT INTO polycules VALUES (?, ?, ?)", (pid, json.dumps(doc), pwhash(body.get("password", ""))))
            return self.out({"id":pid, "url":"/polycule/"+pid}, 201)
        breakup_match = re.fullmatch(r"/api/polycules/([^/]+)/relationships/([^/]+)/breakup", self.path)
        if breakup_match:
            pid, relationship_id = breakup_match.groups(); item = self.editor(pid)
            if not item: return
            doc = json.loads(item["document"])
            relationship = next((r for r in doc["relationships"] if r["id"] == relationship_id), None)
            if not relationship: return self.out({"error":"Relationship not found."}, 404)
            if relationship.get("end") is not None: return self.out({"error":"This relationship has already ended."}, 400)
            relationship["end"] = int(time.time())
            save(pid, doc); HUB.publish(pid, doc); return self.out({"relationship":relationship})
        revert_match = re.fullmatch(r"/api/polycules/([^/]+)/relationships/([^/]+)/revert-breakup", self.path)
        if revert_match:
            pid, relationship_id = revert_match.groups(); item = self.editor(pid)
            if not item: return
            doc = json.loads(item["document"])
            relationship = next((r for r in doc["relationships"] if r["id"] == relationship_id), None)
            if not relationship: return self.out({"error":"Relationship not found."}, 404)
            if relationship.get("end") is None: return self.out({"error":"This relationship is already active."}, 400)
            relationship["end"] = None
            save(pid, doc); HUB.publish(pid, doc); return self.out({"relationship":relationship})
        rel_match = re.fullmatch(r"/api/polycules/([^/]+)/relationships", self.path)
        if rel_match:
            pid = rel_match.group(1); item = self.editor(pid)
            if not item: return
            try:
                body = self.body(); source, target = body["source"], body["target"]
                doc = json.loads(item["document"]); person_ids = {p["id"] for p in doc["people"]}
                if source == target or source not in person_ids or target not in person_ids: raise ValueError("Choose two different people.")
                relationship = {"id":"r-"+new_id(), "source":source, "target":target, "type":str(body.get("type", "relationship")), "start":int(time.time()), "end":None}
                doc["relationships"].append(relationship); save(pid, doc); HUB.publish(pid, doc); return self.out({"relationship":relationship}, 201)
            except (KeyError, ValueError, json.JSONDecodeError) as error: return self.out({"error":str(error)}, 400)
        match = re.fullmatch(r"/api/polycules/([^/]+)/people", self.path)
        if not match: return self.send_error(404)
        pid = match.group(1); item = self.editor(pid)
        if not item: return
        try:
            body = self.body(); person = {"id":body["id"].strip(), "name":body["name"].strip()}
            if not VALID_ID.fullmatch(person["id"]) or not person["name"]: raise ValueError("Enter a valid ID and name.")
            doc = json.loads(item["document"])
            if any(p["id"] == person["id"] for p in doc["people"]): raise ValueError("That person ID already exists.")
            doc["people"].append(person); save(pid, doc); HUB.publish(pid, doc); return self.out({"person":person}, 201)
        except (KeyError, ValueError, json.JSONDecodeError) as error: return self.out({"error":str(error)}, 400)
    def do_DELETE(self):
        rel_match = re.fullmatch(r"/api/polycules/([^/]+)/relationships/([^/]+)", urlparse(self.path).path)
        if rel_match:
            pid, relationship_id = rel_match.groups(); item = self.editor(pid)
            if not item: return
            doc = json.loads(item["document"])
            if not any(r["id"] == relationship_id for r in doc["relationships"]): return self.out({"error":"Relationship not found."}, 404)
            doc["relationships"] = [r for r in doc["relationships"] if r["id"] != relationship_id]
            save(pid, doc); HUB.publish(pid, doc); return self.out({"removed":relationship_id})
        match = re.fullmatch(r"/api/polycules/([^/]+)/people/([^/]+)", urlparse(self.path).path)
        if not match: return self.send_error(404)
        pid, person_id = match.groups(); item = self.editor(pid)
        if not item: return
        doc = json.loads(item["document"])
        if not any(p["id"] == person_id for p in doc["people"]): return self.out({"error":"Person not found."}, 404)
        doc["people"] = [p for p in doc["people"] if p["id"] != person_id]
        doc["relationships"] = [r for r in doc["relationships"] if person_id not in (r["source"], r["target"])]
        save(pid, doc); HUB.publish(pid, doc); return self.out({"removed":person_id})
    def editor(self, pid):
        item = row(pid)
        if not item: self.out({"error":"Polycule not found."}, 404)
        elif not matches(self.headers.get("X-BGPlay-Password", ""), item["password_hash"]): self.out({"error":"Incorrect editor password."}, 401)
        else: return item
    def ws(self):
        parsed = urlparse(self.path); pid = parse_qs(parsed.query).get("polycule", [""])[0]; key = self.headers.get("Sec-WebSocket-Key")
        if not pid or not key: return self.send_error(400)
        accept = base64.b64encode(hashlib.sha1((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101); self.send_header("Upgrade","websocket"); self.send_header("Connection","Upgrade"); self.send_header("Sec-WebSocket-Accept",accept); self.end_headers(); HUB.sub(pid, self.connection)
        try:
            while self.connection.recv(1024): pass
        finally: HUB.un(pid, self.connection)
    def body(self): return json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode())
    def out(self, payload, code=200):
        data = json.dumps(payload).encode(); self.send_response(code); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--port", type=int, default=8766); args = parser.parse_args(); init()
    print("Serving at http://localhost:%s/polycule/default" % args.port); ThreadingHTTPServer(("", args.port), Handler).serve_forever()
