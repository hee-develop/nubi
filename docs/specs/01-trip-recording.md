# 01. 주행 기록(트립 레코딩)

차량 앱이 주행 위치를 자동으로 기록해 서버에 트립으로 저장하는 기반 기능입니다. 아래 수치는 모두 **가안**이며 실주행 데이터를 보고 조정합니다.

## 기준값(가안)

| 항목 | 값 |
|---|---|
| 위치 샘플 채택 | 직전 채택 샘플에서 **5초 이상 또는 20m 이상** 떨어진 것만 저장 |
| 트립 시작 | 앱이 위치를 받기 시작한 뒤 누적 이동 **50m** 도달 시(그 전 샘플도 포함해 시작) |
| 트립 종료 | 기어 **P 진입 후 5분** 유지, 또는 앱 Suspend/onStop(종료 시각 = 마지막 샘플 시각) |
| 업로드 | **60초마다 또는 100점** 쌓이면 배치 전송. 실패 시 로컬 큐에 두고 재시도(지수 백오프 최대 5분). 트립 종료 때 전량 flush |
| 차량 ID | Vehicle SDK `CarInfo.getVINInfo`(권한 `pleos.car.permission.CAR_INFO`)의 **SHA-256 해시**. 실패·미지원이면 최초 실행 때 만든 UUID를 영구 저장해 사용 |
| 운전자 ID | 이번 단계에서는 차량 ID와 동일(계정·게스트는 뒤 단계) |
| 오도미터 | 트립 시작·종료 때 `Odometer.getCurrentDistanceDriven`(권한 `pleos.car.permission.CAR_DRIVE`) 값을 km로 저장. 실패하면 null |
| 속도 | AAOS `PERF_VEHICLE_SPEED`를 읽을 수 있으면 샘플에 kph로 포함. 권한 거부·미지원이면 null(앱은 죽지 않음) |
| 기어 | AAOS `GEAR_SELECTION`(차곡과 같은 방식). 샘플마다 P/R/N/D 중 하나 또는 null |

## 결정 근거

- 5초·20m: FusedLocation은 갱신 주기 설정 API가 없고 주기도 문서에 없습니다(`docs/research/sdk-feasibility.md` §1). 시간과 거리 중 하나만 넘어도 채택하면 정차 중 중복은 줄고(5초 간격 상한) 고속 구간의 공백도 막습니다.
- 50m 시작: 주차장 내 GPS 흔들림으로 트립이 생기는 것을 막습니다. 시작 전 샘플을 포함해 경로 앞부분을 잃지 않습니다.
- P 5분 종료: 시동 신호가 Pleos SDK에 없어(heka `pleos-sdk-no-ignition-gear-fuel-type`) 기어와 앱 생명주기로만 종료를 판단합니다. 잠깐 P에 넣는 정차(택배·주유)는 트립을 끊지 않습니다.
- 차량 ID 해시: VIN 원문을 서버·로그에 남기지 않습니다.
- 속도·기어는 Vehicle SDK에 없어 AAOS `CarPropertyManager`로 읽습니다.
- 백그라운드 수신은 Pleos 문서가 보장하지 않으므로(`docs/research/07-gaps-and-conflicts.md` #23) 포그라운드 서비스(`foregroundServiceType="location"`)로 상주시키고, 실측 결과는 `docs/sdk-check.md`에 기록합니다.

## 서버 API (`server/`)

Hono + `node:sqlite`(Node 22.13+ 내장), 검증은 `zod`. DB 경로는 `NUBI_DB`(기본 `server/data/nubi.sqlite`, `:memory:` 허용), 스키마는 `server/src/db/schema.sql`.

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `POST /trips` | `{ vehicleId, driverId, startedAt(ISO), odometerStartKm?: number\|null }` | `201 { tripId }` |
| `POST /trips/:tripId/points` | `{ points: [{ seq:int, ts:ISO, lat, lon, headingDeg?, confidence?, speedKph?, gear?: 'P'\|'R'\|'N'\|'D'\|null }] }` | `200 { accepted, duplicated }`. `(tripId, seq)` 중복은 무시(멱등). 최대 500점, 초과 400 |
| `POST /trips/:tripId/end` | `{ endedAt, odometerEndKm?: number\|null }` | `200 { tripId, pointCount, distanceM(하버사인 합), durationS }`. 이미 종료된 트립은 200으로 같은 요약(멱등) |
| `GET /trips/:tripId` | | 요약 + `points` |
| `GET /trips?vehicleId=&limit=` | | `{ trips: [요약] }` 최신순 |

## 차량 앱 (`car/`)

- 매니페스트 권한: `pleos.car.permission.FUSED_LOCATION`(런타임), `CAR_INFO`, `CAR_DRIVE`, `android.car.permission.CAR_POWERTRAIN`(기어), `android.car.permission.CAR_SPEED`(속도), `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `INTERNET`. `distractionOptimized` meta-data와 회전식 컨트롤러(CCP) 미지원 선언은 차곡과 같습니다.
- `TripRecordingService`: `foregroundServiceType="location"`. FusedLocation 콜백, 샘플 채택, 트립 상태기계, 로컬 큐(앱 내부 저장소 JSON Lines), 업로드.
- `TripStateMachine`(순수 Kotlin): IDLE → RECORDING(50m) → ENDED(P 5분 또는 stop). JVM 단위 테스트로 검증.
- 화면(`MainActivity`, 글자 위주, 1fps 이하 갱신): 권한 필요 / 대기 / 기록 중 / 종료됨, 현재 트립 샘플 수·거리(m)·마지막 업로드 결과. 권한이 없으면 쓰임새 설명 카드 후 요청.
- debug 전용(`car/app/src/debug`): `nubi-debug://signal?gear=P|D&speed=<kph>&now=<epoch ms>&flush=1&loc=<lat>,<lon>[,<heading>]&gpx=<assets 파일명>`, 평문 HTTP network security config, `SERVER_URL=http://10.0.2.2:8787`(`-Pnubi.serverPort`로 변경). release에는 넣지 않습니다.

## 범위 밖

지도, 맵매칭, 행정구역, 공유, 계정·게스트, 생성형 AI 호출, 마이크 사용.

## 완료 기준

`pnpm typecheck`, `pnpm server:test`, `./gradlew :app:testDebugUnitTest`, `pnpm e2e:car`(Maestro + 서버 검증) 통과.
