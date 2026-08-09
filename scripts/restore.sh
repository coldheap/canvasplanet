#!/usr/bin/env bash
# Restore the database from a dump made by backup.sh.
#
#   ./scripts/restore.sh backups/worldcanvas-20260101.sql.gz
#
# This DROPS the current database and reloads it from the file. There is no
# undo — that is why it asks you to type the database name back before
# touching anything. Run this at least once against a throwaway copy before
# you ever need it for real; a restore procedure nobody has exercised is a
# guess, not a plan (see ROADMAP.md §3.2).
#
# Same auto-detection as backup.sh: docker compose if it's running (VPS/prod),
# otherwise local psql against DATABASE_URL (dev, e.g. .pgdev).
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
[ -f .env ] && source .env
set +a

FILE="${1:?Usage: $0 <path-to-backup.sql.gz>}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }

use_docker=0
if command -v docker >/dev/null 2>&1 && docker compose ps db >/dev/null 2>&1; then
  use_docker=1
fi

if [ "$use_docker" -eq 1 ]; then
  : "${POSTGRES_USER:?POSTGRES_USER not set — check .env}"
  : "${POSTGRES_DB:?POSTGRES_DB not set — check .env}"
  TARGET_DB="$POSTGRES_DB"
else
  : "${DATABASE_URL:?Neither docker compose nor DATABASE_URL is available — check .env}"
  command -v psql >/dev/null 2>&1 || { echo "psql not on PATH and docker compose is not running — nothing to restore with" >&2; exit 1; }
  # postgres://user:pass@host:port/dbname -> pieces, so we can connect to the
  # `postgres` maintenance database to DROP/CREATE the target (can't drop a
  # database you're connected to).
  _rest="${DATABASE_URL#*://}"
  _userinfo="${_rest%%@*}"
  _hostport="${_rest#*@}"
  _hostport="${_hostport%%/*}"
  TARGET_DB="${DATABASE_URL##*/}"
  TARGET_DB="${TARGET_DB%%\?*}"
  DB_USER="${_userinfo%%:*}"
  MAINT_URL="postgres://${_userinfo}@${_hostport}/postgres"
fi

echo "This will DROP and recreate the '$TARGET_DB' database from:"
echo "  $FILE"
echo "Every pixel, session and staff account not in that dump is gone after this."
read -r -p "Type the database name to confirm: " confirm
if [ "$confirm" != "$TARGET_DB" ]; then
  echo "Names did not match — aborted, nothing was touched."
  exit 1
fi

if [ "$use_docker" -eq 1 ]; then
  echo "[restore] stopping the app so nothing writes during the restore"
  docker compose stop app

  echo "[restore] dropping and recreating $TARGET_DB"
  docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";"
  docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$TARGET_DB\" OWNER \"$POSTGRES_USER\";"

  echo "[restore] loading $FILE"
  gunzip -c "$FILE" | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$TARGET_DB"
else
  echo "[restore] no docker compose — if a dev server is pointed at this database, stop it now"
  echo "[restore] terminating other connections to $TARGET_DB so DROP can proceed"
  # -d rather than a positional connection string throughout: this shell's
  # getopt stops parsing options once it hits a bare positional argument, so
  # a URL given positionally silently swallows every flag after it.
  psql -d "$MAINT_URL" -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB' AND pid <> pg_backend_pid();" >/dev/null
  echo "[restore] dropping and recreating $TARGET_DB"
  psql -d "$MAINT_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";"
  psql -d "$MAINT_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET_DB\" OWNER \"$DB_USER\";"

  echo "[restore] loading $FILE"
  gunzip -c "$FILE" | psql -d "$DATABASE_URL" -v ON_ERROR_STOP=1
fi

# Derived state, safe to blow away: it rebuilds from `pixels` as tiles are
# requested. Restoring it too would mean it disagreed with the just-restored
# canvas until every tile happened to be repainted or the worker caught up.
echo "[restore] clearing the tile cache (it will rebuild from the restored data)"
rm -rf ./tilecache/*

if [ "$use_docker" -eq 1 ]; then
  echo "[restore] starting the app back up"
  docker compose start app
fi

echo "[restore] done. Load the site and spot-check a few known pixels."
