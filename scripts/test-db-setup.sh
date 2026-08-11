#!/usr/bin/env bash
#
# Build the local `crosmos_test` database used by the retrieval differential
# tests (apps/api/tests/*.pg.test.ts).
#
# It is deliberately a SEPARATE database from the `crosmos` dev database:
#   - the tests TRUNCATE, so they must never be pointed at a working dev DB;
#   - the dev DB carries the pre-baseline drizzle journal, so `drizzle-kit
#     migrate` cannot bring it to the current schema without a reset.
#
# The schema is built by applying packages/db/migrations in order, which is the
# same SQL that defines staging/production. Re-runnable: it drops and recreates.
#
#   docker compose up -d postgres
#   bash scripts/test-db-setup.sh
#
set -euo pipefail

HOST="${TEST_PGHOST:-localhost}"
PORT="${TEST_PGPORT:-5433}"
USER="${TEST_PGUSER:-crosmos}"
DB="${TEST_PGDATABASE:-crosmos_test}"
export PGPASSWORD="${TEST_PGPASSWORD:-crosmos}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql -h "$HOST" -p "$PORT" -U "$USER" -d postgres -q \
  -c "DROP DATABASE IF EXISTS $DB" \
  -c "CREATE DATABASE $DB"

# Suppress per-statement NOTICEs at the DATABASE level. `truncate ... cascade`
# in the test reset emits one per cascaded table, and postgres.js prints each as
# a structured object — dozens of lines per test, burying the assertions. Setting
# it on the connection only covers ONE pooled connection, so set it here.
psql -h "$HOST" -p "$PORT" -U "$USER" -d postgres -q \
  -c "ALTER DATABASE $DB SET client_min_messages = warning"

# pgvector must exist before the baseline, which declares `vector(1024)` columns.
psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -q \
  -c "CREATE EXTENSION IF NOT EXISTS vector"

for file in "$ROOT"/packages/db/migrations/*.sql; do
  echo "applying $(basename "$file")"
  psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -q -v ON_ERROR_STOP=1 -f "$file"
done

tables=$(psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
echo "ready: $DB has $tables tables"
