#!/usr/bin/env bash
# Safe resume after a laptop restart / shutdown.
#
# Completed ingestion survives a shutdown (Postgres + Qdrant Docker volumes +
# the benchmark's runs.db are all on disk). What does NOT survive cleanly: jobs
# that were mid-extraction when the machine went down — they stay 'processing'
# with no worker, and would (a) block the ingestion pending-cap and (b) never
# complete. This script brings the data services back up and clears those
# stranded jobs so a resumed run isn't wedged. The few corpora that were
# mid-extraction get re-ingested by the run (reuse skips everything already done).
#
# Usage (after a reboot):
#   bash scripts/bench-resume.sh
#   bun run dev                                  # then start hono (separate terminal)
#   cd ../benchmark && source ../hono-crosmos/.bench.env \
#     && bun cli/index.ts ui --profile local-hono --port 4321
#   # then open localhost:4321 and click Resume
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Killing any orphaned workerd (a dead 'bun run dev' can leave these,"
echo "    and they return 503 to everything)"
kill -9 $(pgrep workerd) 2>/dev/null || true

echo "==> Bringing Postgres + Qdrant back up (data volumes persist across reboot)"
docker compose up -d

echo "==> Waiting for Postgres"
for _ in $(seq 1 30); do
  docker exec crosmos-dev-pg pg_isready -U crosmos -d crosmos >/dev/null 2>&1 && break
  sleep 2
done

echo "==> Clearing stranded ingestion jobs (mid-extraction at shutdown -> orphaned)"
docker exec crosmos-dev-pg psql -U crosmos -d crosmos -c \
  "DELETE FROM ingestion_jobs WHERE status IN ('pending','processing');" || true
docker exec crosmos-dev-pg psql -U crosmos -d crosmos -c \
  "UPDATE sources SET extraction_status='failed' WHERE extraction_status IN ('pending','processing');" || true

active=$(docker exec crosmos-dev-pg psql -U crosmos -d crosmos -tAc \
  "select count(*) from ingestion_jobs where status in ('pending','processing');" 2>/dev/null || echo "?")
echo "    in-flight jobs now: ${active} (should be 0)"

echo ""
echo "Data services ready. Next:"
echo "  1) bun run dev                                              # hono workers"
echo "  2) cd ../benchmark && source ../hono-crosmos/.bench.env \\"
echo "       && bun cli/index.ts ui --profile local-hono --port 4321"
echo "  3) open http://localhost:4321  ->  click Resume on the run"
echo ""
echo "(A few corpora that were mid-extraction at shutdown will re-ingest;"
echo " everything already completed is reused, so no big progress is lost.)"
