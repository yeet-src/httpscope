#!/usr/bin/env python3
"""A small JSON API and the clients that use it, drifting on a schedule.

Run it next to httpscope and let an investigator find what changed.

    python3 demo/drift_api.py                      # server + clients, drift from t=60s
    python3 demo/drift_api.py --speed 2            # everything twice as fast
    python3 demo/drift_api.py --reveal             # print the schedule and exit
    python3 demo/drift_api.py --no-drift           # a healthy baseline forever

Standard library only. The server listens on --port (8090) and a client
process ("shop-worker") calls it steadily; each drift event fires once at
its time and prints a line to stderr, so a report can be graded against
what really happened. Nothing here is visible to the investigator except
through the wire.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCHEDULE = [
    # (seconds, key, what the investigator should be able to find)
    (60, "users.email.missing", "GET /api/v1/users/{n}: the `email` field stops being sent"),
    (75, "orders.total.type", "GET /api/v1/users/{n}/orders: `total` becomes a string (\"12.50\") instead of a number"),
    (90, "orders.post.500", "POST /api/v1/orders: one in five now fails with 500 {error:\"inventory service timeout\"}"),
    (105, "search.slow", "GET /api/v1/search: +300 ms on every response"),
    (120, "orders.burst", "the client starts fetching /users/{n}/orders for 30 users in a burst every 10 s (an N+1)"),
    (135, "health.false", "GET /api/v1/health: still 200, but the body says {ok:false, degraded:[\"inventory\"]}"),
    (150, "users.tier.added", "GET /api/v1/users/{n}: a new `tier` field appears, and `created_at` becomes an epoch integer"),
    (165, "products.vocabulary", "GET /api/v1/products/{slug}: the client starts asking for 24 different slugs (a vocabulary, not an id)"),
    (180, "auth.plaintext", "the client starts sending Authorization: Bearer … on every request — over plain HTTP"),
]

NAMES = ["ada", "grace", "linus", "ken", "dennis", "barbara", "edsger", "alan"]
PRODUCTS = ["kettle", "toaster", "lamp", "chair", "desk", "monitor", "keyboard", "mouse", "mug", "notebook", "pen", "cable",
            "router", "switch", "plant", "rug", "clock", "speaker", "camera", "tripod", "bag", "bottle", "jacket", "boots"]


class State:
    def __init__(self, drift, speed):
        self.t0 = time.time()
        self.speed = speed
        self.fired = set()
        self.enabled = drift
        self.lock = threading.Lock()

    def now(self):
        return (time.time() - self.t0) * self.speed

    def on(self, key):
        if not self.enabled:
            return False
        at = next(s for s, k, _ in SCHEDULE if k == key)
        live = self.now() >= at
        if live:
            with self.lock:
                if key not in self.fired:
                    self.fired.add(key)
                    desc = next(d for _, k, d in SCHEDULE if k == key)
                    print(f"[drift t={int(self.now())}s] {key}: {desc}", file=sys.stderr, flush=True)
        return live


STATE = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "shop-api/1.4"

    def log_message(self, *a):
        pass

    def send(self, status, body, extra=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        parts = [p for p in u.path.split("/") if p]
        q = urllib.parse.parse_qs(u.query)
        if parts[:3] == ["api", "v1", "users"] and len(parts) == 4:
            uid = int(parts[3]) if parts[3].isdigit() else 0
            if uid <= 0 or uid > 500:
                return self.send(404, {"error": "no such user"})
            user = {"id": uid, "name": NAMES[uid % len(NAMES)], "plan": "pro" if uid % 3 else "free",
                    "created_at": int(1_700_000_000 + uid * 3600) if STATE.on("users.tier.added") else f"2024-{1 + uid % 12:02d}-{1 + uid % 28:02d}T09:00:00Z"}
            if not STATE.on("users.email.missing"):
                user["email"] = f"{user['name']}{uid}@example.com"
            if STATE.on("users.tier.added"):
                user["tier"] = random.choice(["bronze", "silver", "gold"])
            return self.send(200, user)
        if parts[:3] == ["api", "v1", "users"] and len(parts) == 5 and parts[4] == "orders":
            uid = int(parts[3]) if parts[3].isdigit() else 0
            orders = []
            for i in range(uid % 4):
                total = round(10 + (uid * 7 + i * 13) % 90 + 0.5, 2)
                orders.append({"id": uid * 10 + i, "total": f"{total:.2f}" if STATE.on("orders.total.type") else total,
                               "currency": "USD", "status": ["paid", "shipped", "pending"][i % 3]})
            return self.send(200, orders)
        if parts == ["api", "v1", "search"]:
            if STATE.on("search.slow"):
                time.sleep(0.3)
            term = (q.get("q") or [""])[0]
            limit = int((q.get("limit") or ["5"])[0])
            hits = [p for p in PRODUCTS if term.lower() in p][:limit]
            return self.send(200, {"query": term, "results": [{"slug": h, "price": 9.99 + PRODUCTS.index(h)} for h in hits], "took_ms": random.randint(2, 9)})
        if parts == ["api", "v1", "health"]:
            if STATE.on("health.false"):
                return self.send(200, {"ok": False, "degraded": ["inventory"], "version": "1.4.2"})
            return self.send(200, {"ok": True, "version": "1.4.2"})
        if parts[:3] == ["api", "v1", "products"] and len(parts) == 4:
            slug = parts[3]
            if slug not in PRODUCTS:
                return self.send(404, {"error": "no such product"})
            return self.send(200, {"slug": slug, "price": 9.99 + PRODUCTS.index(slug), "in_stock": slug != "tripod"})
        return self.send(404, {"error": "not found"})

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path)
        parts = [p for p in u.path.split("/") if p]
        body = self.read_body()
        if parts == ["api", "v1", "orders"]:
            try:
                order = json.loads(body or b"{}")
            except ValueError:
                return self.send(400, {"error": "bad json"})
            if STATE.on("orders.post.500") and random.random() < 0.2:
                return self.send(500, {"error": "inventory service timeout", "retry_after_ms": 1500})
            return self.send(201, {"id": random.randint(10_000, 99_999), "status": "created", "items": len(order.get("items", []))})
        return self.send(404, {"error": "not found"})


def serve(port):
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    srv.serve_forever()


# ---- the client: a worker that uses the API the way a service would ---------

def client_loop(port, state):
    base = f"http://127.0.0.1:{port}"
    token = "Bearer shop-worker-" + "".join(random.choice("abcdef0123456789") for _ in range(24))

    def call(method, path, body=None):
        headers = {"User-Agent": "shop-worker/2.1", "Accept": "application/json"}
        if state.on("auth.plaintext"):
            headers["Authorization"] = token
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                r.read()
        except urllib.error.HTTPError as e:
            e.read()
        except Exception:
            pass

    last_burst = 0
    while True:
        uid = random.randint(1, 40)
        call("GET", f"/api/v1/users/{uid}")
        call("GET", f"/api/v1/users/{uid}/orders")
        call("GET", f"/api/v1/search?q={random.choice(['la', 'ke', 'mo', 'ch', 'ca'])}&limit={random.choice([3, 5, 10])}")
        if random.random() < 0.5:
            call("POST", "/api/v1/orders", {"user_id": uid, "items": [{"slug": random.choice(PRODUCTS[:6]), "qty": random.randint(1, 3)}]})
        call("GET", "/api/v1/health")
        slugs = PRODUCTS if state.on("products.vocabulary") else PRODUCTS[:3]
        call("GET", f"/api/v1/products/{random.choice(slugs)}")
        if random.random() < 0.05:
            call("GET", f"/api/v1/users/{random.randint(600, 900)}")  # a 404 now and then, as in life
        if state.on("orders.burst") and time.time() - last_burst > 10 / state.speed:
            last_burst = time.time()
            for u in range(1, 31):
                call("GET", f"/api/v1/users/{u}/orders")
        time.sleep(random.uniform(0.4, 0.9) / state.speed)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--speed", type=float, default=1.0, help="run the schedule this many times faster")
    ap.add_argument("--no-drift", action="store_true")
    ap.add_argument("--reveal", action="store_true", help="print the schedule as JSON and exit")
    ap.add_argument("--client-only", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--t0", type=float, default=None, help=argparse.SUPPRESS)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    random.seed(args.seed + (1 if args.client_only else 0))

    if args.reveal:
        print(json.dumps([{"at_s": s, "key": k, "what": d} for s, k, d in SCHEDULE], indent=1))
        return

    global STATE
    STATE = State(not args.no_drift, args.speed)
    if args.t0:
        STATE.t0 = args.t0

    if args.client_only:
        client_loop(args.port, STATE)
        return

    threading.Thread(target=serve, args=(args.port,), daemon=True).start()
    time.sleep(0.3)
    # The client is its own process, so the inventory sees two pids: the
    # server ("drift_api.py") and the worker.
    child = subprocess.Popen([sys.executable, __file__, "--client-only", "--port", str(args.port), "--speed", str(args.speed),
                              "--t0", str(STATE.t0), "--seed", str(args.seed)] + (["--no-drift"] if args.no_drift else []))
    print(f"shop-api on :{args.port}; worker pid {child.pid}; drift {'off' if args.no_drift else f'from t={SCHEDULE[0][0] / args.speed:.0f}s'}", file=sys.stderr, flush=True)
    try:
        while True:
            time.sleep(1)
            for s, k, _ in SCHEDULE:
                STATE.on(k)  # so the server prints each event when its time comes, even if no request touches it
    except KeyboardInterrupt:
        child.terminate()


if __name__ == "__main__":
    main()
