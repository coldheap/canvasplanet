#!/usr/bin/env bash
# Restores a dump into a disposable database and checks the migration ledger.
# The production database is never modified; only CREATE/DROP DATABASE run on
# its server. Intended for launch checks and periodic restore drills.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
[ -f .env ] && source .env
set +a

file="${1:?Usage: $0 <path-to-backup.sql.gz>}"
[ -f "$file" ] || { echo "[backup] file not found: $file" >&2; exit 1; }
: "${DATABASE_URL:?DATABASE_URL is required}"

name="cp_restore_verify_$(date +%Y%m%d_%H%M%S)"
test_url="${DATABASE_URL%/*}/$name"

cleanup() {
  psql -d "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$name\" WITH (FORCE)" >/dev/null
}
trap cleanup EXIT

psql -d "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$name\"" >/dev/null
gzip -dc "$file" | psql -d "$test_url" -v ON_ERROR_STOP=1 >/dev/null

applied="$(psql -d "$test_url" -tA -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM _migrations")"
expected="$(find packages/server/migrations -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
if [ "$applied" != "$expected" ]; then
  echo "[backup] restore has $applied migrations; expected $expected" >&2
  exit 1
fi

echo "[backup] restore verified in disposable database ($applied migrations)"
