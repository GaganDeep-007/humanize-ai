---
title: laya-service
emoji: 🔮
colorFrom: purple
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# laya-service

Typed decision endpoints for the humanize-ai pipeline, backed by the
[`laya`](https://huggingface.co/laya) System 1 decision model on the free CPU
tier. Not a chat model — `state` + typed questions in, calibrated
probabilities out.

- `GET /health` — `{"ok": true, "device": "...", "routing": true}`
- `POST /decide` — body `{"state": "...", "questions": {"name": {"type": "noul"|"choice"|"score", ...}}}` → `{"answers": {...}, "routing": {...}}`

Optional bearer auth: set the `LAYAY_TOKEN` Space secret; when set, every
request must send `Authorization: Bearer <LAYAY_TOKEN>`.

Auto-deploys from this repo (`server.py` + `Dockerfile`).