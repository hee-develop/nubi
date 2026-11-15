#!/usr/bin/env bash
# 차량 앱 E2E(Maestro + 서버 검증): debug 앱을 설치하고 서버를 띄운 뒤 flow를 돌리고, 서버에 저장된 트립을 검증한다.
# 사용: pnpm e2e:car   (Pleos 에뮬레이터 emulator-5554만 쓴다. 꺼져 있으면 실행 전에 띄워 두세요)
# 환경 변수: E2E_OUT은 산출물 루트(기본 e2e/output/car), PORT는 서버 포트(기본 8787).
# 실행마다 $E2E_OUT/<시각>/ 폴더를 새로 만들고 스크린샷(shots/)과 로그는 그 안에만 둔다.
set -euo pipefail
# 백그라운드로 띄운 서버가 자기 프로세스 그룹을 갖도록 job control을 켠다(그룹 전체를 한 번에 종료하려고 쓴다)
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
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

echo "== 권한 사전 부여(사용자 $APP_USER)"
for perm in pleos.car.permission.FUSED_LOCATION android.permission.ACCESS_COARSE_LOCATION; do
  "${ADB[@]}" shell pm grant --user "$APP_USER" "$APP_ID" "$perm" || echo "경고: $perm 부여 실패" >&2
done
# 새 권한이 적용되도록 프로세스를 새로 시작한다
"${ADB[@]}" shell am force-stop "$APP_ID"

# 차량 ID 발급용 서버 비밀키(E2E 전용 값). VIN을 보내면 이 키로 HMAC한 ID를 돌려받는다
HMAC_KEY="e2e-vehicle-hmac-key"
PROBE_VIN="E2EPROBEVIN0001"
echo "== 서버 시작 (포트 $PORT, 메모리 DB)"
mkdir -p "$RUN_DIR"
# watch 없이 한 번만 띄운다. 서브셸이 곧 프로세스 그룹 리더라 그룹 전체(tsx와 자식 node)를 함께 종료한다.
(cd "$ROOT/server" && NUBI_DB=:memory: NUBI_VEHICLE_HMAC_KEY="$HMAC_KEY" PORT="$PORT" exec ./node_modules/.bin/tsx src/index.ts >"$RUN_DIR/server.log" 2>&1) &
SERVER_PGID=$!
for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null || { echo "서버가 뜨지 않았습니다. $RUN_DIR/server.log 를 확인하세요." >&2; exit 1; }

echo "== Maestro 실행 (스크린샷: $SHOTS)"
cd "$ROOT"
# 6분 뒤 시각(epoch ms): 기어 P 5분 종료 조건을 시계로 건너뛴다
CLOCK_PLUS_6MIN=$(( $(date +%s) * 1000 + 6 * 60 * 1000 ))
"${ADB[@]}" logcat -c || true
set +e
"$MAESTRO" test "e2e/maestro/car/trip-recording.yaml" \
  --device "$SERIAL" \
  -e SHOT_DIR="$SHOTS" \
  -e CLOCK_PLUS_6MIN="$CLOCK_PLUS_6MIN" \
  --test-output-dir "$RUN_DIR/maestro/trip-recording"
MAESTRO_RC=$?
set -e
"${ADB[@]}" logcat -d -s NubiLoc NubiTrip NubiVehicle NubiCarSignals NubiService NubiDebug NubiUpload NubiVehicleId NubiCipher AndroidRuntime >"$RUN_DIR/app-logcat.txt" 2>&1 || true
[ "$MAESTRO_RC" -eq 0 ] || { echo "Maestro 실패(rc=$MAESTRO_RC)" >&2; exit "$MAESTRO_RC"; }

echo "== 서버 검증"
# 종료 업로드가 끝날 때까지 잠시 기다리며 트립을 찾는다
TRIP_ID=""
for _ in $(seq 1 30); do
  LIST="$(curl -fs "http://127.0.0.1:$PORT/trips?limit=10" || true)"
  TRIP_ID="$(node -e 'try{const t=JSON.parse(process.argv[1]).trips;process.stdout.write(t.length===1&&t[0].endedAt&&t[0].pointCount>=30?t[0].tripId:"")}catch{}' "${LIST:-}")"
  [ -n "$TRIP_ID" ] && break
  sleep 1
done
echo "${LIST:-}" >"$RUN_DIR/trips.json"
[ -n "$TRIP_ID" ] || { echo "종료된 트립(점 30개 이상)이 서버에 없습니다. $RUN_DIR/trips.json 을 확인하세요." >&2; exit 1; }
curl -fs "http://127.0.0.1:$PORT/trips/$TRIP_ID" >"$RUN_DIR/trip-detail.json"
# 차량 ID 발급 API: 탐침 VIN을 직접 등록해 응답을 남긴다(앱이 쓴 VIN과는 별개). 서버가 VIN을 저장·응답하지 않는지 verify-trip이 확인한다
curl -fs -X POST -H 'content-type: application/json' -d "{\"vin\":\"$PROBE_VIN\"}" "http://127.0.0.1:$PORT/vehicles/register" >"$RUN_DIR/register.json"
curl -fs "http://127.0.0.1:$PORT/trips?limit=10" >"$RUN_DIR/trips-after-register.json"
NUBI_VEHICLE_HMAC_KEY="$HMAC_KEY" E2E_PROBE_VIN="$PROBE_VIN" node "$ROOT/scripts/verify-trip.mjs" "$RUN_DIR/trip-detail.json" "$ROOT/car/app/src/debug/assets/e2e-north.gpx" "$RUN_DIR/trips-after-register.json" "$ROOT/server/src/db/schema.ts" "$RUN_DIR/register.json"
echo "== 통과. 산출물: $RUN_DIR"
