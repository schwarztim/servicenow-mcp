#!/bin/bash
# ServiceNow cookie refresh script — runs on host via launchd
# Checks cookie freshness, re-authenticates headless if needed, restarts container

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COOKIE_FILE="$HOME/.servicenow-mcp/cookies.json"
LOCK_FILE="$HOME/.servicenow-mcp/.refresh.lock"
LOG_FILE="$HOME/.servicenow-mcp/token-refresh.log"
MAX_RETRIES=3
RETRY_DELAY=30
NODE="/opt/homebrew/opt/node@22/bin/node"
# Cookie TTL: 4 hours (ServiceNow default), refresh when < 30 min remaining
REFRESH_THRESHOLD_MIN=30

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_FILE"; }

# Trim log
tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null || true

# Lock
if [ -f "$LOCK_FILE" ]; then
    LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
    if [ "$LOCK_AGE" -lt 300 ]; then
        log "SKIP: another refresh is running (lock age: ${LOCK_AGE}s)"
        exit 0
    fi
    log "WARN: removing stale lock (age: ${LOCK_AGE}s)"
    rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Check cookie freshness
if [ -f "$COOKIE_FILE" ]; then
    CACHED_AT=$(python3 -c "
import json, time
try:
    d = json.load(open('$COOKIE_FILE'))
    # host-auth.mjs writes 'capturedAt' (ms), auth.ts writes 'capturedAt' (ms)
    print(int(d.get('capturedAt', d.get('cachedAt', 0))))
except: print(0)
" 2>/dev/null)
    NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
    AGE_MIN=$(( (NOW_MS - CACHED_AT) / 60000 ))
    REMAINING_MIN=$(( 240 - AGE_MIN ))  # 4 hour TTL assumed

    if [ "$REMAINING_MIN" -gt "$REFRESH_THRESHOLD_MIN" ]; then
        log "OK: cookies still fresh (${REMAINING_MIN}min remaining, threshold: ${REFRESH_THRESHOLD_MIN}min)"
        exit 0
    fi
    log "REFRESH: cookies expiring soon (${REMAINING_MIN}min remaining)"
else
    log "REFRESH: no cookie file found"
fi

# Read credentials from keychain
export TOTP_SECRET=$(security find-generic-password -s "sso-totp" -a "user@example.com" -w "$HOME/Library/Keychains/secure-tools.keychain-db" 2>/dev/null || true)
PASSWORD=$(security find-generic-password -s "corp-sso" -a "password" -w "$HOME/Library/Keychains/secure-tools.keychain-db" 2>/dev/null || true)
export SERVICENOW_INSTANCE_URL="https://instance.service-now.com"
export SERVICENOW_CREDENTIALS="{\"username\":\"user@example.com\",\"password\":\"$PASSWORD\"}"

# Retry loop
for i in $(seq 1 $MAX_RETRIES); do
    log "AUTH: attempt $i/$MAX_RETRIES (headless)..."
    if "$NODE" "$SCRIPT_DIR/scripts/host-auth.mjs" --headless 2>&1 | tee -a "$LOG_FILE"; then
        log "AUTH: success on attempt $i"

        # Restart container
        log "RESTART: stopping servicenow..."
        /opt/homebrew/bin/thv stop servicenow 2>&1 | tee -a "$LOG_FILE" || true
        sleep 2
        log "RESTART: starting servicenow..."
        /opt/homebrew/bin/thv start servicenow 2>&1 | tee -a "$LOG_FILE"
        sleep 3

        # Sync MCPU ports
        bash "$HOME/Scripts/sync-mcpu-ports.sh" 2>&1 | tee -a "$LOG_FILE" || true

        log "DONE: ServiceNow refresh complete"
        exit 0
    fi

    if [ "$i" -lt "$MAX_RETRIES" ]; then
        log "RETRY: waiting ${RETRY_DELAY}s..."
        sleep "$RETRY_DELAY"
    fi
done

log "FAIL: all $MAX_RETRIES attempts failed"
exit 1
