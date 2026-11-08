# 01. 주행 기록(트립 레코딩)

차량 앱이 주행 위치를 자동으로 기록해 서버에 트립으로 저장하는 기반 기능입니다. 아래 수치는 모두 **가안**이며 실주행 데이터를 보고 조정합니다.

## 기준값(가안)

| 항목 | 값 |
|---|---|
| 위치 샘플 채택 | 직전 채택점에서 **20m 이상**이면 채택. **5초 조건은 직전 채택점에서 5m 이상 움직였을 때만** 적용(정지 중 흔들림으로 점이 쌓이지 않게). 즉 `이동 ≥ 20m` 또는 `이동 ≥ 5m 그리고 경과 ≥ 5초` |
| 트립 시작 | **첫 대기 샘플 기준 직선 변위 50m** 이상(경로 합이 아님) + 기어가 P가 아닐 때(기어 null이면 변위만으로). 대기 샘플부터 트립에 포함. 기어 P인 동안의 샘플은 버리고 P로 바뀌면 대기 샘플을 폐기. 대기 샘플은 최대 200개 |
| 트립 종료 | 기어 **P 진입 후 5분** 유지 → 종료. **P 진입 이후 샘플은 트립에 넣지 않으며 종료 시각 = P 진입 전 마지막 채택 샘플 시각**. 기어 null 차량은 **채택점 변위 20m 미만이 5분 지속**되면 종료(기준점 = 직전 기준점에서 20m 이상 움직인 마지막 채택 샘플). 서비스 `onDestroy`·`onTaskRemoved`에서도 종료(종료 시각 = 마지막 채택 샘플) |
| 종료 후 재개 | 기어가 R/N/D로 바뀌면 즉시 새 트립을 받을 수 있음. 기어 null이면 새 변위 50m가 되는 즉시 새 트립. 기어 P인 채로는 시작하지 않음 |
| 타이머 | 모든 경과 시간 판정(5초·5분·재시도 간격·VIN 대기)은 `SystemClock.elapsedRealtime()` 기준이며 벽시계는 쓰지 않는다. 샘플 `ts`(서버에 보내는 값)만 벽시계 |
| 미종료 트립 복구 | **큐 로드가 끝난 뒤 프로세스당 1회**(서비스 `startForeground` 성공 여부와 무관). 로컬에 '시작했으나 End를 못 보낸 트립'이 있으면 **마지막 샘플 시각**으로 End를 큐에 넣는다. 지금 진행 중인 트립은 제외하고, 큐에 그 트립의 End가 이미 있으면 건너뛴다. 서버 End는 멱등이되 처음 End의 `odometerEndKm`이 null이었고 나중 요청에 값이 있으면 채운다(Suspend로 `onDestroy` 없이 프로세스가 죽는 경우를 위한 안전망) |
| 업로드 | **60초마다 또는 100점** 쌓이면 배치 전송, 트립 종료 때 전량 flush. 지수 백오프(2초에서 두 배씩, 최대 5분). 네트워크 호출은 큐 lock 밖에서 한다 |
| 업로드 멱등 | `POST /trips`에 클라이언트 `localId`(UUID)를 보내고 서버는 `(vehicle_id, local_id)` 복합 UNIQUE로 `INSERT OR IGNORE` 후 **기존 tripId를 반환**(처음 만들면 201, 이미 있으면 200). 점은 `(tripId, seq)`, End는 이미 종료됐으면 같은 요약으로 멱등 |
| 4xx·오류 처리 | 아래 표. Start 4xx 등 보류는 **그 트립만** 보류 집합에 넣고 다른 트립은 계속 올리며 보류 트립은 백오프 뒤 재시도 |
| 로컬 큐 | 상한 **50,000점**. 넘으면 가장 오래된 **종료 트립**부터 통째로 제거하고 로그. 점 수는 카운터(O(1)). 파일은 append 전용이고 보낸 항목 제거는 1,000개마다·drain 종료 때 컴팩션(그 사이 죽어도 서버가 멱등이라 재전송 안전). 컴팩션·상한 정리는 lock 안에서 목록 스냅샷만 뜨고 암호화·임시 파일 쓰기·**fsync**는 lock 밖에서 한 뒤 **rename** 순간만 lock(컴팩션 중 들어온 항목은 암호화된 꼬리로 모아 잇는다. 실측: 큐 5,000줄 컴팩션 중 enqueue 1ms 미만, 단위 테스트 기준 50ms). 큐 로드·복호화는 워커에서 하고 그동안 화면은 '불러오는 중'. 상한 정리는 메모리에서 바로 하고 파일은 다음 컴팩션에서 줄인다. dead-letter 파일은 5,000줄 상한 |
| 저장 암호화 | 큐·`dead-letter.jsonl`·server-ids·차량 ID 파일은 **앱 프로세스 안의 AES-256-GCM 데이터 키(DEK)로 줄 단위 암호화**한다(줄마다 Keystore IPC를 만들지 않으려고). DEK는 **Android Keystore AES-GCM 키로 감싸(wrap) `dek.bin`에 저장**하고 시작 때 unwrap 1회만 한다(Jetpack Security는 deprecated). 복호화에 실패한 줄(손상)은 건너뛰며 개수를 세어 화면에 '손상 n줄'. unwrap이 실패하면(Keystore 키 소실·파일 손상) 예외 없이 새 DEK를 만들고 읽을 수 없게 된 기존 큐·dead-letter는 폐기하며 폐기한 줄 수를 화면에 남긴다. 파일 교체는 fsync 뒤 rename |
| 저장 실패 | `enqueue`의 JSON 인코딩(NaN 등)·파일 쓰기 예외는 잡아 '저장 실패 n건'으로 화면에 보이고 크래시하지 않는다(쓰기 실패 항목은 메모리에 남아 이번 실행에서는 업로드). 좌표·오도미터가 NaN·무한대·범위 밖이면 샘플 단계에서 버린다 |
| 차량 ID | **서버 발급 ID**. 차량 앱이 Vehicle SDK `CarInfo.getVINInfo`(권한 `CAR_INFO`)로 읽은 VIN을 `POST /vehicles/register { vin }`(release는 TLS 필수)으로 보내면 서버가 `vehicleId = HMAC-SHA256(서버 비밀키 NUBI_VEHICLE_HMAC_KEY, vin)`(hex)을 돌려준다. **서버는 VIN을 저장·로그·응답하지 않는다.** 앱은 받은 ID를 암호화 저장해 재사용하고 이후 서버를 부르지 않는다. 앱 고정 pepper(`BuildConfig.VIN_PEPPER`)는 없앴다(17자 VIN 공간은 pepper를 알면 역산 가능했다). 비밀키가 없으면 개발용 기본값과 경고 로그. ID를 받기 전에는 UUID를 만들지 않고 Start 업로드를 보류하며, 서비스 시작 후 10초가 지나도 ID가 없을 때만 UUID로 대체해 저장(이때 register는 호출하지 않음. 이전에 받아 둔 ID가 있으면 VIN 없이도 그것을 쓴다) |
| 운전자 ID | 이번 단계에서는 차량 ID와 동일(계정·게스트는 뒤 단계) |
| 오도미터 | 트립 시작·종료 때 `Odometer.getCurrentDistanceDriven`(권한 `pleos.car.permission.CAR_DRIVE`) 값을 km로 저장. 실패·2초 초과면 null |
| 속도 | **수집하지 않는다**(2026-11-08 결정). `CAR_SPEED` 권한 요청·`PERF_VEHICLE_SPEED` 읽기·`speedKph` 전송 코드가 없다. 정차·주행 판정은 기어와 위치 변화만 쓴다. 서버 스키마의 `speed_kph` 컬럼은 nullable로 남기고 항상 NULL |
| 기어 | AAOS `GEAR_SELECTION`(차곡과 같은 방식). 샘플마다 P/R/N/D 중 하나 또는 null |
| heading | 에뮬레이터는 항상 0.0을 주므로 0.0이면 null로 보낸다(실차 값 확인 전까지) |
| 로그 | 위경도는 `BuildConfig.DEBUG`일 때만, 소수점 2자리로 뭉개 남긴다. release에는 좌표를 남기지 않는다. VIN 원문은 길이만 |

### 서버 응답별 처리

| 상황 | 처리 |
|---|---|
| 네트워크 오류, 5xx, 408·425·429, 2xx인데 JSON이 아닌 응답, 그 밖의 모든 예외 | 재시도(항목 유지, 백오프). 크래시하지 않는다 |
| 점 배치 400(413·422 포함) | 배치를 반으로 나눠 재전송하고 성공하면 배치 크기를 원래대로 복원. 1점까지 400이면 그 점만 `dead-letter.jsonl`로 격리(폐기하지 않음) |
| 404(trip 없음) | 저장해 둔 Start로 같은 `localId`로 트립을 다시 만든 뒤 재전송(한 번만. 또 404면 재시도로 넘김. 재생성 호출의 네트워크·JSON 예외도 재시도) |
| Start 4xx(그 밖), 점·End의 그 밖 4xx | 폐기하지 않고 **보류**하며 백오프. 화면에 '업로드 보류' 표시 |
| End 400·413·422 | `dead-letter.jsonl`로 격리하고 그 트립의 등록(registration)도 지운다(복구 루프 방지) |
| 트립 정보가 없는 점(고아) | `dead-letter.jsonl`로 격리 |

## 결정 근거

- 20m·5m·5초: FusedLocation은 갱신 주기 설정 API가 없고 주기도 문서에 없습니다(`docs/research/sdk-feasibility.md` §1). 20m 이상이면 무조건 채택해 고속 구간의 공백을 막고, 5초 조건은 5m 이상 움직였을 때만 걸어 정지 중 GPS 흔들림이 5초마다 점으로 쌓이는 것을 막습니다.
- 직선 변위 50m 시작: 주차장에서 제자리 흔들림은 경로 합이 쉽게 50m를 넘지만 직선 변위는 넘지 않습니다. 대기 샘플을 포함해 경로 앞부분을 잃지 않습니다.
- P 5분 종료와 P 이후 샘플 제외: 시동 신호가 Pleos SDK에 없어(heka `pleos-sdk-no-ignition-gear-fuel-type`) 기어와 앱 생명주기로만 종료를 판단합니다. 잠깐 P에 넣는 정차(택배·주유)는 트립을 끊지 않습니다. 종료 시각을 P 진입 전 마지막 샘플로 하려면 P 이후 샘플이 트립에 섞이면 안 됩니다.
- elapsedRealtime: 차량 시계는 부팅 직후·GPS 동기화 때 벽시계가 점프할 수 있어 판정에 쓰지 않습니다.
- 서버 발급 차량 ID: 앱에 박힌 pepper는 apk에서 꺼낼 수 있어 17자 VIN 해시를 역산할 수 있습니다. 비밀키를 서버에만 두고 HMAC하면 키 없이는 되돌릴 수 없고, 서버도 VIN을 저장하지 않습니다. 남는 위험은 서버 키 유출과 등록 요청 중 VIN이 서버 메모리를 지나간다는 점입니다.
- 속도 미수집: `CAR_SPEED`는 dangerous 권한이고, 트립 기록에 속도가 꼭 필요하지 않습니다(위치 변화로 거리·시간을 알 수 있음). 수집 목적이 생기면 그때 별도 결정으로 추가합니다.
- 업로드 멱등(`localId`): 응답이 유실돼 Start를 다시 보내도 트립이 둘로 갈라지지 않게 합니다.
- 백그라운드 수신은 Pleos 문서가 보장하지 않으므로(`docs/research/07-gaps-and-conflicts.md` #23) 포그라운드 서비스(`foregroundServiceType="location"`)로 상주시키고, 실측 결과는 `docs/sdk-check.md`에 기록합니다.

## 서버 API (`server/`)

Hono + `node:sqlite`(Node 22.13+ 내장), 검증은 `zod`. DB 경로는 `NUBI_DB`(기본 `server/data/nubi.sqlite`, `:memory:` 허용), 스키마는 `server/src/db/schema.ts`의 문자열 상수(`local_id` 열이 없던 기존 DB는 시작 때 `ALTER TABLE`로 보강하고, 단독 UNIQUE 인덱스는 `(vehicle_id, local_id)` 복합 UNIQUE로 옮긴다). 차량 ID 비밀키는 환경변수 `NUBI_VEHICLE_HMAC_KEY`. 요청 본문은 **1MB**까지(초과 413). 시각(`startedAt`·`ts`·`endedAt`)은 오프셋이 달라도 **UTC ISO로 정규화**해 저장.

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `POST /vehicles/register` | `{ vin }`(1~64자) | `200 { vehicleId }`(HMAC-SHA256 hex). VIN은 저장·로그·응답하지 않음. 오류 응답은 입력을 되돌려 주지 않음 |
| `POST /trips` | `{ localId, vehicleId, driverId, startedAt(ISO), odometerStartKm?: number\|null }` (id류는 1~128자) | 새로 만들면 `201 { tripId }`, 같은 `(vehicleId, localId)`가 이미 있으면 `200 { tripId }`(기존 것) |
| `POST /trips/:tripId/points` | `{ points: [{ seq:int, ts:ISO, lat, lon, headingDeg?: 0~360, confidence?, speedKph?(과거 호환, 앱은 안 보냄), gear?: 'P'\|'R'\|'N'\|'D'\|null }] }` | `200 { accepted, duplicated }`. `(tripId, seq)` 중복은 무시(멱등). 최대 500점, 초과 400. **종료된 트립에도 점을 받는다**(재시도 순서상 End보다 늦게 올 수 있음) |
| `POST /trips/:tripId/end` | `{ endedAt, odometerEndKm?: number\|null }` | `200 { tripId, pointCount, distanceM(하버사인 합), durationS }`. 이미 종료된 트립은 200으로 같은 요약(멱등). 종료 시각은 유지하되 `odometerEndKm`이 null이었고 요청에 값이 있으면 채움 |
| `GET /trips/:tripId` | | 요약(`localId` 포함) + `points` |
| `GET /trips?vehicleId=&limit=` | | `{ trips: [요약] }` 최신순 |

요약의 점 수·거리는 저장하지 않고 **조회 때 SQL 한 번**(`LAG` 윈도우 + 하버사인)으로 계산한다. 그래서 종료 뒤에 도착한 점도 응답·상세·목록에 항상 일치하게 반영되고, 목록 조회도 트립 수와 상관없이 쿼리 1회다(N+1 없음).

### 인증은 범위 밖 — 공개 배포 전 필수

현재 서버에는 인증·인가가 없습니다. `vehicleId`만 알면 누구나 위치 이력을 읽고 쓸 수 있습니다. **공개 배포 전에 반드시** 인증(기기·계정 토큰), 트립 소유 검증, rate limit, TLS 종단을 붙여야 합니다. 이번 단계는 로컬·에뮬레이터 검증용이며 `HOST` 기본값도 `127.0.0.1`입니다.

## 차량 앱 (`car/`)

- 매니페스트 권한: `pleos.car.permission.FUSED_LOCATION`(런타임), `CAR_INFO`, `CAR_DRIVE`, `android.car.permission.CAR_POWERTRAIN`(기어), `ACCESS_COARSE_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `INTERNET`. **`CAR_SPEED`는 없다.** `ACCESS_COARSE_LOCATION`을 남기는 이유: Android 14는 location 타입 포그라운드 서비스를 시작하려면 ACCESS_COARSE/FINE_LOCATION 중 하나가 필요하고 Pleos 위치 권한만으로는 앱이 죽는다(`docs/sdk-check.md` §3). 값은 Pleos FusedLocation에서만 읽는다. `distractionOptimized` meta-data와 회전식 컨트롤러(CCP) 미지원 선언은 차곡과 같다.
- 권한: 없으면 쓰임새 설명 카드 → 버튼으로 요청. 요청 뒤에도 거부되고 시스템이 더는 묻지 않으면(영구 거부) **'설정 열기'** 버튼으로 앱 설정 화면을 연다.
- `TripRecordingService`: `foregroundServiceType="location"`. FusedLocation 콜백·기어 콜백을 엔진에 넘긴다. `onDestroy`·`onTaskRemoved`에서 트립을 끝내고 `VehicleInfo.stop()`(`Vehicle.release()`)을 호출한다.
- `TripEngine`(Android 비의존, JVM 테스트): 상태기계·큐·업로드를 묶는다. 5초 tick은 RECORDING일 때만, 60초 업로드 타이머는 큐에 미전송분이 있을 때만 돈다(놀 때는 아무 타이머도 없음).
- `TripStateMachine`(순수 Kotlin): IDLE → RECORDING → ENDED. JVM 단위 테스트로 20.0m·5.0m·5,000ms·50.0m 경계를 검증.
- `Uploader`: 위 '서버 응답별 처리'를 구현. 큐·dead-letter·server-ids는 DEK(AES-GCM) 줄 단위 암호화. 생성자는 파일을 읽지 않고 `load()`를 워커에서 부른다.
- 기록 상태: `TripRecordingService`가 `startForeground`에 실패하면 `TripStatus.SERVICE_FAILED`를 영구 저장하고(SharedPreferences) 화면이 앞에 올 때(`onResume`) '기록이 멈췄습니다. 앱을 열어 두면 다시 시작합니다'와 '다시 시작' 버튼을 보이며 서비스 시작을 다시 시도한다. `FusedLocation.isSupported()`가 false이거나 초기화가 실패하면 `TripStatus.UNSUPPORTED`로 두고 콜백을 등록하지 않으며 '이 차량은 위치 기능을 지원하지 않습니다'를 보인다.
- 화면(`MainActivity`, 글자 위주, 1fps 이하 갱신): 권한 필요 / 대기 / 기록 중 / 종료됨, 현재 트립 샘플 수·거리(m)·마지막 업로드 결과(성공 N점 / 실패 / **업로드 보류**). 모든 문구는 `strings.xml`. 최상위에서 Back은 `moveTaskToBack(true)`.
- 주행 규제: `CarUxRestrictionsManager`를 `onResume`에 등록하고 `onPause`에 해제한다. `isRequiresDistractionOptimization()`이면 권한 카드·버튼을 숨기고 모든 문자열을 `getMaxRestrictedStringLength()`로 자른다. 규제 서비스 등록에 실패하면 실제 값을 알 수 없으므로 **fail-closed**(DO로 간주해 권한 카드·버튼 숨김), 등록에 성공하면 실제 값으로 갱신한다.
- debug 전용(`car/app/src/debug`): `nubi-debug://signal?reset=1&real=1&gear=P|R|N|D&now=<epoch ms>&flush=1&loc=<lat>,<lon>[,<heading>]&gpx=<assets 파일명>`, 평문 HTTP network security config, `SERVER_URL=http://10.0.2.2:8787`(`-Pnubi.serverPort`로 변경). release에는 넣지 않는다. `setClock`·`reset`·`flush` 같은 엔진의 debug 훅은 main에 있어도 `BuildConfig.DEBUG` 가드가 있어 release에서는 아무 일도 하지 않는다.

## 범위 밖

지도, 맵매칭, 행정구역, 공유, 계정·게스트, 생성형 AI 호출, 마이크 사용, 서버 인증(위 '공개 배포 전 필수').

## 완료 기준

`pnpm typecheck`, `pnpm server:test`, `./gradlew :app:testDebugUnitTest`, `pnpm e2e:car`(Maestro + 서버 검증: 30점·seq 연속·좌표·거리 725±10m·시간 29±3초·gear D·speed null) 2회 연속 통과.
