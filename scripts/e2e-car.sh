#!/usr/bin/env bash
# 차량 앱 E2E(Maestro + 서버 검증): debug 앱을 설치하고 서버를 띄운 뒤 flow를 돌리고, 서버에 저장된 트립을 검증한다.
# 사용: pnpm e2e:car   (Pleos 에뮬레이터 emulator-5554만 쓴다. 꺼져 있으면 실행 전에 띄워 두세요)
# flow 3개를 순서대로 돈다: 주행 기록(trip-recording, GPX e2e-north) → 도로 색칠(road-coloring, GPX e2e-sejong) → 시군구 색칠(region-coloring, GPX e2e-junggu 2회). 도로 색칠은 실제 Valhalla(nubi-valhalla, 포트 8002)를 쓴다.
# 환경 변수: E2E_OUT은 산출물 루트(기본 e2e/output/car), PORT는 서버 포트(기본 8787), VALHALLA_PORT는 Valhalla 포트(기본 8002),
#            NUBI_REGIONS_DB는 지역(시군구) DB(기본 server/data/regions/regions.sqlite, 없으면 테스트 픽스처를 명시해 넘김),
#            NUBI_ROADS_DB는 도로 DB(기본: server/data/roads-*.sqlite 중 최신, 없으면 server/test/fixtures/roads-test.sqlite를 이 스크립트가 **명시**해 서버에 넘긴다. 서버 자체는 조용히 대체하지 않는다).
# 실행마다 $E2E_OUT/<시각>/ 폴더를 새로 만들고 스크린샷(shots/)과 로그는 그 안에만 둔다.
# 앞 실행의 앱 데이터(미종료 트립·큐·저장된 차량 ID)가 남지 않도록 설치 뒤 pm clear 한다.
# Maestro flow가 실패해도 1회차 트립(GPX 점 수·좌표 일치)이 서버에 생겼으면 **재시도하지 않고 실패로 끝낸다**(화면 단언 실패를 가리지 않는다).
# 트립이 아예 없을 때(Maestro 드라이버 중단 등)만 flow 단위로 1회 재시도하고, 그 경우 통과 출력과 summary.json에 retried=<flow>를 남긴다(시도별 출력·logcat 보존).
# "2회 연속 통과" 기준은 retried가 없는 통과만 인정한다.
# 검증 대상 트립은 트립 수가 아니라 이번 실행 GPX의 점 수·첫/끝 좌표로 고른다(verify-trip.mjs --pick).
set -euo pipefail
# 백그라운드로 띄운 서버가 자기 프로세스 그룹을 갖도록 job control을 켠다(그룹 전체를 한 번에 종료하려고 쓴다)
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
VALHALLA_PORT="${VALHALLA_PORT:-8002}"
SERIAL="emulator-5554"
export ANDROID_SERIAL="$SERIAL"
RUN_DIR="${E2E_OUT:-$ROOT/e2e/output/car}/$(date +%Y%m%d-%H%M%S)"
SHOTS="$RUN_DIR/shots"
MAESTRO="${MAESTRO_BIN:-$(command -v maestro || echo "$HOME/.maestro/bin/maestro")}"
APP_ID="com.nubi.car"
APP_USER=10 # Pleos 에뮬레이터는 앱이 사용자 10에서 돈다
ADB=(adb -s "$SERIAL")

if [ ! -x "$MAESTRO" ]; then
  echo "maestro가 없습니다. 설치: curl -Ls https://get.maestro.mobile.dev | bash" >&2
  exit 1
fi
if [ "$("${ADB[@]}" get-state 2>/dev/null || true)" != "device" ]; then
  echo "$SERIAL 이 없습니다. 먼저 띄우세요: ~/Library/Android/sdk/emulator/emulator -avd Pleos_Connect_v2_1 -no-snapshot-save" >&2
  exit 1
fi
if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "포트 $PORT 를 이미 쓰고 있습니다. 서버를 내리고 다시 실행하세요." >&2
  exit 1
fi

# 도로 DB: 전국이 있으면 그것, 없으면 테스트 DB를 명시해 넘기지만 verify-trip이 전국이 아니면 도로 색칠 검증에서 중단한다(사양 02 8장)
if [ -z "${NUBI_ROADS_DB:-}" ]; then
  NUBI_ROADS_DB="$(ls -1 "$ROOT"/server/data/roads-*.sqlite 2>/dev/null | sort | tail -1 || true)"
  [ -n "$NUBI_ROADS_DB" ] || NUBI_ROADS_DB="$ROOT/server/test/fixtures/roads-test.sqlite"
fi
export NUBI_ROADS_DB
# 지역(시군구) DB: 전국이 있으면 그것, 없으면 테스트 픽스처를 명시해 넘긴다. 도감 분모(229) 단언은 전국 DB가 아니면 verify-trip이 중단한다.
if [ -z "${NUBI_REGIONS_DB:-}" ]; then
  NUBI_REGIONS_DB="$ROOT/server/data/regions/regions.sqlite"
  [ -f "$NUBI_REGIONS_DB" ] || NUBI_REGIONS_DB="$ROOT/server/test/fixtures/regions-test.sqlite"
fi
export NUBI_REGIONS_DB
echo "== Valhalla 확인 (포트 $VALHALLA_PORT), 도로 DB: $NUBI_ROADS_DB, 지역 DB: $NUBI_REGIONS_DB"
VALHALLA_PORT="$VALHALLA_PORT" bash "$ROOT/scripts/valhalla-up.sh"
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VALHALLA_PORT/status" || true)" = "200" ] && break
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VALHALLA_PORT/status" || true)" = "200" ] || { echo "Valhalla /status가 200이 아닙니다." >&2; exit 1; }

SERVER_PGID=""
stop_server() {
  [ -n "$SERVER_PGID" ] || return 0
  kill -TERM -- "-$SERVER_PGID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 -- "-$SERVER_PGID" 2>/dev/null || break
    sleep 0.25
  done
  kill -KILL -- "-$SERVER_PGID" 2>/dev/null || true
  wait "$SERVER_PGID" 2>/dev/null || true
  SERVER_PGID=""
}

cleanup() {
  # Maestro가 테스트 출력 폴더 깊은 곳에 두는 이번 실행의 스크린샷을 $SHOTS 로 모은다
  mkdir -p "$SHOTS"
  find "$RUN_DIR/maestro" -path '*takeScreenshot*' -name '*.png' -exec cp {} "$SHOTS/" \; 2>/dev/null || true
  stop_server
}
trap cleanup EXIT

echo "== debug 앱 설치"
(cd "$ROOT/car" && ./gradlew :app:installDebug -q -Pnubi.serverPort="$PORT")

echo "== 앱 데이터 초기화(사용자 $APP_USER): 앞 실행이 남긴 미종료 트립·큐·차량 ID 제거"
"${ADB[@]}" shell pm clear --user "$APP_USER" "$APP_ID"

echo "== 권한 사전 부여(사용자 $APP_USER)"
for perm in pleos.car.permission.FUSED_LOCATION android.permission.ACCESS_COARSE_LOCATION; do
  "${ADB[@]}" shell pm grant --user "$APP_USER" "$APP_ID" "$perm" || echo "경고: $perm 부여 실패" >&2
done
# 새 권한이 적용되도록 프로세스를 새로 시작한다
"${ADB[@]}" shell am force-stop "$APP_ID"

# 차량 ID 발급용 서버 비밀키(E2E 전용 값). VIN을 보내면 이 키로 HMAC한 ID를 돌려받는다
HMAC_KEY="e2e-vehicle-hmac-key"
PROBE_VIN="E2EPROBEVIN0001"
# 앱에 주입하는 VIN(debug 전용 vin= 신호). pm clear 뒤에도 서버가 발급한 차량 ID를 쓰게 한다. verify-trip이 HMAC(키, 이 VIN)과 트립의 vehicleId가 같은지 본다
APP_VIN="E2EAPPVIN0000001"
echo "== 서버 시작 (포트 $PORT, 메모리 DB)"
mkdir -p "$RUN_DIR"
# watch 없이 한 번만 띄운다. 서브셸이 곧 프로세스 그룹 리더라 그룹 전체(tsx와 자식 node)를 함께 종료한다.
(cd "$ROOT/server" && NUBI_DB=:memory: NUBI_VEHICLE_HMAC_KEY="$HMAC_KEY" PORT="$PORT" NUBI_VALHALLA_URL="http://127.0.0.1:$VALHALLA_PORT" NUBI_ROADS_DB="$NUBI_ROADS_DB" NUBI_REGIONS_DB="$NUBI_REGIONS_DB" exec ./node_modules/.bin/tsx src/index.ts >"$RUN_DIR/server.log" 2>&1) &
SERVER_PGID=$!
for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null || { echo "서버가 뜨지 않았습니다. $RUN_DIR/server.log 를 확인하세요." >&2; exit 1; }

BASE_URL="http://127.0.0.1:$PORT"
LOGTAGS=(NubiLoc NubiTrip NubiVehicle NubiCarSignals NubiService NubiDebug NubiUpload NubiVehicleId NubiCipher NubiCoverage AndroidRuntime)

RETRIED=()
# flow 하나를 돌린다. 인자: <이름> <flow yaml> <GPX> <점 수>
# 실패하면 1회차 트립이 서버에 있는지 본다: 있으면 재시도 없이 실패, 없으면 1회만 다시 돈다(RETRIED에 기록).
run_flow() {
  local name="$1" yaml="$2" gpx="$3" npts="$4" attempt rc=1 out plus6 seen
  for attempt in 1 2; do
    out="$RUN_DIR/maestro/$name"
    [ "$attempt" -eq 1 ] || out="$RUN_DIR/maestro/$name-attempt$attempt"
    # 기어 P 5분 종료 조건을 시계로 건너뛰려고 flow 시작 직전의 "지금 + 6분"(epoch ms)을 넘긴다
    plus6=$(( $(date +%s) * 1000 + 6 * 60 * 1000 ))
    # 시군구 flow용 시각: +15분·+22분, 그리고 (flow 시작 + 30분)이 속한 KST 날짜의 다음 날 07:00·07:06(사이에 자정이 반드시 들어가게)
    local plus15 plus22 next0700 next0706
    plus15=$(( $(date +%s) * 1000 + 15 * 60 * 1000 ))
    plus22=$(( $(date +%s) * 1000 + 22 * 60 * 1000 ))
    next0700="$(node -e 'const b=Date.now()+30*60000,k=new Date(b+9*3600000);console.log(Date.UTC(k.getUTCFullYear(),k.getUTCMonth(),k.getUTCDate()+1,7,0,0)-9*3600000)')"
    next0706=$(( next0700 + 6 * 60 * 1000 ))
    "${ADB[@]}" logcat -c || true
    set +e
    "$MAESTRO" test "$yaml" --device "$SERIAL" -e SHOT_DIR="$SHOTS" -e CLOCK_PLUS_6MIN="$plus6" -e CLOCK_PLUS_15MIN="$plus15" -e CLOCK_PLUS_22MIN="$plus22" -e CLOCK_NEXT_DAY_0700="$next0700" -e CLOCK_NEXT_DAY_0706="$next0706" -e APP_VIN="$APP_VIN" --test-output-dir "$out"
    rc=$?
    set -e
    "${ADB[@]}" logcat -d -s "${LOGTAGS[@]}" >"$RUN_DIR/app-logcat-$name-attempt$attempt.txt" 2>&1 || true
    [ "$rc" -eq 0 ] && return 0
    echo "Maestro($name) 시도 $attempt 실패(rc=$rc). 출력: $out, logcat: $RUN_DIR/app-logcat-$name-attempt$attempt.txt" >&2
    seen="$(node "$ROOT/scripts/verify-trip.mjs" --exists "$BASE_URL" "$gpx" 2>/dev/null || true)"
    if [ -n "$seen" ]; then
      echo "1회차 트립($seen, 점 ${npts}개)이 서버에 이미 있어 재시도하지 않습니다(화면 단언 실패를 가리지 않음)." >&2
      return "$rc"
    fi
    [ "$attempt" -eq 1 ] && RETRIED+=("$name")
  done
  return "$rc"
}

write_summary() {
  local retried="${RETRIED[*]:-}"
  printf '{"result":"pass","retried":"%s","runDir":"%s"}\n' "${retried// /,}" "$RUN_DIR" >"$RUN_DIR/summary.json"
  [ -z "$retried" ] || echo "retried=${retried// /,}  (재시도가 있었으므로 2회 연속 통과 기준에는 인정되지 않습니다)"
}

echo "== Maestro 실행: 주행 기록 (스크린샷: $SHOTS)"
cd "$ROOT"
run_flow trip-recording "e2e/maestro/car/trip-recording.yaml" "$ROOT/car/app/src/debug/assets/e2e-north.gpx" 30 || { echo "Maestro(주행 기록) 실패" >&2; exit 1; }

echo "== 서버 검증"
# 이번 실행의 e2e-north GPX(점 30개, 첫/끝 좌표 일치)와 맞는 종료된 트립을 찾는다. 종료 업로드가 끝날 때까지 잠시 기다린다
TRIP_ID="$(node "$ROOT/scripts/verify-trip.mjs" --pick "$BASE_URL" "$ROOT/car/app/src/debug/assets/e2e-north.gpx" 30)"
curl -fs "$BASE_URL/trips?limit=200" >"$RUN_DIR/trips.json" || true
[ -n "$TRIP_ID" ] || { echo "이번 실행의 e2e-north 트립(점 30개·좌표 일치·종료됨)이 서버에 없습니다. $RUN_DIR/trips.json 을 확인하세요." >&2; exit 1; }
curl -fs "$BASE_URL/trips/$TRIP_ID" >"$RUN_DIR/trip-detail.json"
# 차량 ID 발급 API: 탐침 VIN을 직접 등록해 응답을 남긴다(앱이 쓴 VIN과는 별개). 서버가 VIN을 저장·응답하지 않는지 verify-trip이 확인한다
curl -fs -X POST -H 'content-type: application/json' -d "{\"vin\":\"$PROBE_VIN\"}" "$BASE_URL/vehicles/register" >"$RUN_DIR/register.json"
curl -fs "$BASE_URL/trips?limit=200" >"$RUN_DIR/trips-after-register.json"
NUBI_VEHICLE_HMAC_KEY="$HMAC_KEY" E2E_PROBE_VIN="$PROBE_VIN" E2E_APP_VIN="$APP_VIN" node "$ROOT/scripts/verify-trip.mjs" "$RUN_DIR/trip-detail.json" "$ROOT/car/app/src/debug/assets/e2e-north.gpx" "$RUN_DIR/trips-after-register.json" "$ROOT/server/src/db/schema.ts" "$RUN_DIR/register.json"
echo "== 주행 기록 통과"

echo "== Maestro 실행: 도로 색칠 (스크린샷: $SHOTS)"
run_flow road-coloring "e2e/maestro/car/road-coloring.yaml" "$ROOT/car/app/src/debug/assets/e2e-sejong.gpx" 60 || { echo "Maestro(도로 색칠) 실패" >&2; exit 1; }

echo "== 서버 검증: 도로 색칠"
E2E_BASE_URL="$BASE_URL" node "$ROOT/scripts/verify-trip.mjs" --road-coloring "$ROOT/car/app/src/debug/assets/e2e-north.gpx" "$ROOT/car/app/src/debug/assets/e2e-sejong.gpx" | tee "$RUN_DIR/road-coloring-verify.txt"
curl -fs "$BASE_URL/trips?limit=200" >"$RUN_DIR/trips-final.json" || true
echo "== Maestro 실행: 시군구 색칠 (스크린샷: $SHOTS)"
run_flow region-coloring "e2e/maestro/car/region-coloring.yaml" "$ROOT/car/app/src/debug/assets/e2e-junggu.gpx" 12 || { echo "Maestro(시군구 색칠) 실패" >&2; exit 1; }

echo "== 서버 검증: 시군구 색칠"
E2E_BASE_URL="$BASE_URL" node "$ROOT/scripts/verify-trip.mjs" --regions "$ROOT/car/app/src/debug/assets/e2e-sejong.gpx" "$ROOT/car/app/src/debug/assets/e2e-junggu.gpx" | tee "$RUN_DIR/region-coloring-verify.txt"
write_summary
echo "== 통과. 산출물: $RUN_DIR"
