#!/usr/bin/env bash
# One-command local benchmark setup: Postgres + Qdrant, migrations, collections,
# seed org + API key. Idempotent — safe to re-run.
#
# After this finishes:
#   bun run dev                 # api :8787 + ingestion :8788
#   source .bench.env           # exports CROSMOS_BENCH_API_KEY + OpenAI key
#   # then run the benchmark from ../benchmark
#
# See docs/local-development.md for the full runbook.
set -euo pipefail

LOCAL_DB_URL="${LOCAL_DB_URL:-postgresql://crosmos:crosmos@localhost:5433/crosmos}"
QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
QDRANT_API_KEY="${QDRANT_API_KEY:-local-dev-key}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Starting Postgres + Qdrant via docker compose"
docker compose up -d

echo "==> Waiting for Postgres to report healthy"
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' crosmos-dev-pg 2>/dev/null || echo unknown)"
  [ "$status" = "healthy" ] && { echo "    Postgres healthy"; break; }
  sleep 2
done
[ "${status:-}" = "healthy" ] || { echo "!! Postgres not healthy. docker compose logs postgres" >&2; exit 1; }

echo "==> Waiting for Qdrant to report ready"
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$QDRANT_URL/readyz" -H "api-key: $QDRANT_API_KEY" || echo 000)"
  [ "$code" = "200" ] && { echo "    Qdrant ready"; break; }
  sleep 2
done
[ "${code:-}" = "200" ] || { echo "!! Qdrant not ready. docker compose logs qdrant" >&2; exit 1; }

echo "==> Applying Drizzle migrations"
DATABASE_URL="$LOCAL_DB_URL" bun run db:migrate

echo "==> Bootstrapping Qdrant collections + benchmark org/key"
DATABASE_URL="$LOCAL_DB_URL" bun scripts/bench-bootstrap.ts

echo ""
echo "Local stack ready. Start both workers:  bun run dev"
