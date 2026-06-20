#!/usr/bin/env bash
# Bring up the local benchmark stack: Postgres+pgvector, then apply migrations.
#
# After this finishes, run BOTH workers with one command from the repo root:
#   bun run dev                           # api :8787 + ingestion :8788
# (or individually: `bun --filter @crosmos/api dev` / `... @crosmos/ingestion dev`)
#
# See docs/local-development.md for the full runbook (provider config, keys).
set -euo pipefail

# Direct connection to the docker Postgres (NOT Hyperdrive) — used by drizzle-kit.
LOCAL_DB_URL="${LOCAL_DB_URL:-postgresql://crosmos:crosmos@localhost:5433/crosmos}"

# Resolve repo root from this script's location so it runs from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Starting Postgres (pgvector) via docker compose"
docker compose up -d postgres

echo "==> Waiting for Postgres to report healthy"
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' crosmos-dev-pg 2>/dev/null || echo unknown)"
  if [ "$status" = "healthy" ]; then
    echo "    Postgres is healthy"
    break
  fi
  sleep 2
done
if [ "${status:-}" != "healthy" ]; then
  echo "!! Postgres did not become healthy in time. Check: docker compose logs postgres" >&2
  exit 1
fi

echo "==> Applying Drizzle migrations (creates the vector extension + schema)"
DATABASE_URL="$LOCAL_DB_URL" bun run db:migrate

echo "==> Verifying pgvector extension is installed"
docker exec crosmos-dev-pg psql -U crosmos -d crosmos -tAc \
  "select extname from pg_extension where extname = 'vector';" | grep -q vector \
  && echo "    vector extension present" \
  || { echo "!! vector extension missing" >&2; exit 1; }

echo ""
echo "Local stack ready. Set OPENROUTER_API_KEY in apps/*/.dev.vars, then start both workers:"
echo "  bun run dev          # api :8787 + ingestion :8788, one terminal"
