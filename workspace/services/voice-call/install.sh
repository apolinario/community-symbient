#!/usr/bin/env bash
# Install + activate the feyblet voice-call systemd service.
# Run once with sudo. Idempotent — safe to re-run after edits.
#
#   sudo bash install.sh
#
# What it does:
#   1. Stops any manually-running uv process on :8400 so the unit can take it.
#   2. Copies the unit file to /etc/systemd/system/.
#   3. Adds `feyblet-voice-call.service` to feyblet.service's Wants= so
#      starting feyblet auto-starts the call relay (and stopping feyblet
#      stops the relay via the unit's Requires=).
#   4. systemctl daemon-reload + enable + start.
#   5. Restarts feyblet so the new dependency takes effect.
#   6. Verifies both endpoints are healthy.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Re-running with sudo..."
    exec sudo -E bash "$0" "$@"
fi

REPO_ROOT="/home/plantoidz/pi/feyblet"
UNIT_SRC="${REPO_ROOT}/workspace/services/voice-call/feyblet-voice-call.service"
UNIT_DST="/etc/systemd/system/feyblet-voice-call.service"
FEYBLET_UNIT="/etc/systemd/system/feyblet.service"

if [[ ! -f "$UNIT_SRC" ]]; then
    echo "ERROR: $UNIT_SRC not found" >&2
    exit 1
fi

echo "[1/6] Stopping any manually-running Python server on :8400..."
fuser -k 8400/tcp 2>/dev/null || true
sleep 1

echo "[2/6] Installing unit file → $UNIT_DST"
cp "$UNIT_SRC" "$UNIT_DST"
chmod 644 "$UNIT_DST"

echo "[3/6] Adding feyblet-voice-call.service to feyblet.service Wants= (idempotent)"
if ! grep -q "feyblet-voice-call.service" "$FEYBLET_UNIT"; then
    sed -i 's/^Wants=\(.*\)$/Wants=\1 feyblet-voice-call.service/' "$FEYBLET_UNIT"
    echo "      added"
else
    echo "      already present"
fi

echo "[4/6] systemctl daemon-reload + enable"
systemctl daemon-reload
systemctl enable feyblet-voice-call.service

echo "[5/6] Restarting feyblet (which auto-starts feyblet-voice-call via Wants=)"
systemctl restart feyblet
sleep 5

echo "[6/6] Verifying..."
echo
echo "feyblet:           $(systemctl is-active feyblet)"
echo "feyblet-voice-call: $(systemctl is-active feyblet-voice-call)"
echo
echo "Bridge health (TS, port 3334):"
curl -sf -m 3 http://127.0.0.1:3334/health || echo "  NOT REACHABLE"
echo
echo "Audio relay health (Python, port 8400, HTTPS):"
curl -sfk -m 3 https://localhost:8400/health || echo "  NOT REACHABLE"
echo
echo
echo "Done. Caller URL: https://192.168.10.130:8400/?key=feyblade-2026"
echo "Logs:           journalctl -u feyblet-voice-call -f"
echo "Refresh greetings:  cd workspace/services/voice-call && uv run render-greetings.py"
