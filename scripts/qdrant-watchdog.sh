#!/usr/bin/env bash
# Qdrant health watchdog for the local benchmark grind.
#
# Qdrant has corrupted into a `red` collection state twice under heavy
# concurrent write load. While red, every vector upsert 500s, so ingestion
# jobs "complete" as failed and corpora land WITHOUT their vectors — silent
# data loss that can waste hours. This watchdog polls the memories collection
# and auto-restarts Qdrant on `red` (restart triggers WAL recovery, ~25s).
#
# Run it in its own terminal alongside the grind:
#   bash scripts/qdrant-watchdog.sh
#
# Env overrides: QDRANT_URL (default http://localhost:6333),
#   QDRANT_API_KEY (default local-dev-key), QDRANT_CONTAINER
#   (default crosmos-dev-qdrant), POLL_SECONDS (default 30),
#   COLLECTION (default crosmos-memories).
set -uo pipefail

QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
QDRANT_API_KEY="${QDRANT_API_KEY:-local-dev-key}"
QDRANT_CONTAINER="${QDRANT_CONTAINER:-crosmos-dev-qdrant}"
POLL_SECONDS="${POLL_SECONDS:-30}"
COLLECTION="${COLLECTION:-crosmos-memories}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

status_of() {
  curl -s --max-time 6 -H "api-key: ${QDRANT_API_KEY}" \
    "${QDRANT_URL}/collections/${COLLECTION}" 2>/dev/null \
    | bun -e 'try{const j=JSON.parse(require("fs").readFileSync(0));process.stdout.write(String(j.result?.status??"unknown"))}catch{process.stdout.write("unreachable")}' 2>/dev/null
}

recover() {
  echo "[$(ts)] !! ${COLLECTION} is RED — restarting ${QDRANT_CONTAINER}"
  docker restart "${QDRANT_CONTAINER}" >/dev/null 2>&1
  # Wait for healthz, then for the collection to leave red.
  for _ in $(seq 1 60); do
    curl -s --max-time 3 "${QDRANT_URL}/healthz" 2>/dev/null | grep -q "passed" && break
    sleep 2
  done
  for _ in $(seq 1 60); do
    s="$(status_of)"
    if [ "$s" = "green" ] || [ "$s" = "yellow" ]; then
      echo "[$(ts)] ++ recovered — ${COLLECTION} is now ${s}"
      return 0
    fi
    sleep 2
  done
  echo "[$(ts)] ?? still not healthy after restart — manual attention needed"
}

echo "[$(ts)] watchdog up — polling ${COLLECTION} every ${POLL_SECONDS}s (auto-restart on red)"
while true; do
  s="$(status_of)"
  case "$s" in
    red) recover ;;
    unreachable) echo "[$(ts)] qdrant unreachable (starting up?) — will retry" ;;
    green|yellow) : ;;  # healthy/optimizing — quiet
    *) echo "[$(ts)] status=${s}" ;;
  esac
  sleep "${POLL_SECONDS}"
done
