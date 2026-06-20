#!/usr/bin/env bash
# Alert tripwire for the benchmark grind.
#
# Polls for failure conditions and EXITS the instant one trips, so the agent's
# harness fires a completion notification and the agent can respond immediately
# (instead of waiting for the next heartbeat). Pairs with qdrant-watchdog.sh
# (which auto-recovers Qdrant); this one pulls a human/agent in for anything.
#
# Trips on ANY of:
#   - Qdrant `crosmos-memories` collection status == red (silent data killer)
#   - failed ingestion_jobs jump by >= FAIL_SPIKE within one poll interval
#   - hono log shows a fresh /conversations 500 or a QdrantRequestError
#
# Run in the background; when it exits, read /tmp/bench-alert.log for the reason.
set -uo pipefail

QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
QDRANT_API_KEY="${QDRANT_API_KEY:-local-dev-key}"
PG_CONTAINER="${PG_CONTAINER:-crosmos-dev-pg}"
HONO_LOG="${HONO_LOG:-/tmp/crosmos-dev.log}"
POLL_SECONDS="${POLL_SECONDS:-15}"
FAIL_SPIKE="${FAIL_SPIKE:-3}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
fail_count() {
  docker exec "$PG_CONTAINER" psql -U crosmos -d crosmos -tAc \
    "select count(*) from ingestion_jobs where status='failed';" 2>/dev/null | tr -d '[:space:]'
}
qstatus() {
  curl -s --max-time 6 -H "api-key: ${QDRANT_API_KEY}" \
    "${QDRANT_URL}/collections/crosmos-memories" 2>/dev/null \
    | bun -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(0)).result?.status??"unknown"))}catch{process.stdout.write("unreachable")}' 2>/dev/null
}

trip() { echo "[$(ts)] 🚨 TRIPWIRE: $1"; exit 1; }

prev_fail="$(fail_count)"; [ -z "$prev_fail" ] && prev_fail=0
log_lines="$(wc -l < "$HONO_LOG" 2>/dev/null || echo 0)"
echo "[$(ts)] tripwire armed — baseline failed=$prev_fail, poll=${POLL_SECONDS}s, spike>=${FAIL_SPIKE}"

while true; do
  sleep "$POLL_SECONDS"

  s="$(qstatus)"
  [ "$s" = "red" ] && trip "Qdrant crosmos-memories is RED (vector writes failing)"

  cur_fail="$(fail_count)"; [ -z "$cur_fail" ] && cur_fail="$prev_fail"
  delta=$(( cur_fail - prev_fail ))
  if [ "$delta" -ge "$FAIL_SPIKE" ]; then
    trip "ingestion failures spiked +${delta} (now ${cur_fail}) in ${POLL_SECONDS}s"
  fi
  prev_fail="$cur_fail"

  # new hono log lines since last poll → scan for 500s / Qdrant errors
  new_total="$(wc -l < "$HONO_LOG" 2>/dev/null || echo 0)"
  if [ "$new_total" -gt "$log_lines" ]; then
    fresh="$(tail -n $(( new_total - log_lines )) "$HONO_LOG" 2>/dev/null)"
    if echo "$fresh" | grep -qE "POST /api/v1/conversations 500|QdrantRequestError|source_failed"; then
      trip "$(echo "$fresh" | grep -oE "POST /api/v1/conversations 500|QdrantRequestError|source_failed" | sort | uniq -c | tr '\n' ' ')"
    fi
    log_lines="$new_total"
  fi
done
