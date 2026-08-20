#!/usr/bin/env bash
set -euo pipefail

network="canvasplanet-release-smoke"
database_container="canvasplanet-release-smoke-db"
app_container="canvasplanet-release-smoke-app"
database_volume="canvasplanet-release-smoke-pgdata"
password="canvasplanet_release_smoke_only"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  docker rm -f "${app_container}" "${database_container}" >/dev/null 2>&1 || true
  docker volume rm "${database_volume}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "${network}" >/dev/null
docker volume create "${database_volume}" >/dev/null
docker run --detach \
  --name "${database_container}" \
  --network "${network}" \
  --network-alias db \
  --publish 15432:5432 \
  --env POSTGRES_USER=canvasplanet \
  --env POSTGRES_PASSWORD="${password}" \
  --env POSTGRES_DB=canvasplanet \
  --volume "${database_volume}:/var/lib/postgresql/data" \
  postgres:16-alpine >/dev/null

for _ in $(seq 1 60); do
  if docker exec "${database_container}" pg_isready -U canvasplanet -d canvasplanet >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "${database_container}" pg_isready -U canvasplanet -d canvasplanet >/dev/null

docker run --detach \
  --name "${app_container}" \
  --network "${network}" \
  --publish 18080:8080 \
  --env NODE_ENV=production \
  --env PORT=8080 \
  --env PUBLIC_URL=http://localhost:18080 \
  --env DATABASE_URL="postgres://canvasplanet:${password}@db:5432/canvasplanet" \
  --env SESSION_SECRET="${password}" \
  --env TRUST_CF_CONNECTING_IP=false \
  --env TURNSTILE_ENABLED=false \
  --env DISCORD_CLIENT_ID=1234567890 \
  --env DISCORD_CLIENT_SECRET=release-smoke-only \
  --env TILE_CACHE_DIR=/var/tilecache \
  --env EXPORT_OUTPUT_DIR=/var/exports \
  --env GEO_INDEX_PATH=/app/data/geo-index.bin \
  --env BASEMAP_DIR=/app/data/basemap-tiles \
  --mount type=bind,source="${repo_root}/data",target=/app/data,readonly \
  --tmpfs /var/tilecache:rw,mode=1777 \
  --tmpfs /var/exports:rw,mode=1777 \
  canvasplanet:release >/dev/null

for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:18080/api/status >/dev/null; then
    echo "[smoke] release image started, migrated an empty database, and passed HTTP health"
    if [[ "${KEEP_CONTAINERS:-false}" == "true" ]]; then
      trap - EXIT
      echo "[smoke] disposable containers left running for external verification"
    fi
    exit 0
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${app_container}")" != "true" ]]; then
    docker logs "${app_container}"
    exit 1
  fi
  sleep 1
done

docker logs "${app_container}"
echo "[smoke] release image did not become healthy within 60 seconds" >&2
exit 1
