#!/usr/bin/env bash
# Nightly dump + retention.
#
# The canvas never resets, so losing the database loses everything the
# entire app has ever produced, permanently (see ROADMAP.md §3.2). This is
# the single highest-consequence gap this script closes.
#
# Cron, from the repo root on the VPS:
#   0 3 * * * cd /opt/worldcanvas && ./scripts/backup.sh >> backups/backup.log 2>&1
#
# Retention: every dump from the last 7 days, plus the Sunday dump for the
# last 4 weeks, plus the 1st-of-month dump for the last 12 months. Anything
# outside all three windows is pruned. One dump/day, so cron running more
# than once a day is harmless — it just no-ops after the first.
#
# Requires GNU date (coreutils) for `date -d`, which is the default on
# Debian/Ubuntu (the assumed VPS target — see docker-compose.yml) and is
# also what Git Bash on Windows ships, so this runs unmodified in dev.
#
# Two ways to reach Postgres, auto-selected:
#   - docker compose is running (VPS/prod)   -> dump from inside the db container
#   - otherwise, DATABASE_URL + local pg_dump on PATH (dev, e.g. .pgdev)
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
[ -f .env ] && source .env
set +a

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d)"
OUT="$BACKUP_DIR/worldcanvas-$STAMP.sql.gz"

use_docker=0
if command -v docker >/dev/null 2>&1 && docker compose ps db >/dev/null 2>&1; then
  use_docker=1
fi

if [ -f "$OUT" ]; then
  echo "[backup] $OUT already exists — one dump per day, skipping the dump step"
elif [ "$use_docker" -eq 1 ]; then
  : "${POSTGRES_USER:?POSTGRES_USER not set — check .env}"
  : "${POSTGRES_DB:?POSTGRES_DB not set — check .env}"
  echo "[backup] docker compose detected — dumping $POSTGRES_DB -> $OUT"
  docker compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$OUT.tmp"
  mv "$OUT.tmp" "$OUT"
  echo "[backup] wrote $(du -h "$OUT" | cut -f1)"
else
  : "${DATABASE_URL:?Neither docker compose nor DATABASE_URL is available — check .env}"
  command -v pg_dump >/dev/null 2>&1 || { echo "[backup] pg_dump not on PATH and docker compose is not running — nothing to dump with" >&2; exit 1; }
  echo "[backup] no docker compose — dumping via local pg_dump against DATABASE_URL -> $OUT"
  # -d rather than a positional connection string: this shell's getopt stops
  # parsing options once it hits a bare positional argument, so a URL given
  # positionally silently swallows every flag that follows it.
  pg_dump -d "$DATABASE_URL" | gzip > "$OUT.tmp"
  mv "$OUT.tmp" "$OUT"
  echo "[backup] wrote $(du -h "$OUT" | cut -f1)"
fi

# ---- off-box copy ---------------------------------------------------------
# A dump that lives only on the box it protects against is not a backup of
# that box. BACKUP_REMOTE is any rclone-style destination (an rclone remote,
# or a plain path rclone can reach — e.g. S3, B2, another host over sftp).
# Deliberately optional rather than required: an unconfigured install should
# still get local dumps and a loud warning, not a hard failure on every run.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[backup] copying to $BACKUP_REMOTE"
    rclone copy "$OUT" "$BACKUP_REMOTE" || echo "[backup] WARNING: off-box copy failed — this dump is local-only"
  else
    echo "[backup] WARNING: BACKUP_REMOTE is set but rclone is not installed — dump is local-only"
  fi
else
  echo "[backup] WARNING: BACKUP_REMOTE is not set — this dump lives only on this box"
fi

# ---- retention --------------------------------------------------------
echo "[backup] pruning old dumps in $BACKUP_DIR"
for f in "$BACKUP_DIR"/worldcanvas-*.sql.gz; do
  [ -f "$f" ] || continue
  base="$(basename "$f" .sql.gz)"
  d="${base#worldcanvas-}" # YYYYMMDD

  file_epoch="$(date -d "$d" +%s 2>/dev/null)" || { echo "[backup] skipping unparseable name: $f"; continue; }
  age_days=$(( ( $(date +%s) - file_epoch ) / 86400 ))
  dow="$(date -d "$d" +%u)" # 1=Mon .. 7=Sun
  dom="$(date -d "$d" +%d)" # 01..31

  keep=0
  [ "$age_days" -le 7 ] && keep=1
  { [ "$age_days" -le 28 ] && [ "$dow" = "7" ]; } && keep=1
  { [ "$age_days" -le 365 ] && [ "$dom" = "01" ]; } && keep=1

  if [ "$keep" -eq 0 ]; then
    echo "[backup] removing $f (age ${age_days}d, not a retained daily/weekly/monthly)"
    rm -f "$f"
  fi
done

echo "[backup] done"
