#!/usr/bin/env bash
# Valhalla 최초 구축(멱등): Colima 기동 → 이미지 받기 → pbf 확인/다운로드 → 타일 빌드 → 컨테이너 기동 → /status 대기.
# 이미 타일이 있으면 빌드는 건너뛴다. 강제 재빌드: FORCE_REBUILD=True scripts/setup-valhalla.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ghcr.io/gis-ops/docker-valhalla/valhalla:3.5.1" # arm64 포함 멀티아크 태그, latest 금지
NAME="nubi-valhalla"
PORT="${VALHALLA_PORT:-8002}"
PBF_URL="https://download.geofabrik.de/asia/south-korea-latest.osm.pbf"
OSM_DIR="$ROOT/server/data/osm"
TILE_DIR="$ROOT/server/data/valhalla"
PBF="$OSM_DIR/south-korea-latest.osm.pbf"
FORCE_REBUILD="${FORCE_REBUILD:-False}"

if ! docker info >/dev/null 2>&1; then
  echo "== Colima 기동"
  colima start --cpu 4 --memory 6 --disk 40
fi

echo "== 이미지 확인: $IMAGE"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"

mkdir -p "$OSM_DIR" "$TILE_DIR"
if [ ! -s "$PBF" ]; then
  echo "== pbf 다운로드"
  curl -fL --retry 3 -o "$PBF.part" "$PBF_URL"
  mv "$PBF.part" "$PBF"
fi
# 컨테이너는 /custom_files 의 *.pbf 를 읽는다. 같은 파일시스템이라 하드링크로 공간을 쓰지 않는다.
[ -e "$TILE_DIR/south-korea-latest.osm.pbf" ] || ln "$PBF" "$TILE_DIR/south-korea-latest.osm.pbf"

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  if [ "$FORCE_REBUILD" = "True" ]; then docker rm -f "$NAME" >/dev/null; else
    echo "== 기존 컨테이너 재사용(없애려면 docker rm -f $NAME)"
    docker start "$NAME" >/dev/null
  fi
fi
if ! docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "== 컨테이너 생성(타일이 없으면 빌드가 먼저 돈다. 한국 전체는 수십 분)"
  docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:8002" \
    -v "$TILE_DIR:/custom_files" \
    -e tile_urls= -e build_elevation=False -e build_admins=True -e build_time_zones=False \
    -e serve_tiles=True -e use_tiles_ignore_pbf=True -e force_rebuild="$FORCE_REBUILD" \
    -e server_threads=4 \
    "$IMAGE" >/dev/null
fi

echo "== /status 대기(최대 2시간)"
for _ in $(seq 1 1440); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/status" || true)" = "200" ]; then
    echo "Valhalla 준비 완료: http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 5
done
echo "Valhalla가 시간 안에 뜨지 않았습니다. docker logs $NAME 확인" >&2
exit 1
