#!/bin/bash
# Signal-API watchdog — detects the signal-cli-rest-api failure mode where
# the daemon crashes at startup, auto-restarts in multi-account mode, but
# the account fails to reload. Symptom: /v1/accounts returns "[]" while the
# REST API and docker container both look healthy.
#
# Adaptive cadence: the failure happens at boot, not mid-run. During the
# first 15 min after boot the timer fires every 60s (caught quickly). After
# that, probes run at most once per hour as a background safety net.
#
# Runs from signal-watchdog.timer. WS-silence is NOT checked — groups can
# sit quiet for hours and restarting on silence would false-trigger.

set -uo pipefail

SIGNAL_URL="${SIGNAL_URL:-http://127.0.0.1:8080}"
SIGNAL_CONTAINER="${SIGNAL_CONTAINER:-signal-api}"
FEYBLET_UNIT="${FEYBLET_UNIT:-feyblet.service}"
BOOT_WINDOW_SECONDS="${BOOT_WINDOW_SECONDS:-900}"     # 15 min after boot
STEADY_INTERVAL_SECONDS="${STEADY_INTERVAL_SECONDS:-3600}"  # hourly after that
STATE_DIR="${STATE_DIR:-/var/lib/signal-watchdog}"
mkdir -p "$STATE_DIR"
LOG_TAG="signal-watchdog"

log() { logger -t "$LOG_TAG" -- "$*"; echo "$(date -Is) $*"; }

# --- Decide whether to probe this tick ---
uptime_seconds="$(awk '{print int($1)}' /proc/uptime)"
last_probe_file="$STATE_DIR/last-probe"
last_probe_epoch="$(cat "$last_probe_file" 2>/dev/null || echo 0)"
now_epoch="$(date +%s)"
since_last_probe="$(( now_epoch - last_probe_epoch ))"

if (( uptime_seconds < BOOT_WINDOW_SECONDS )); then
    # Boot window: probe every time the timer fires
    :
elif (( since_last_probe < STEADY_INTERVAL_SECONDS )); then
    # Steady state: skip until hourly interval has elapsed
    exit 0
fi
echo "$now_epoch" > "$last_probe_file"

# --- Probe: /v1/accounts should be a non-empty JSON array ---
accounts_raw="$(curl -sS --max-time 5 "$SIGNAL_URL/v1/accounts" 2>/dev/null)" || accounts_raw=""
if [[ -z "$accounts_raw" ]]; then
    log "FAIL probe=/v1/accounts reason=no-response uptime=${uptime_seconds}s"
    needs_fix="yes"
elif [[ "$accounts_raw" == "[]" ]]; then
    log "FAIL probe=/v1/accounts reason=empty-array uptime=${uptime_seconds}s"
    needs_fix="yes"
else
    exit 0
fi

# --- Recovery (rate-limited so we don't restart-loop) ---
last_fix_file="$STATE_DIR/last-fix"
last_fix_epoch="$(cat "$last_fix_file" 2>/dev/null || echo 0)"
if (( now_epoch - last_fix_epoch < 300 )); then
    log "SKIP fix=rate-limited last-fix-age=$(( now_epoch - last_fix_epoch ))s"
    exit 0
fi
echo "$now_epoch" > "$last_fix_file"

log "FIX action=docker-restart container=$SIGNAL_CONTAINER"
if ! docker restart "$SIGNAL_CONTAINER" >/dev/null 2>&1; then
    log "FAIL action=docker-restart"
    exit 1
fi

# Wait up to 60s for the account to come back
for i in $(seq 1 30); do
    sleep 2
    body="$(curl -sS --max-time 3 "$SIGNAL_URL/v1/accounts" 2>/dev/null || echo "")"
    if [[ -n "$body" && "$body" != "[]" ]]; then
        log "FIX recovered after ${i}x2s account=$body"
        # Feyblet's WS may still point at the pre-restart connection; nudge
        # it so it reconnects against the fresh container.
        if systemctl is-active --quiet "$FEYBLET_UNIT"; then
            log "FIX restarting $FEYBLET_UNIT so its Signal WS reconnects"
            systemctl restart "$FEYBLET_UNIT" 2>/dev/null || log "WARN feyblet restart failed"
        fi
        exit 0
    fi
done

log "FAIL account-still-empty-after-60s"
exit 1
