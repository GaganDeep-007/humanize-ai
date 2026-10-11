# -*- coding: utf-8 -*-
"""Laya decision service on Google Colab (all-free, no laptop dependency).

Set BOT_TOKEN / CHAT_ID as env vars (see SET ME below), then Run → Run all.

What it does:
  1. pip installs `laya` (+ torch CPU) into the Colab VM
  2. starts the Laya /decide + /health service on 0.0.0.0:8094
  3. opens a free Cloudflare quick tunnel (trycloudflare.com, no account)
  4. texts the humanize-ai Telegram bot:  layacfg <url> <token>

The bot stores that URL+token as its decision layer, so from the desktop
gates start hitting Laya the moment the size of the file completes warming.
If the Colab session is reconnected later, rerun this cell and the bot
updates to the new tunnel URL automatically.
"""
# ---------------------------------------------------------------------------
# SET ME (via Colab env or run-with-edit; never commit real tokens):
#   BOT_TOKEN = your Telegram bot token from BotFather
#   CHAT_ID   = your Telegram user id (owner of the bot)
# ---------------------------------------------------------------------------

import os
import re
import secrets
import subprocess
import threading
import time
import urllib.request

BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
CHAT_ID = int(os.environ.get("CHAT_ID", "0"))
if not BOT_TOKEN or CHAT_ID <= 0:
    raise SystemExit("Set BOT_TOKEN and CHAT_ID env vars before running (see header).")

os.environ["USE_TF"] = "0"

PORT = 8094
TOKEN = secrets.token_urlsafe(24)
print("Laya bearer token:", TOKEN)
print("Installing laya (this is the slow step, ~2GB)...")
subprocess.run(["python", "-m", "pip", "-q", "install", "laya"], check=True)
print("Installing cloudflared tunnel...")
import pathlib
CF_ARCH_PATHS = {
    "x86_64": "cloudflared-linux-amd64",
    "aarch64": "cloudflared-linux-arm64",
}
ARCH = CF_ARCH_PATHS.get(subprocess.check_output(["uname", "-m"]).decode().strip())
if not ARCH:
    raise SystemExit("Unsupported arch")
CF = "/root/.local/bin/cloudflared"
pathlib.Path(CF).parent.mkdir(parents=True, exist_ok=True)
urllib.request.urlretrieve(
    "https://github.com/cloudflare/cloudflared/releases/latest/download/" + ARCH,
    CF,
)
os.chmod(CF, 0o755)

# --- serve Laya -------------------------------------------------------------
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s laya %(levelname)s %(message)s")
log = logging.getLogger("laya")

from laya import Router

router = Router(preload=True, device="cpu")
log.info("router ready device=cpu")
print("Laya router loaded ✓")


class Handler(BaseHTTPRequestHandler):
    def _authorized(self):
        supplied = self.headers.get("Authorization", "")
        candidate = supplied[len("Bearer "):] if supplied.startswith("Bearer ") else supplied
        return secrets.compare_digest(candidate.encode(), TOKEN.encode())

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        if self.path == "/health":
            self._send(200, {"ok": True, "device": "cpu", "routing": router is not None})
        elif self.path == "/":
            self._send(200, {"ok": True, "service": "laya"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/decide" or not self._authorized():
            return self._send(404 if self.path != "/decide" else 401, {"error": "unauthorized" if self.path == "/decide" else "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
            res = router.predict(req.get("state"), req.get("questions"),
                                 **({"model": req["model"]} if req.get("model") else {}))
            out = {"routing": res.get("routing", {}), "answers": {}}
            for name, ans in (res.get("answers") or {}).items():
                out["answers"][name] = dict(ans) if isinstance(ans, dict) else {"value": ans}
            self._send(200, out)
        except Exception as e:  # noqa: BLE001
            log.exception("decide failed")
            self._send(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        log.info("req %s %s", self.address_string(), fmt % args)


httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
httpd.allow_reuse_address = True
print(f"Laya HTTP service listening on 0.0.0.0:{PORT}")


def run_cloudflared():
    proc = subprocess.Popen(
        [CF, "tunnel", "--url", f"http://localhost:{PORT}", "--no-autoupdate"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    for line in proc.stdout:
        line = line.strip()
        m = re.search(r"(https://[a-z0-9-]+\.trycloudflare\.com)", line)
        if m:
            url = m.group(1)
            print("TUNNEL URL:", url)
            try:
                body = urllib.request.urlopen(urllib.request.Request(
                    f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                    data=urllib.parse.urlencode({
                        "chat_id": CHAT_ID,
                        "text": f"layacfg {url} {TOKEN}",
                    }).encode(),
                ), timeout=20).read()
                print("Telegram handed off ✓", body[:120])
            except Exception as e:  # noqa: BLE001
                print("Telegram notify failed:", e)
            break
    else:
        print("cloudflared exited without a URL (exit %r)" % proc.returncode)


tunnel_thread = threading.Thread(target=run_cloudflared, daemon=True)
tunnel_thread.start()

print("Serving Laya decisions until this Colab session ends.")
httpd.serve_forever()