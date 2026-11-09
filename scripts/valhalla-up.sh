#!/usr/bin/env bash
# 이미 빌드된 타일로 Valhalla만 기동한다(이미 떠 있으면 그대로). 타일이 없으면 setup-valhalla.sh 를 안내한다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ghcr.io/gis-ops/docker-valhalla/valhalla:3.5.1"
NAME="nubi-valhalla"
PORT="${VALHALLA_PORT:-8002}"
TILE_DIR="$ROOT/server/data/valhalla"

status() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/status" 2>/dev/null || true; }

if [ "$(status)" = "200" ]; then echo "Valhalla 이미 실행 중"; exit 0; fi

if [ ! -d "$TILE_DIR/valhalla_tiles" ] && [ ! -f "$TILE_DIR/valhalla_tiles.tar" ]; then
  echo "타일이 없습니다. 먼저 scripts/setup-valhalla.sh 를 실행하세요." >&2
  exit 1
fi
docker info >/dev/null 2>&1 || colima start --cpu 4 --memory 6 --disk 40

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker start "$NAME" >/dev/null
else
  docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:8002" \
    -v "$TILE_DIR:/custom_files" \
    -e tile_urls= -e build_elevation=False -e build_admins=True -e build_time_zones=False \
    -e serve_tiles=True -e use_tiles_ignore_pbf=True -e force_rebuild=False \
    -e server_threads=4 "$IMAGE" >/dev/null
fi
for _ in $(seq 1 120); do
  [ "$(status)" = "200" ] && { echo "Valhalla 준비 완료"; exit 0; }
  sleep 2
done
echo "Valhalla가 뜨지 않았습니다. docker logs $NAME 확인" >&2
exit 1
