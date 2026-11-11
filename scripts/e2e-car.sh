#!/usr/bin/env bash
# 차량 앱 E2E(Maestro + 서버 검증): debug 앱을 설치하고 서버를 띄운 뒤 flow를 돌리고, 서버에 저장된 트립을 검증한다.
# 사용: pnpm e2e:car   (Pleos 에뮬레이터 emulator-5554만 쓴다. 꺼져 있으면 실행 전에 띄워 두세요)
# flow 4개를 순서대로 돈다: 주행 기록(trip-recording, GPX e2e-north) → 도로 색칠(road-coloring, GPX e2e-sejong) → 시군구 색칠(region-coloring, GPX e2e-junggu 2회) → 정차 메뉴(parked-menu: 탭·QR·기록 멈춤·데이터 지우기, 마지막에 서버 삭제와 음성 로그 확인). 도로 색칠은 실제 Valhalla(nubi-valhalla, 포트 8002)를 쓴다.
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
# 서버는 vehicleId 없는 GET /trips(전체 열거)를 400으로 막는다. 앱이 쓰는 차량 ID = HMAC-SHA256(키, 주입 VIN)으로 목록을 조회한다.
E2E_VEHICLE_ID="$(node -e "console.log(require('node:crypto').createHmac('sha256', process.argv[1]).update(process.argv[2]).digest('hex'))" "$HMAC_KEY" "$APP_VIN")"
export E2E_VEHICLE_ID
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
LOGTAGS=(NubiLoc NubiTrip NubiVehicle NubiCarSignals NubiService NubiDebug NubiUpload NubiVehicleId NubiCipher NubiCoverage NubiVoice NubiExtras NubiIntro AndroidRuntime)

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
    # 시군구 flow용 절대 시각(epoch ms): B 시작·B 종료(+7분)·C 시작(= B 종료 + 정확히 10시간)·C 종료(+6분).
    # B 시작 = max(지금 + 15분, 오늘(KST) 22:30). 그래서 B 종료는 같은 KST 날짜 안(22:37~23:53)이고, C 시작은 항상 다음 날이라 자정을 지난다.
    # B의 서버 종료 시각은 마지막 샘플 시각(= B 시작 + 12초, 12점 1초 간격 실측)이라 C 시작 = B 시작 + 10시간 + 12초로 B 종료 → C 시작이 정확히 10시간이 된다.
    # 세종대로 종료 → B 시작은 10분 이상이고 자정을 넘기지 않아(방문만) 실행 시각과 무관하게 같은 결과다. 23:38~24:00 KST에는 B 종료가 자정을 넘으므로 실행을 거부한다.
    local clocks cB0 cB1 cC0 cC1
    clocks="$(node -e 'const K=9*36e5,n=Date.now(),k=new Date(n+K),d0=Date.UTC(k.getUTCFullYear(),k.getUTCMonth(),k.getUTCDate())-K;const b0=Math.max(n+15*6e4,d0+22.5*36e5),b1=b0+7*6e4;if(Math.floor((b1+K)/864e5)!==Math.floor((b0+K)/864e5)){console.error("23:38~24:00 KST에는 시군구 flow를 실행할 수 없습니다(B 종료가 자정을 넘음). 잠시 뒤 다시 실행하세요.");process.exit(3)}const c0=b0+10*36e5+12e3;console.log([b0,b1,c0,c0+6*6e4].join(" "))')" || return 3
    read -r cB0 cB1 cC0 cC1 <<<"$clocks"
    "${ADB[@]}" logcat -c || true
    set +e
    "$MAESTRO" test "$yaml" --device "$SERIAL" -e SHOT_DIR="$SHOTS" -e CLOCK_PLUS_6MIN="$plus6" -e CLOCK_B_START="$cB0" -e CLOCK_B_END="$cB1" -e CLOCK_C_START="$cC0" -e CLOCK_C_END="$cC1" -e APP_VIN="$APP_VIN" --test-output-dir "$out"
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

# 음성 안내 확인(사양 05d): 앞 flow들의 logcat에 TTS 요청·오디오 포커스 GRANTED·반납이 남았는지. 소리 자체는 확인하지 못한다.
verify_voice() {
  local logs=("$RUN_DIR"/app-logcat-*.txt)
  grep -h "NubiVoice" "${logs[@]}" >"$RUN_DIR/voice-log.txt" || true
  for pat in "TTS 요청 I01" "TTS 요청 I03" "오디오 포커스 GRANTED(MAY_DUCK)" "오디오 포커스 반납"; do
    grep -q "$pat" "$RUN_DIR/voice-log.txt" || { echo "음성 로그에 '$pat'가 없습니다. $RUN_DIR/voice-log.txt" >&2; return 1; }
  done
  echo "음성 로그 확인: I01 $(grep -c 'TTS 요청 I01' "$RUN_DIR/voice-log.txt")회, I03 $(grep -c 'TTS 요청 I03' "$RUN_DIR/voice-log.txt")회"
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
curl -fs "$BASE_URL/trips?vehicleId=$E2E_VEHICLE_ID&limit=200" >"$RUN_DIR/trips.json" || true
[ -n "$TRIP_ID" ] || { echo "이번 실행의 e2e-north 트립(점 30개·좌표 일치·종료됨)이 서버에 없습니다. $RUN_DIR/trips.json 을 확인하세요." >&2; exit 1; }
curl -fs "$BASE_URL/trips/$TRIP_ID" >"$RUN_DIR/trip-detail.json"
# 차량 ID 발급 API: 탐침 VIN을 직접 등록해 응답을 남긴다(앱이 쓴 VIN과는 별개). 서버가 VIN을 저장·응답하지 않는지 verify-trip이 확인한다
curl -fs -X POST -H 'content-type: application/json' -d "{\"vin\":\"$PROBE_VIN\"}" "$BASE_URL/vehicles/register" >"$RUN_DIR/register.json"
curl -fs "$BASE_URL/trips?vehicleId=$E2E_VEHICLE_ID&limit=200" >"$RUN_DIR/trips-after-register.json"
NUBI_VEHICLE_HMAC_KEY="$HMAC_KEY" E2E_PROBE_VIN="$PROBE_VIN" E2E_APP_VIN="$APP_VIN" node "$ROOT/scripts/verify-trip.mjs" "$RUN_DIR/trip-detail.json" "$ROOT/car/app/src/debug/assets/e2e-north.gpx" "$RUN_DIR/trips-after-register.json" "$ROOT/server/src/db/schema.ts" "$RUN_DIR/register.json"
echo "== 주행 기록 통과"

echo "== Maestro 실행: 도로 색칠 (스크린샷: $SHOTS)"
run_flow road-coloring "e2e/maestro/car/road-coloring.yaml" "$ROOT/car/app/src/debug/assets/e2e-sejong.gpx" 60 || { echo "Maestro(도로 색칠) 실패" >&2; exit 1; }

echo "== 서버 검증: 도로 색칠"
E2E_BASE_URL="$BASE_URL" node "$ROOT/scripts/verify-trip.mjs" --road-coloring "$ROOT/car/app/src/debug/assets/e2e-north.gpx" "$ROOT/car/app/src/debug/assets/e2e-sejong.gpx" | tee "$RUN_DIR/road-coloring-verify.txt"
curl -fs "$BASE_URL/trips?vehicleId=$E2E_VEHICLE_ID&limit=200" >"$RUN_DIR/trips-final.json" || true
echo "== 서버 검증: 주행 중 잠정 색칠(/trips/:id/live)"
# 세종대로 트립에 주행 중 서버가 잠정 매칭을 돌려 way(isNew)를 쌓았는지, 마지막 점의 시군구가 붙는지, 그 지도 API가 바탕 도로를 주는지 본다
SEJONG_TRIP="$(node "$ROOT/scripts/verify-trip.mjs" --exists "$BASE_URL" "$ROOT/car/app/src/debug/assets/e2e-sejong.gpx")"
[ -n "$SEJONG_TRIP" ] || { echo "세종대로 트립을 찾지 못했습니다." >&2; exit 1; }
curl -fs "$BASE_URL/trips/$SEJONG_TRIP/live" >"$RUN_DIR/live.json"
curl -fs "$BASE_URL/map/base?bbox=126.96,37.55,127.04,37.60&z=14&vehicleId=$E2E_VEHICLE_ID" >"$RUN_DIR/map-base.json"
node -e '
const live = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const base = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const fail = (m) => { console.error("실패: " + m); process.exit(1); };
if (live.status !== "ready") fail("live.status=" + live.status);
if (!(live.ways.length > 0)) fail("잠정 way가 없습니다");
if (!live.ways.some((w) => w.isNew)) fail("처음 달린 잠정 way(isNew)가 없습니다");
if (!live.region || !live.region.displayName) fail("live.region이 없습니다");
if (!(base.ways.length > 0)) fail("/map/base가 way를 주지 않았습니다");
const driven = base.ways.filter((w) => w.d).length;
console.log("잠정 way " + live.ways.length + "개(새 길 " + live.ways.filter((w) => w.isNew).length + "), upToSeq=" + live.upToSeq + ", 지금 시군구=" + live.region.displayName + ", 바탕 way " + base.ways.length + "개 중 달린 길 " + driven + "개");
if (driven === 0) fail("트립 종료 뒤 바탕 도로에 차량 인정 정보(d)가 없습니다");
' "$RUN_DIR/live.json" "$RUN_DIR/map-base.json" | tee "$RUN_DIR/live-verify.txt"
echo "== Maestro 실행: 시군구 색칠 (스크린샷: $SHOTS)"
run_flow region-coloring "e2e/maestro/car/region-coloring.yaml" "$ROOT/car/app/src/debug/assets/e2e-junggu.gpx" 12 || { echo "Maestro(시군구 색칠) 실패" >&2; exit 1; }

echo "== 서버 검증: 시군구 색칠"
E2E_BASE_URL="$BASE_URL" node "$ROOT/scripts/verify-trip.mjs" --regions "$ROOT/car/app/src/debug/assets/e2e-sejong.gpx" "$ROOT/car/app/src/debug/assets/e2e-junggu.gpx" | tee "$RUN_DIR/region-coloring-verify.txt"
echo "== Maestro 실행: 정차 메뉴 (스크린샷: $SHOTS)"
"${ADB[@]}" logcat -c || true
set +e
"$MAESTRO" test "e2e/maestro/car/parked-menu.yaml" --device "$SERIAL" -e SHOT_DIR="$SHOTS" -e APP_VIN="$APP_VIN" --test-output-dir "$RUN_DIR/maestro/parked-menu"
MENU_RC=$?
set -e
"${ADB[@]}" logcat -d -s "${LOGTAGS[@]}" >"$RUN_DIR/app-logcat-parked-menu-attempt1.txt" 2>&1 || true
[ "$MENU_RC" -eq 0 ] || { echo "Maestro(정차 메뉴) 실패(재시도 안 함). 출력: $RUN_DIR/maestro/parked-menu" >&2; exit 1; }

echo "== 서버 검증: 데이터 지우기·기록 멈춤 해제"
# 정차 메뉴 flow가 데이터를 지웠다: 이 차량의 트립이 모두 없어지고 위치정보 동의 철회가 기록돼야 한다
curl -fs "$BASE_URL/trips?vehicleId=$E2E_VEHICLE_ID&limit=200" >"$RUN_DIR/trips-after-delete.json"
curl -fs "$BASE_URL/vehicles/$E2E_VEHICLE_ID/settings" >"$RUN_DIR/settings-after-delete.json"
node -e '
const t = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const s = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const items = Array.isArray(t) ? t : (t.items ?? t.trips ?? []);
if (items.length !== 0) { console.error("실패: 데이터 지우기 뒤에도 트립이 " + items.length + "개 남았습니다"); process.exit(1); }
if (!s.consentWithdrawnAt) { console.error("실패: 위치정보 동의 철회가 기록되지 않았습니다"); process.exit(1); }
console.log("데이터 지우기 확인: 트립 0개, 동의 철회 " + s.consentWithdrawnAt);
' "$RUN_DIR/trips-after-delete.json" "$RUN_DIR/settings-after-delete.json" | tee "$RUN_DIR/delete-verify.txt"
# 삭제 뒤 몇 초가 지나도 차량 앱이 옛 큐를 다시 올리거나 새 트립을 만들지 않는다(로컬 큐 정리·기록 멈춤, 서버도 차단)
sleep 8
curl -fs "$BASE_URL/trips?vehicleId=$E2E_VEHICLE_ID&limit=200" >"$RUN_DIR/trips-after-delete-wait.json"
node -e '
const t = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const items = Array.isArray(t) ? t : (t.items ?? t.trips ?? []);
if (items.length !== 0) { console.error("실패: 삭제 뒤 기다리는 사이 트립이 " + items.length + "개 다시 생겼습니다"); process.exit(1); }
console.log("삭제 8초 뒤에도 트립 0개");
' "$RUN_DIR/trips-after-delete-wait.json" | tee -a "$RUN_DIR/delete-verify.txt"
verify_voice | tee -a "$RUN_DIR/delete-verify.txt"
write_summary
echo "== 통과. 산출물: $RUN_DIR"
