#!/usr/bin/env bash
# Install the Laya decision service on the LAPTOP (the box that can host it).
#   - creates a venv, installs `laya`, registers a systemd user unit
#   - serves 0.0.0.0:8094 so the desktop (http://192.168.29.94:8094) can reach it
# Run on the laptop:  cd laya-service && ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

python3 - <<'PY'
import sys
if sys.version_info < (3, 9):
    print("ERROR: need Python >= 3.9 on the laptop (got %d.%d)" % sys.version_info[:2])
    sys.exit(1)
PY

if [ -d .venv ]; then
  echo ">> Reusing existing .venv (remove it first for a clean install)"
fi
python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip >/dev/null
echo ">> Installing laya (+ torch/transformers deps, ~2GB) — this may take several minutes..."
./.venv/bin/python -m pip install laya

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/humanize-laya.service <<EOF
[Unit]
Description=Laya typed-decision service (humanize-ai)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
ExecStart=$(pwd)/.venv/bin/python server.py
Environment=PYTHONUNBUFFERED=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now humanize-laya.service

echo
echo "Laya service installed and started."
echo "  Health:  curl http://localhost:8094/health"
echo "  Logs:    journalctl --user -u humanize-laya.service -f"
echo "  Desktop: auto-uses http://192.168.29.233:8094 (config: layaUrl)"
echo
echo "NOTE: first launch downloads model weights (~800MB) from HuggingFace."
echo "If the laptop firewall blocks it, allow TCP 8094."