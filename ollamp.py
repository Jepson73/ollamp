#!/usr/bin/env python3
"""
Ollamp: a small local status page for Ollama and NVIDIA GPUs, in classic Winamp style.

Read-only: it runs nvidia-smi and calls each Ollama instance's /api/ps and /api/version.
It never changes anything in Ollama, makes no requests outside your machine and uses only
the Python standard library.

  python3 ollamp.py                          # http://127.0.0.1:8088, this machine only
  python3 ollamp.py --bind 0.0.0.0           # reachable from your local network
  python3 ollamp.py --instance ollama=11434 --instance ollama-big=11436

--instance is NAME=PORT. If NAME matches a systemd service (ollama.service -> "ollama"),
Ollamp can tell which instance runs on which GPU.
"""
import argparse
import json
import os
import re
import subprocess
import threading
import time
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/ollamp.css": ("ollamp.css", "text/css; charset=utf-8"),
    "/ollamp.js": ("ollamp.js", "text/javascript; charset=utf-8"),
}
DEFAULT_INSTANCES = ["ollama=11434"]
GPU_FIELDS = ["index", "uuid", "name", "utilization.gpu", "utilization.memory", "memory.used",
              "memory.total", "power.draw", "power.limit", "temperature.gpu", "clocks.sm",
              "clocks.max.sm", "fan.speed", "pstate"]
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
       "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None  # "[N/A]" and similar


def run(argv):
    out = subprocess.run(argv, capture_output=True, text=True, timeout=5)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip()[:200] or "nvidia-smi failed")
    return [r for r in out.stdout.strip().splitlines() if r.strip()]


def process_info(pid):
    """Systemd service (from /proc/<pid>/cgroup) and process name for a PID."""
    service = comm = None
    try:
        with open(f"/proc/{int(pid)}/cgroup", encoding="utf-8") as f:
            m = re.search(r"/([^/\s]+)\.service", f.read())
            service = m.group(1) if m else None
    except (OSError, ValueError):
        pass
    try:
        with open(f"/proc/{int(pid)}/comm", encoding="utf-8") as f:
            comm = f.read().strip()
    except (OSError, ValueError):
        pass
    return service, comm


def read_gpus():
    gpus = []
    for row in run(["nvidia-smi", "--query-gpu=" + ",".join(GPU_FIELDS), "--format=csv,noheader,nounits"]):
        v = [x.strip() for x in row.split(",")]
        if len(v) != len(GPU_FIELDS):
            continue
        d = dict(zip(GPU_FIELDS, v))
        gpus.append({
            "index": int(d["index"]), "uuid": d["uuid"], "name": d["name"],
            "util": num(d["utilization.gpu"]), "mem_bus": num(d["utilization.memory"]),
            "vram_mb": num(d["memory.used"]), "vram_total_mb": num(d["memory.total"]),
            "watts": num(d["power.draw"]), "watts_max": num(d["power.limit"]),
            "temp": num(d["temperature.gpu"]), "clock": num(d["clocks.sm"]),
            "clock_max": num(d["clocks.max.sm"]), "fan": num(d["fan.speed"]),
            "pstate": d["pstate"], "processes": [],
        })
    try:
        by_uuid = {g["uuid"]: g for g in gpus}
        for row in run(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,used_memory",
                        "--format=csv,noheader,nounits"]):
            uuid, pid, mb = [x.strip() for x in row.split(",")[:3]]
            if uuid in by_uuid:
                service, comm = process_info(pid)
                by_uuid[uuid]["processes"].append({"service": service, "comm": comm, "vram_mb": num(mb)})
    except (RuntimeError, ValueError):
        pass  # the process list is a bonus
    return gpus


def to_epoch(s):
    """Ollama's expires_at has nanoseconds; Python accepts at most microseconds."""
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def get_json(url, timeout=1.5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def read_instance(name, port, host, now):
    base = f"http://{host}:{port}"
    inst = {"name": name, "port": port, "up": False, "version": None, "models": [], "error": None}
    try:
        inst["version"] = get_json(base + "/api/version").get("version")
        ps = get_json(base + "/api/ps")
        inst["up"] = True
    except Exception as e:  # down, timeout, bad response
        inst["error"] = type(e).__name__
        return inst
    for m in ps.get("models") or []:
        d = m.get("details") or {}
        expires = to_epoch(m.get("expires_at"))
        inst["models"].append({
            "name": m.get("name") or m.get("model"),
            "size": m.get("size"), "vram": m.get("size_vram"),
            "context": m.get("context_length"),
            "params": d.get("parameter_size"), "quant": d.get("quantization_level"),
            "family": d.get("family"),
            "left_s": None if expires is None else max(0.0, expires - now),
        })
    return inst


class Collector:
    """Reads at most once every 0.8 s, however many browser tabs are open."""

    def __init__(self, instances, host):
        self.instances, self.host = instances, host
        self.lock = threading.Lock()
        self.last, self.body = 0.0, b"{}"

    def status(self):
        with self.lock:
            if time.time() - self.last > 0.8:
                self.body = json.dumps(self._collect(), ensure_ascii=False).encode()
                self.last = time.time()
            return self.body

    def _collect(self):
        now = time.time()
        out = {"now": now, "gpus": [], "gpu_error": None, "instances": []}
        try:
            out["gpus"] = read_gpus()
        except (OSError, RuntimeError, subprocess.SubprocessError) as e:
            out["gpu_error"] = str(e)[:200] or type(e).__name__
        threads, results = [], [None] * len(self.instances)

        def job(i, name, port):
            results[i] = read_instance(name, port, self.host, now)

        for i, (name, port) in enumerate(self.instances):
            t = threading.Thread(target=job, args=(i, name, port), daemon=True)
            t.start()
            threads.append(t)
        for t in threads:
            t.join(3)
        out["instances"] = [r or {"name": n, "port": p, "up": False, "models": [], "error": "timeout"}
                            for r, (n, p) in zip(results, self.instances)]
        return out


def make_handler(collector):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Ollamp"
        sys_version = ""

        def _send(self, code, ctype, body, cache="no-store"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/status":
                return self._send(200, "application/json; charset=utf-8", collector.status())
            if path in FILES:
                fname, ctype = FILES[path]
                try:
                    with open(os.path.join(WEB, fname), "rb") as f:
                        return self._send(200, ctype, f.read(), "no-cache")
                except OSError:
                    pass
            self._send(404, "text/plain; charset=utf-8", b"404\n")

        do_HEAD = do_GET

        def log_message(self, *args):
            pass  # no access log

    return Handler


def main():
    p = argparse.ArgumentParser(description="Ollamp: a Winamp-style status page for Ollama and NVIDIA GPUs.")
    p.add_argument("--bind", default="127.0.0.1", help="address to listen on (0.0.0.0 = whole network)")
    p.add_argument("--port", type=int, default=8088)
    p.add_argument("--ollama-host", default="127.0.0.1", help="where the Ollama instances are reached")
    p.add_argument("--instance", action="append", metavar="NAME=PORT",
                   help="Ollama instance; NAME should match its systemd service. Repeatable.")
    a = p.parse_args()
    instances = []
    for s in a.instance or DEFAULT_INSTANCES:
        name, _, port = s.partition("=")
        if not name or not port.isdigit():
            p.error(f"--instance must be NAME=PORT, not {s!r}")
        instances.append((name, int(port)))
    server = ThreadingHTTPServer((a.bind, a.port), make_handler(Collector(instances, a.ollama_host)))
    print(f"Ollamp on http://{a.bind}:{a.port}  ({', '.join(f'{n}:{p}' for n, p in instances)})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
