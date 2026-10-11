#!/usr/bin/env python3
"""Laya decision service - System 1 typed decisions over HTTP.

Runs anywhere laya can run: a Windows laptop (install.bat), or a hosted
environment such as a HuggingFace Space (Docker + free CPU tier; there is no
AVX2 requirement here because the laptop/cloud box does the torch lifting).
Serves zero-dependency typed decisions: state + typed questions in,
probabilities out. No text generation, so nothing to parse.

Endpoints:
  GET  /health  -> {"ok": true, "device": "cuda|cpu", "routing": true}
  POST /decide  -> {"state": str|dict, "questions": {...}, "model": optional override}
                    returns {"answers": {...}, "routing": {...}}

Env config:
  PORT        -> listen port (HuggingFace Spaces sets this; default 8094)
  LAYA_TOKEN  -> if set, require `Authorization: Bearer <LAYAY_TOKEN>` (hides the endpoint)
  LAYA_DEVICE -> "cuda" | "cpu" (default: auto-detect)
"""
import hmac
import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("USE_TF", "0")  # avoid transformers/TF import deadlock

logging.basicConfig(level=logging.INFO, format="%(asctime)s laya %(levelname)s %(message)s")
log = logging.getLogger("laya")

PORT = int(os.environ.get("PORT") or os.environ.get("LAYA_PORT") or "8094")
DEVICE = os.environ.get("LAYA_DEVICE", "").strip() or None  # "cuda" | "cpu"
TOKEN = os.environ.get("LAYA_TOKEN", "").strip() or None  # optional bearer auth


class LayaEngine:
    def __init__(self):
        self.router = None
        self.device = "unknown"

    def load(self):
        import torch
        self.device = DEVICE or ("cuda" if torch.cuda.is_available() else "cpu")
        from laya import Router
        # preload keeps all checkpoints resident; lazy mode costs 7-10s per language flip
        self.router = Router(preload=True, device=self.device)
        log.info("router ready device=%s", self.device)

    def health(self):
        return {"ok": True, "device": self.device, "routing": self.router is not None}

    def decide(self, req):
        state = req.get("state")
        questions = req.get("questions")
        if not isinstance(questions, dict) or not questions:
            raise ValueError("questions (dict) is required")
        kwargs = {}
        model = req.get("model")
        if model:
            kwargs["model"] = model
        if self.router is None:
            raise RuntimeError("router not loaded")
        res = self.router.predict(state, questions, **kwargs)
        out = {"routing": res.get("routing", {}), "answers": {}}
        for name, ans in (res.get("answers") or {}).items():
            out["answers"][name] = dict(ans) if isinstance(ans, dict) else {"value": ans}
        return out


class Handler(BaseHTTPRequestHandler):
    server_version = "laya/1.0"
    engine = None

    def _authorized(self):
        if not TOKEN:
            return True
        supplied = self.headers.get("Authorization", "")
        if supplied.startswith("Bearer "):
            candidate = supplied[len("Bearer ") :]
        else:
            candidate = supplied
        return hmac.compare_digest(candidate.encode(), TOKEN.encode())

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
            self._send(200, self.engine.health())
        elif self.path == "/":
            self._send(200, {"ok": True, "service": "laya"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/decide":
            return self._send(404, {"error": "not found"})
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0:
                raise ValueError("empty body")
            req = json.loads(self.rfile.read(length) or b"{}")
            self._send(200, self.engine.decide(req))
        except Exception as e:  # noqa: BLE001
            log.exception("decide failed")
            self._send(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        log.info("req %s %s", self.address_string(), fmt % args)


def main():
    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    engine = LayaEngine()
    engine.load()
    Handler.engine = engine
    log.info("serving on 0.0.0.0:%d", PORT)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()