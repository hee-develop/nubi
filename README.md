# 누비 (nubi)

**차가 기록한 주행으로 다녀간 시군구와 달린 도로를 칠해, 안 가 본 지방으로 이끄는 Pleos Connect 차량 앱입니다.**

- 공모전: 현대자동차그룹 차량용 앱 개발 공모전(Pleos Connect) 1차 접수, 팀 **yona**
- 시연 영상: `[시연 영상 링크]`
- APK: [`apk/yona_nubi_release.apk`](apk/) (서명된 release 빌드, **서버 주소 미설정**). 4절 참고
- 기획서: 접수양식으로 제출합니다(이 저장소에는 넣지 않았습니다)
- 데모 서버: **호스팅하지 않습니다.** 전체 흐름(기록 → 색칠 → 도감)은 5절 절차대로 로컬 PC에서 서버를 띄우고 debug 빌드로 확인합니다

## 1. 무엇이 동작하나

| 구분 | 내용 | 상태 |
|---|---|---|
| 주행 기록 | 차량 앱이 위치·기어로 트립을 나눠 서버에 올린다. 로컬 큐는 AES-GCM 암호화, 네트워크가 끊기면 재전송 | 실동작(에뮬레이터 E2E 통과) |
| 도로 색칠·완료율 | 서버가 Valhalla로 궤적을 OpenStreetMap 도로에 맞추고 도로 이름 단위로 칠한다. 도로별 완주율, 전국 완료율(분모: 이름 있는 자동차 도로 122,263.24 km) | 실동작(에뮬레이터 E2E 통과) |
| 시군구 3단계 | 통과(지나감) / 방문(P단 10분 이상) / 숙박(자정을 넘겨 6시간 이상 7일 이하, 같은 시군구에서 출발). 시군구 도감 n/229, 인구감소지역 도감 n/92 | 실동작(에뮬레이터 E2E 통과) |
| 차량 화면 | 기어 D·R·N: 로고와 '기록 중' 상태 문구만(숫자·카드·버튼 없음). 기어 P: 정차 카드 — 지금 시군구와 단계 배지(통과·방문·숙박), 새 도로·전국 완료율, 시군구 n/229·인구감소지역 n/92, 안 가 본 이웃(서버 인접 판정, 미방문·인구감소지역 우선). 지역 이름은 `서울 중구`처럼 시도 단축명을 붙인다. 두 앱을 나란히 연 좁은 영역에서는 이웃 카드를 축약한다 | 실동작 |
| 정차 카드 길안내 | 이웃 시군구 중심점으로 NaviHelper `requestRoute` 요청(에뮬레이터에서 요청 전달까지 확인, 실제 경로 안내 시작은 실차 미확인) | 실동작(요청까지) |
| 정차 카드의 관광지·축제 항목, 게스트 QR, 정차 메뉴 | 지역 소개는 서버 `/regions/:code/intro`(키가 없으면 '예시'로 표기), 게스트·차주 연결·공유 QR은 서버 코드로 만든 실제 QR(P에서만), 정차 메뉴(도감·도로·오늘·설정). 사양 `docs/specs/05d-car-extras.md` | 야간 구현(feat/07-car-extras, 에뮬레이터 E2E) |
| 지도 열람 | 서버 웹 뷰어 `/viewer`(시연·검증용, 폰 앱 대신) | 실동작 |
| 폰 앱, 관광지·축제 데이터, 게스트 탑승 연결, 공유 카드, 바램 | | 구현 전(시안) |

## 2. 구성

```
car/      차량 앱. Kotlin + Pleos Connect SDK, 독립 Gradle 프로젝트(com.nubi.car)
server/   서버. TypeScript + Hono, Node 22 내장 SQLite(@nubi/server)
phone/    폰 앱. React Native(Expo), 골격만 있음(@nubi/phone)
scripts/  데이터 빌드(도로·시군구), Valhalla 기동, E2E, APK 패키징 스크립트
e2e/      Maestro flow(e2e/maestro/car)
apk/      제출용 서명 APK와 SHA-256 기록(apk/README.md)
docs/     기능 사양(specs/), SDK·인프라 실측 기록(sdk-check.md)
```

판정은 서버가 합니다. 전국 맵매칭 타일(1.7 GB)과 도로 DB(약 370 MB)를 차량 앱 자원 안에 넣을 수 없어서입니다. 차량 앱은 무엇을 언제 기록할지만 정하고, 색칠·완료율·도감은 서버 결과를 받아 보여 줍니다.

```
차량 앱 ──트립(HTTP)──▶ 서버 ──▶ Valhalla(맵매칭, Docker)
   ▲                     │      도로 DB(OSM) · 시군구 DB(행정동 경계)
   └──매칭 결과·도감──────┘──▶ /viewer(웹 지도)
```

## 3. 테스트 환경

| 항목 | 값 |
|---|---|
| 차량 에뮬레이터 | Pleos Connect 에뮬레이터 v2.1.0, AVD `Pleos_Connect_v2_1`(Android API 34 이미지), adb 시리얼 `emulator-5554`. 앱은 Android 사용자 10에서 돈다 |
| 개발 PC | macOS(Apple Silicon arm64) |
| 차량 앱 빌드 | JDK 17, Gradle 9.0.0(래퍼), Android Gradle Plugin 8.13.2, Kotlin 2.2.10, minSdk 28 / targetSdk 34 |
| Pleos SDK | Vehicle 2.3.2, FusedLocation 1.1.3, NaviHelper 3.0.5, TextToSpeech·SpeechToText 3.3.1(`https://nexus-playground.pleos.ai/repository/maven-releases/`) |
| 서버 | Node.js 22.13 이상(내장 `node:sqlite`), pnpm 10 |
| 맵매칭 | Colima + Docker, `ghcr.io/gis-ops/docker-valhalla/valhalla:3.5.1`(포트 8002) |
| 데이터 빌드 | osmium-tool(`brew install osmium-tool`) |
| E2E | Maestro |

**실차에서 아직 확인하지 못한 것** (에뮬레이터로는 확인 불가)

- 실제 주행 중 FusedLocation 위치 수신(`ERROR_DRIVING_RESTRICTED` 여부). 에뮬레이터에서는 다른 앱이 앞에 있어도 위치를 계속 받았다
- 시동 때 앱 자동 실행. 지금은 최초 1회 앱을 열어야 기록 서비스가 뜬다
- 오도미터 값과 단위(에뮬레이터는 0.0 고정이라 오도미터 대조는 건너뛰는 경로로만 검증)
- 실제 기어 전환(에뮬레이터는 P 읽기만 확인, 전환은 debug 주입)
- 주행 규제(`CarUxRestrictions`) 상태 전환과 Distraction Optimized 선언의 심사 인정
- `ACCESS_COARSE_LOCATION`·`CAR_DRIVE`·`CAR_INFO` 권한의 App Market 승인

자세한 실측은 `docs/sdk-check.md`에 있습니다.

## 4. 제출 APK

| 항목 | 값 |
|---|---|
| 파일 | [`apk/yona_nubi_release.apk`](apk/yona_nubi_release.apk) (27,949,078 bytes) |
| 패키지·버전 | `com.nubi.car`, versionName 0.1.0(versionCode 1) |
| 서명 | release 키(APK Signature Scheme v2) |
| SHA-256 | `bd7d2a256554a6df00272d20f29e8885e2f42b16b4aca11be7f819607fb2bbdf` |
| 서버 주소 | **미설정**(자리표시 `https://nubi.invalid`) |

```bash
shasum -a 256 apk/yona_nubi_release.apk   # 위 SHA-256과 같아야 합니다
```

**이 APK로 확인할 수 있는 것과 없는 것**

- release 빌드는 HTTPS만 허용하고, 서버 주소가 자리표시라 **어떤 서버에도(로컬 서버 포함) 붙지 않습니다.** 데모 서버는 호스팅하지 않기로 했습니다.
- 앱은 설치·실행되고, 업로드 줄에 `서버 미설정`을 표시합니다. 기록은 단말의 암호화 큐에 쌓이기만 합니다.
- release 빌드에는 debug 주입 경로(`nubi-debug://`), 평문 HTTP 허용, 테스트 GPX가 없습니다. 실차가 없는 에뮬레이터에서는 기어·위치를 바꿀 수 없어 기록 흐름도 재현되지 않습니다.
- 그래서 **전체 흐름(기록 → 도로 색칠 → 시군구 도감)은 5절의 로컬 실행(debug 빌드 + 로컬 서버)으로 확인**합니다.

에뮬레이터에 설치(앱은 사용자 10에서 돕니다). debug 빌드와 서명이 달라, 이미 debug 빌드가 깔려 있으면 먼저 지웁니다.

```bash
adb -s emulator-5554 uninstall com.nubi.car          # debug 빌드가 깔려 있을 때만
adb -s emulator-5554 install --user 10 apk/yona_nubi_release.apk
adb -s emulator-5554 shell am start -n com.nubi.car/.MainActivity
```

**서버에 붙는 release를 직접 만들려면**: TLS(HTTPS) 서버를 띄운 뒤 그 주소로 다시 패키징합니다. 서명 키는 저장소 밖에 있으므로(`NUBI_KEYSTORE_PROPS` 또는 `~/.nubi/keystore.properties`), 키가 없으면 서명 없는 APK만 만들어집니다.

```bash
scripts/package-apk.sh yona nubi --server https://<서버 주소>
# → apk/yona_nubi_release.apk, apk/README.md에 SHA-256 기록. http:// 주소는 빌드에서 거부합니다
```

## 5. 로컬 실행 (전체 흐름, debug 빌드)

로컬 PC에서 서버·Valhalla를 띄우고, Pleos 에뮬레이터에 debug 빌드를 설치해 시연 신호를 주입합니다. debug 빌드는 에뮬레이터에서 PC 서버로 `http://10.0.2.2:<포트>`에 붙습니다. 처음 한 번은 데이터 준비(5-2~5-4)에 약 10~20분이 걸립니다(다운로드 278 MB, 타일 빌드 약 3분 실측).

### 5-1. 설치

```bash
# 요구: Node 22.13+, pnpm, JDK 17, Android Studio(+ Pleos Connect 에뮬레이터 v2.1.0), Colima + Docker, osmium-tool
brew install colima docker osmium-tool
pnpm install            # 저장소 루트
```

### 5-2. Valhalla(맵매칭) 준비

```bash
bash scripts/setup-valhalla.sh
# Colima 기동 → 이미지(3.5.1) 받기 → Geofabrik south-korea-latest.osm.pbf 다운로드(server/data/osm/)
# → 타일 빌드(server/data/valhalla/, 약 1.7 GB) → 컨테이너 nubi-valhalla(포트 8002) 기동 → /status 대기
# 다음부터는 기동만: bash scripts/valhalla-up.sh   (포트를 바꾸려면 VALHALLA_PORT)
```

### 5-3. 시군구 DB 빌드

```bash
mkdir -p server/data/regions
curl -fL -o server/data/regions/HangJeongDong_ver20251231.geojson \
  https://raw.githubusercontent.com/vuski/admdongkor/master/ver20251231/HangJeongDong_ver20251231.geojson
node scripts/build-regions.mjs server/data/regions/HangJeongDong_ver20251231.geojson 202512
# → server/data/regions/regions.sqlite (시군구 229개, 약 2 MB). 인구감소지역 목록은 server/data/regions/depopulation.json(추적됨)
# 확인: node scripts/verify-regions.mjs
```

### 5-4. 도로 DB 빌드 (시군구 DB가 먼저 있어야 함)

```bash
node scripts/build-road-db.mjs server/data/osm/south-korea-latest.osm.pbf 202611 \
  --regions server/data/regions/regions.sqlite
# → server/data/roads-202611.sqlite (약 370 MB, 약 20초)
```

`server/data/`는 git에 올리지 않습니다(용량·라이선스 분리, `depopulation.json`만 추적). 테스트 픽스처(`server/test/fixtures/roads-test.sqlite`, `regions-test.sqlite`)는 세종대로 일대만 담은 소형 DB로, 환경 변수로 **명시**했을 때만 씁니다.

### 5-5. 서버 기동

```bash
cd server
NUBI_DB=:memory: \
NUBI_VEHICLE_HMAC_KEY=<임의 비밀값> \
PORT=8787 \
NUBI_VALHALLA_URL=http://127.0.0.1:8002 \
NUBI_ROADS_DB="$PWD/data/roads-202611.sqlite" \
NUBI_REGIONS_DB="$PWD/data/regions/regions.sqlite" \
NUBI_VIEWER=1 \
./node_modules/.bin/tsx src/index.ts
# 확인: curl -fs http://127.0.0.1:8787/health
```

| 환경 변수 | 뜻 | 기본값 |
|---|---|---|
| `PORT` / `HOST` | 서버 포트 / 바인드 주소 | `8787` / `127.0.0.1` |
| `NUBI_DB` | 사용자 기록 DB 경로(`:memory:` 가능) | `server/data/nubi.sqlite` |
| `NUBI_VEHICLE_HMAC_KEY` | 차량 ID 발급 비밀키(VIN → HMAC, VIN은 저장하지 않음) | 개발용 키(경고 출력, `NODE_ENV=production`에서는 시작 거부) |
| `NUBI_VALHALLA_URL` | Valhalla 주소 | `http://127.0.0.1:8002` |
| `NUBI_ROADS_DB` | 도로 DB | 최신 `server/data/roads-*.sqlite`. 없으면 조회 API 503 |
| `NUBI_REGIONS_DB` | 시군구 DB | `server/data/regions/regions.sqlite`. 없으면 지역 API 503 |
| `NUBI_VIEWER` | `1`이면 `/viewer` 등록 | `NODE_ENV`가 production이 아니면 등록 |

배포 단위는 `server/`입니다(`pnpm --filter @nubi/server build` → `server/dist/`, 실행은 `node dist/index.js`). 시군구 판정 모듈 `server/src/shared/geo-utils.mjs`는 빌드가 `dist/shared/`로 복사하므로 루트 `scripts/`는 런타임에 필요 없습니다.

### 5-6. 차량 앱 설치 (Pleos 에뮬레이터, debug 빌드)

```bash
~/Library/Android/sdk/emulator/emulator -avd Pleos_Connect_v2_1 -no-snapshot-save &
adb -s emulator-5554 uninstall com.nubi.car    # 제출 APK(release)가 깔려 있을 때만. 서명이 달라 덮어쓸 수 없음
cd car
ANDROID_SERIAL=emulator-5554 ./gradlew :app:installDebug -Pnubi.serverPort=8787
adb -s emulator-5554 shell pm clear --user 10 com.nubi.car          # 이전 데이터 초기화
adb -s emulator-5554 shell pm grant --user 10 com.nubi.car pleos.car.permission.FUSED_LOCATION
adb -s emulator-5554 shell pm grant --user 10 com.nubi.car android.permission.ACCESS_COARSE_LOCATION
adb -s emulator-5554 shell am force-stop com.nubi.car
adb -s emulator-5554 shell am start -n com.nubi.car/.MainActivity
```

`-Pnubi.serverPort`는 5-5의 `PORT`와 같아야 합니다(기본 8787, 앱은 `http://10.0.2.2:<포트>`로 붙음). `ANDROID_SERIAL`을 지정하지 않으면 adb에 연결된 다른 기기에도 설치될 수 있습니다. 권한을 미리 주지 않으면 앱 화면의 '허용하고 시작' 버튼으로 받습니다.

### 5-7. 시연 신호 주입 (debug 빌드 전용)

실차가 없으므로 기어·위치·시각을 `nubi-debug://signal?…` 주소로 넣습니다. `&`가 에뮬레이터 쪽 셸에서 끊기지 않도록 명령을 큰따옴표로 감쌉니다.

```bash
sig() { adb -s emulator-5554 shell "am start -a android.intent.action.VIEW -d 'nubi-debug://signal?$1'" >/dev/null; }

sig 'reset=1&vin=E2EAPPVIN0000001'      # 상태 비우기 + 시연용 VIN 주입 → '대기'
sig 'gear=D'                            # 기어 D → '기록 중'(숫자는 숨김)
sig 'gpx=e2e-sejong.gpx&park=1'         # 세종대로 60점을 1초 간격 재생, 끝나면 기어 P
# 화면에 '샘플 60'이 보이면 시계를 6분 뒤로 옮겨 트립 종료(기어 P 5분 조건)
sig "gear=P&now=$(( $(date +%s) * 1000 + 6 * 60 * 1000 ))&flush=1"
# → '종료됨', '마지막 업로드: 종료 전송 완료'(또는 '성공: N점'), '새 도로 1.2km · 전국 0.00xx% (+0.00xx)'
```

| 인자 | 뜻 |
|---|---|
| `reset=1` | 재생 중지, 엔진 상태·화면 결과 초기화 |
| `vin=<VIN>` | 차량 VIN 주입(에뮬레이터 VIN은 9자 더미라 서버 형식 검사에 걸림) |
| `gear=P\|R\|N\|D` | 기어 |
| `gpx=<파일명>` / `park=1` | `car/app/src/debug/assets/`의 GPX 재생(`e2e-north`, `e2e-sejong`, `e2e-junggu`) / 재생 끝나면 기어 P |
| `loc=<lat>,<lon>[,<heading>]` | 위치 한 점 |
| `now=<epoch ms>` | 엔진 시계 설정(5분·10분·자정 판정을 기다리지 않고 건너뜀) |
| `flush=1` | 큐 즉시 업로드 |
| `real=1` | 실제 위치 스트림(FusedLocation) 받기 |

시군구 방문·숙박까지 보는 순서(E2E 세 번째 flow)는 `e2e/maestro/car/region-coloring.yaml`에 있습니다. 화면에는 `시군구 2/229 · 인구감소지역 0/92`, `서울 중구 방문`, 이어서 `서울 중구에서 하룻밤`이 보입니다. 시각 계산식은 `scripts/e2e-car.sh`의 `run_flow`에 있습니다.

### 5-8. 결과 보기

`GET /trips`는 `vehicleId` 없이 부르면 400입니다(전체 열거 차단). 차량 ID는 주입한 VIN을 같은 서버에 등록해 받습니다(같은 키·같은 VIN이면 같은 ID).

```bash
VID=$(curl -s -X POST -H 'content-type: application/json' -d '{"vin":"E2EAPPVIN0000001"}' \
  http://127.0.0.1:8787/vehicles/register | node -pe 'JSON.parse(require("fs").readFileSync(0)).vehicleId')
open "http://127.0.0.1:8787/viewer?vehicleId=$VID"
```

뷰어는 칠한 도로 세그먼트, 전국 완료율, 달린 도로 상위 10, 시군구 레이어(통과·방문·숙박 농도)를 보여 줍니다. 조회 API: `GET /trips?vehicleId=`, `/coverage/summary`, `/coverage/roads`, `/coverage/segments`, `/regions/summary`, `/regions/list`, `/regions/geo`, `/regions/neighbors`, `/regions/at`, `/trips/:id/matching`.

## 6. 테스트와 E2E

```bash
pnpm typecheck
pnpm server:test        # 서버 단위 테스트(vitest)
pnpm car:test           # 차량 앱 JVM 단위 테스트
PORT=8788 pnpm e2e:car  # E2E: Valhalla 기동 확인 → debug 설치·pm clear → 서버(메모리 DB) → Maestro flow 3개 → 서버 검증
```

E2E(`scripts/e2e-car.sh`)는 `emulator-5554`만 쓰고, flow 세 개를 순서대로 돕니다. 서버 포트 기본값은 8787입니다.

| flow | GPX | 서버 검증(`scripts/verify-trip.mjs`) |
|---|---|---|
| 주행 기록 | `e2e-north` 30점 | 점 30개·seq 연속·좌표 일치·거리 725±10 m·시간 29±3초·기어 D·속도 미수집, 차량 ID = HMAC(키, VIN) |
| 도로 색칠 | `e2e-sejong` 60점(광화문 → 숭례문 약 1.48 km) | 매칭 done, newKm 1.12~1.37, `국도 31호선`(`nr:31`)에 세종대로 포함, 완료율 증가 = newKm/분모, 세그먼트 ≥ 5, 차량 화면 `새 도로 …km` |
| 시군구 색칠 | `e2e-junggu` 12점 × 2회 | 시군구 2/229, 중구 방문 → (앞 트립 종료 + 정확히 10시간, 자정 통과) 출발로 숙박(단계 3, visits 2·stays 1), 종로구 통과(단계 1), 차량 화면 `시군구 2/229`·`인구감소지역 0/92`, 단계 배지 `방문 ●●○`→`숙박 ●●●`, `서울 중구 방문`, `서울 중구에서 하룻밤`, 이웃 카드 `길안내` → `길안내 요청을 보냈어요`. 기어 D에서는 숫자·카드·QR·길안내가 보이지 않음 |

기능 완료 기준은 **재시도 없는 E2E 2회 연속 통과**입니다(재시도가 있으면 `summary.json`에 `retried`가 남고 통과로 세지 않음). 산출물(스크린샷·로그)은 `e2e/output/car/<시각>/`에 남고 git에는 올리지 않습니다.

**통과 기록** (2026-11-10~11, 전국 도로 DB `roads-202611` + 전국 시군구 DB `202512` + Valhalla 3.5.1)

| 실행 | retried | 도로 색칠 newKm / 누적 | 전국 완료율 | 시군구 | 중구 / 종로구 단계 |
|---|---|---|---|---|---|
| 20261110-073443 | 없음 | 1.245 km / 1.41 km | 0.0012% | 2/229, 인구감소지역 0/92 | 3(숙박) / 1(통과) |
| 20261110-073747 | 없음 | 1.245 km / 1.41 km | 0.0012% | 2/229, 인구감소지역 0/92 | 3(숙박) / 1(통과) |
| 20261111-144833 (정차 카드 디자인 적용 후) | 없음 | 1.245 km / 1.41 km | 0.0012% | 2/229, 인구감소지역 0/92 | 3(숙박) / 1(통과) |
| 20261111-145142 (정차 카드 디자인 적용 후) | 없음 | 1.245 km / 1.41 km | 0.0012% | 2/229, 인구감소지역 0/92 | 3(숙박) / 1(통과) |

단위 테스트: 서버 127개 통과(vitest), 차량 앱 JVM 단위 테스트 162개 통과.

## 7. 알려진 한계

- **서버 인증 없음**: `/regions/*`·`/coverage/*`·`/trips`·`/vehicles/*`는 차량 ID만 알면 읽고 쓸 수 있습니다. 로컬·에뮬레이터 검증용이며 `HOST` 기본값도 `127.0.0.1`입니다. 지금 조치는 `GET /trips` 전체 열거 차단(`vehicleId` 없으면 400)뿐이고, 공개 배포 전에 기기·계정 인증, 트립 소유 검증, rate limit, TLS 종단을 붙입니다
- **제출 APK는 서버 미설정**: 데모 서버를 호스팅하지 않으므로 release APK는 서버에 붙지 않습니다(4절). 전체 흐름은 로컬 실행(5절)으로 확인합니다
- **실차 미검증**: 3절 '실차에서 아직 확인하지 못한 것' 참고. 시연의 위치·기어·시각은 debug 주입입니다
- 도로 완료율 분모의 분리 차로 1/2 규칙은 근사입니다. 이름·번호 없는 도로(길이 기준 38.4%)는 분자·분모에서 뺍니다
- 시군구 경계는 2025-12-31 기준이고, 2026-07-01 전남광주통합특별시는 코드 매핑(27건)으로 반영했습니다. 인천·화성 2026-07 개편은 반영하지 않았습니다
- 뷰어의 OSM 래스터 타일은 개발·시연용입니다(OSMF 타일 정책). 배포 때는 자체·유료 타일로 바꿉니다
- 폰 앱, 공유 카드, 게스트 탑승 연결, 바램은 구현 전입니다. 정차 카드의 관광지·축제 항목은 TourAPI 키가 없으면 '예시'로 표기한 고정 항목이고, 게스트 QR은 서버 코드가 만든 실제 QR입니다(폰에서 열 수 있는 주소는 서버를 배포한 뒤에만 의미가 있습니다)
- 길안내는 에뮬레이터에서 NaviHelper 요청 전달까지만 확인했습니다. 목적지는 이웃 시군구 경계 상자의 중심점이라 해안·도서 지역에서는 바다나 다른 시군구에 찍힐 수 있습니다

## 8. 데이터 출처와 라이선스

| 데이터·소프트웨어 | 출처 | 라이선스 |
|---|---|---|
| 도로망 | © OpenStreetMap contributors, Geofabrik `south-korea-latest.osm.pbf`(2026-11 스냅샷) | ODbL 1.0. 도로 DB(`roads-*.sqlite`)는 OSM 파생 DB이며 사용자 기록 DB와 파일을 분리합니다. API 응답·뷰어에 출처를 표기합니다 |
| 시군구 경계 | 통계청 SGIS 행정동 경계를 vuski/admdongkor가 가공(`ver20251231`) | 원자료 공공누리 제1유형(출처표시), 가공분 CC BY 4.0 |
| 인구감소지역 목록 | 행정안전부 지정 92곳(2026-10-20 시행, 도감 분모). 2021년 지정 89곳은 통계 인용용으로 함께 기록 — `server/data/regions/depopulation.json`에 출처 URL·기준일 | 공공 정보 |
| 맵매칭 | Valhalla 3.5.1(`ghcr.io/gis-ops/docker-valhalla`) | MIT |
| 지도 표시(뷰어) | MapLibre GL JS(CDN, 버전 고정), OSM 래스터 타일 | BSD-3-Clause / OSM 타일 이용 정책 |
| Pleos Connect SDK | Pleos 개발자 Maven 저장소(Gradle 의존성으로 받으며 저장소에 바이너리를 넣지 않음) | Pleos Developers 이용 조건을 따름 |
| 이 저장소의 코드 | 팀 yona | 별도 오픈소스 라이선스를 붙이지 않았습니다(공모전 심사용 열람) |

## 9. 문서

- 기획서는 공모전 접수양식으로 제출합니다
- `docs/specs/01-trip-recording.md`, `02-road-coloring.md`, `03-region-coloring.md` 기능 사양
- `docs/sdk-check.md` SDK·인프라 실측(10절: release 서명·패키징)
- `apk/README.md` 제출 APK의 버전·SHA-256 기록
