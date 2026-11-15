# feat/02 도로 색칠·완료율 — 사양

- 브랜치 `feat/02-road-coloring`, 분기점 `feat/01-trip-recording` 끝(266bf48). main 병합 보류.
- 결정 근거: heka `nubi-core-policy-decisions-2026-11-08`(도로명 단위), `nubi-decisions-osm-odbl-nospeed-paid-2026-11-08`(OSM+ODbL), `nubi-mapmatching-valhalla-colima-2026-11-09`(Valhalla 컨테이너). 기획서 `docs/plan.md` 5·6장과 맞춘다. 어긋나면 이 사양을 고치고 기획서에 반영한다.
- 완료 기준: 단위 테스트 + E2E(`pnpm e2e:car`가 도로 색칠 결과까지 검증) 2회 연속 통과.

## 1. 범위

| 포함 | 제외(다음 브랜치) |
|---|---|
| 서버: Valhalla 맵매칭 → way 인정 → 도로명 집계 → 완료율. 도로 DB(월간 스냅샷) 구축 스크립트. 조회 API 4개. 시연·검증용 지도 뷰어 HTML(서버가 정적 제공, debug) | 시군구 판정(feat/03), 바램·월간 재계산(feat/04 — 단 `first/last_driven_at`는 지금 저장), 게스트(feat/05), 공유 카드(feat/06), 지역 소개(feat/07) |
| 차량 앱: 트립 종료 후 매칭 결과 폴링 → "이번 주행 새 도로 N km · 전국 완료율 x.xx%(+y.yy)" 한 줄. 대기 화면에 전국 완료율 한 줄 | 차량 화면 지도(정차 중) — 이번엔 글자만 |
| 인정 규칙: 매칭 비율, 오도미터 대조(카페리·견인 제외) | 폰 앱 지도 열람(폰 브랜치) |

## 2. 용어

| 용어 | 정의 |
|---|---|
| 세그먼트(way) | OSM way 하나. 색칠·인정의 최소 단위. `way_id`로 식별 |
| 도로 키(road_key) | 세그먼트를 묶는 도로명 단위 키. 6-1 규칙 |
| 매칭 길이 | Valhalla가 그 way에 붙인 edge 길이의 합(m) |
| 커버리지 | `min(1, 매칭 길이 / way 길이)` |
| 인정 | 커버리지 ≥ 0.7 **또는** 매칭 길이 ≥ 500m(긴 way의 부분 주행) (가안) |
| 묶음(bucket) | 한 도로 안의 way를 **분리 구간 묶음**(주요 4등급 + link이면서 oneway — `yes`, `-1`, motorway(_link)의 암묵 oneway 포함)과 **양방향 묶음**으로 나눈 것. 묶음 상한 = 분리 묶음은 `Σ length_m / 2`, 양방향 묶음은 `Σ length_m` |
| 달린 길이(driven) | 묶음별로 `min(묶음 상한, Σ 인정 way의 커버리지 × length_m)`을 구해 더한 값. 도로별·전국 모두 이 정의 |
| 도로 총길이 | 그 도로의 묶음 상한 합(= `Σ eff_length_m`) |
| 도로 완주율 | `달린 길이 / 도로 총길이` |
| 완주 | 도로 완주율 ≥ 95% (가안) |
| 전국 완료율 | `Σ(도로별 달린 길이) / 분모`. **소수 4자리**(분모가 12만 km대라 2자리면 0.00이 됨). 화면은 1% 이상 2자리, 0.1% 이상 3자리, 그 밑 4자리 |
| 새 도로(newKm) | 트립 매칭 전후의 **전국 달린 길이 차이**(상한·1/2 적용 후). 실제 way 길이 합이 아니다. 따라서 `nationalPercentAfter − Before ≈ newKm / 분모`가 항상 성립 |
| 분모 | 도로 DB 스냅샷에서 **이름 또는 번호가 있는** 자동차 도로 총길이(6-2). 이름·번호 없는 way는 분자·분모 모두 제외 |
| 스냅샷 | 도로 DB의 월간 버전 `YYYYMM`. 완료율은 항상 현재 스냅샷 기준 |

## 3. 데이터·인프라

### 3-1. Valhalla
- 실행: Colima(`brew install colima docker`) + `ghcr.io/gis-ops/docker-valhalla/valhalla`(버전 고정, arm64 이미지 확인). 컨테이너 이름 `nubi-valhalla`, 포트 `8002`.
- 데이터: Geofabrik `south-korea-latest.osm.pbf` → `server/data/osm/`(git 제외). 타일은 `server/data/valhalla/`(git 제외). 빌드 옵션: elevation 끔, `serve_tiles` 켬.
- 설정: `trace_attributes` 요청은 `costing: auto`, `shape_match: map_snap`, `trace_options: { search_radius: 50, gps_accuracy: 10, breakage_distance: 2000 }`, `filters.attributes`에 `edge.way_id, edge.length, edge.names, edge.road_class, edge.begin_shape_index, edge.end_shape_index, matched.point, matched.type, matched.edge_index`. 요청당 점 ≤ 16,000, 초과 시 트립을 나눠 보낸다.
- 서버 환경변수 `NUBI_VALHALLA_URL`(기본 `http://127.0.0.1:8002`). 연결 실패 시 매칭 작업은 `failed(retryable)`로 두고 5분 간격 재시도(최대 24시간).
- 스크립트: `scripts/setup-valhalla.sh`(Colima 기동 → 이미지 받기 → pbf 다운로드 → 타일 빌드 → 컨테이너 기동 → `/status` 대기), `scripts/valhalla-up.sh`(이미 빌드된 타일로 기동만). E2E 스크립트는 `valhalla-up.sh`를 부른다.

### 3-2. 도로 DB (OSM 파생, ODbL)
- `scripts/build-road-db.mjs <pbf> <YYYYMM>`: `osmium tags-filter`로 `highway=motorway|trunk|primary|secondary|tertiary|unclassified|residential|*_link` 만 추출(`service, track, path, footway, cycleway, living_street, pedestrian` 제외) → `osmium export`(GeoJSONSeq) → SQLite `server/data/roads-YYYYMM.sqlite`.
- 테이블
  - `ways(way_id PK, road_key, highway, name, ref, length_m, oneway, eff_length_m, minlon, minlat, maxlon, maxlat, geom_json)` + R-tree `ways_rtree(way_id, minlon, maxlon, minlat, maxlat)`
  - `roads(road_key PK, display_name, highway_major, total_length_m, split_length_m, way_count, names_json)` — `split_length_m`은 분리 구간 묶음의 상한(= Σ eff_length_m of 분리 구간), 양방향 묶음의 상한은 `total_length_m − split_length_m`
  - `snapshot(month PK, built_at, pbf_name, pbf_timestamp, total_named_length_m, total_all_length_m, by_class_json)`
- 길이는 geom 좌표열의 하버사인 합(m). 출처 표기 "© OpenStreetMap contributors (ODbL)"를 뷰어·API 응답 `attribution` 필드에 넣는다.
- 서버 환경변수 `NUBI_ROADS_DB`(기본 최신 `server/data/roads-*.sqlite`). **도로 DB가 없으면 조회 API는 503, 매칭은 재시도 대기**이며, 테스트 픽스처(`server/test/fixtures/roads-test.sqlite`)로의 대체는 `NUBI_ROADS_DB`에 그 경로를 **명시**했을 때만 한다(조용한 대체 금지). 픽스처의 snapshot month는 실 DB와 구분되게 `209901`. 사용자 기록 DB(`nubi.sqlite`)와 **파일을 분리**한다(ODbL 집합 DB 분리 전제).
- oneway 판정: `oneway=yes` 또는 `-1`, 그리고 `motorway`·`motorway_link`는 태그가 없어도 oneway로 본다(OSM 기본값).

## 4. 처리 흐름 (서버)

1. `POST /trips/:id/end` 처리 후 매칭 작업을 큐에 넣는다(`trip_matching(trip_id PK, status: queued|running|done|failed, attempts, error, started_at, finished_at, result_json)`). 응답에 `matching: 'queued'`를 더한다. 트립 점이 20개 미만 또는 거리 100m 미만이면 `done(skipped: too_short)`.
2. 워커(프로세스 내 단일 소비자)가 트립 점(ts 순)을 Valhalla `trace_attributes`로 보낸다. 실패(네트워크·5xx)는 재시도, 4xx는 `failed(permanent)`로 기록.
3. 응답 edge를 `way_id`별로 합산 → 매칭 길이. 도로 DB에서 way 길이·road_key를 찾는다. **도로 DB에 없는 way_id**(service 등 제외 등급, 또는 pbf 버전 차이)는 `ignored_ways`에 세고 넘어간다.
4. **오도미터 대조**(5-4): `odoDelta = odometerEndKm − odometerStartKm`. **`odoDelta > 0`일 때만** 대조하고, 트립 GPS 길이(`distanceM`)가 `odoDelta × 1.1 + 1,000m`를 넘으면 트립을 `suspect`로 두고 **인정하지 않는다**(사유 `odometer_mismatch`). 시작·종료 중 하나라도 null이거나 `odoDelta ≤ 0`(증가량 0 포함, 에뮬레이터는 둘 다 0)이면 건너뛴다.
5. 인정 판정(2장) → `driven_ways(vehicle_id, way_id, coverage, first_driven_at, last_driven_at, trip_id_first, snapshot_month)`에 upsert. 커버리지는 더 큰 값으로 갱신, `last_driven_at`은 트립 종료 시각.
6. 집계는 조회 시 SQL로 계산한다(`driven_ways ⨝ ways ⨝ roads`). 결과 요약을 `trip_matching.result_json`에 저장: `{ newWays, newKm, roadsTouched: [road_key], nationalPercentBefore, nationalPercentAfter, suspect, ignoredWays }`.

## 5. API

| 호출 | 응답 |
|---|---|
| `GET /trips/:id/matching` | `{ status, attempts, startedAt, finishedAt, result?: {...4장 6}, error? }`. `error`는 분류와 코드만(`retryable:network`·`permanent:http_400`·`retryable:roads_db_unavailable` 등). 메시지는 서버 로그에만 남긴다 |
| `GET /coverage/summary?vehicleId=` | `{ snapshotMonth, nationalPercent(소수 2자리), drivenKm, totalKm, roadsCompleted, roadsStarted, attribution }` |
| `GET /coverage/roads?vehicleId=&sort=percent|recent|length&limit=&offset=&q=` | `{ items: [{ roadKey, displayName, highway, names, namesTotal, drivenM, totalM, percent, completed, lastDrivenAt }], total }`. `names`는 최대 20개, `namesTotal`은 저장된 거리명 전체 개수(`names_json` 길이, 최대 200)라 화면의 '외 N'은 `namesTotal − 1`로 센다 |
| `GET /coverage/segments?vehicleId=&bbox=minlon,minlat,maxlon,maxlat` | GeoJSON FeatureCollection. feature 속성 `wayId, roadKey, displayName, coverage, lastDrivenAt`. bbox 필수, 한 변 ≤ 1도, 최대 5,000개(초과 시 `truncated: true`) |
| `GET /viewer?vehicleId=` (debug·시연. `NUBI_VIEWER=1`이거나 `NODE_ENV`가 production이 아닐 때만 라우트를 등록) | MapLibre GL JS(CDN, 버전 고정 + SRI `integrity`) + OSM 래스터 타일(개발용, 출처 표기) 위에 `/coverage/segments` 를 그리는 정적 HTML. 완료율·도로 상위 10개 표시 |

- vehicleId는 feat/01의 alias 규칙을 따른다(alias로 이어진 트립 포함). 인증은 여전히 범위 밖(공개 배포 전 필수).
- 모든 응답에 `snapshotMonth`.

## 6. 규칙 상세

### 6-1. 도로 키와 표시 이름
| 조건 | road_key | display_name |
|---|---|---|
| `ref` 있음, `highway ∈ motorway(_link)` | `mw:{ref}` | `{name}`(없으면 `고속도로 {ref}`) |
| `ref` 있음, `highway ∈ trunk/primary(_link)` | `nr:{ref}` | `국도 {ref}호선`(`name`이 있으면 `국도 {ref}호선 · {name}` 대신 `name`을 보조 표기) |
| `ref` 있음, `highway ∈ secondary/tertiary(_link)` | `lr:{ref}` | `지방도 {ref}호선` |
| `ref` 없음, `name` 있음 | `nm:{name 정규화}` | `{name}` |
| 둘 다 없음 | `unnamed:{way_id}` | — (분자·분모 제외, `ignored_unnamed`로 집계만) |
- `ref`가 `;`로 여러 개면 첫 값. `_link`는 본선과 같은 키. 정규화: 공백 제거, 전각→반각.
- `unclassified`·`residential`에 붙은 `ref`는 무시하고 이름 규칙으로 간다(스모크 실측 반영).
- `nr:`·`lr:`·`mw:` 도로는 구간마다 거리명이 다르므로(예: 국도 31호선의 서울 구간 = 세종대로) `roads.names_json`에 그 도로를 이루는 way의 `name` 상위 200개(길이 순)를 DB에 저장하고, API `names`는 상위 20개만 내려 준다(`q`가 있으면 검색어에 걸린 이름을 앞에 둔다). 표시는 `국도 31호선 · 세종대로 외 N`. 사용자가 거리명으로 찾을 수 있게 `GET /coverage/roads?q=`는 `display_name`과 `names`를 함께 검색한다.
- 같은 이름의 다른 도로(예: 여러 도시의 '중앙로')가 하나로 묶이는 문제는 **알려진 한계**로 사양에 적고, feat/03 이후 시군구 접두를 붙일지 결정(기획서 15장 항목).

### 6-2. 분모
- `snapshot.total_named_length_m` = `Σ ways.length_m where road_key not like 'unnamed:%'`.
- 참고 병기: 국토부 개통연장 107,852km는 API에 넣지 않고 기획서에만.

### 6-3. 양방향·중복·분리 차로
- 같은 way를 반대 방향으로 달려도 1회. 같은 트립 안에서 왕복해도 매칭 길이는 way 길이로 상한.
- **분리 차로(상·하행이 별도 way)**: 도로 DB에 `oneway` 태그를 저장하고, `highway ∈ motorway·trunk·primary·secondary(+link)`이면서 `oneway=yes`인 way는 **도로 총길이·분모·인정 길이 계산에서 길이의 1/2로 센다**(상·하행 한 쌍 = 실제 도로 길이 1배라는 가정). 한 방향만 달려도 그 도로는 100%에 도달할 수 있다. `tertiary` 이하 등급의 일방통행은 짝이 없는 경우가 많아 그대로 1배로 센다. (가안 — 2026-11-09 리뷰 반영. 정확한 짝짓기는 확장 과제, 10장)
- **Valhalla 요청 분할**: 점 16,000개 **또는 누적 거리 150km**를 넘기 전에 트립을 나눠 보낸다(Valhalla 기본 `max_distance` 200km 한도).

### 6-4. 매칭 실패·부분 실패
- Valhalla가 `matched.type = unmatched`로 돌려준 점 비율이 50%를 넘으면 트립을 `low_confidence`로 표시하고 인정하지 않는다(가안). 결과에 사유 기록.

## 7. 차량 앱

- 트립 종료 후 `GET /trips/:id/matching`을 3초 간격 최대 60초 폴링(서비스 워커, 메인 스레드 아님). `done`이면 종료 화면에 한 줄 추가: `새 도로 {newKm}km · 전국 {after}% (+{delta})`. `skipped/suspect/low_confidence/failed`이면 `이번 주행은 집계되지 않았어요`(사유는 debug 빌드에서만 괄호 표기).
- 대기 화면: 서비스 시작 때 `GET /coverage/summary`를 1회 받아 `전국 {percent}% 달렸어요` 표시. 실패 시 생략(크래시 금지).
- 주행 규제 중에도 글자만이라 추가 처리 없음(문자열 길이 제한은 feat/01 규칙 그대로).
- **숫자 표시는 기어 기준**: 완료율·새 도로·샘플 수·거리 같은 숫자는 **기어가 P일 때만** 보인다(상태기계 상태와 무관). 기어가 D·R·N이면 상태 문구("기록 중"/"대기")와 마지막 업로드 결과만. 기어를 못 읽는(null) 차량은 상태기계가 RECORDING이 아닐 때만 숫자를 보인다. (Pleos 심사의 '주행 중 게임 요소' 거절 사유 회피.) 샘플 수·거리도 release·debug 모두 같은 기어 규칙(P일 때만)으로 보이고, 1초 갱신 루프는 두 빌드가 동일하다.
- 업로드 결과 문구: End만 보낸 경우 "성공: 0점" 대신 "종료 전송 완료"로 표시한다.
- 전국 완료율 조회는 마지막 성공 값을 로컬(SharedPreferences)에 저장해 오프라인·실패 시에도 보이고, 실패 시 30초 뒤 1회 재시도. 폴링은 시도 횟수가 아니라 **시작 시각 기준 60초** 마감.

## 8. 테스트·E2E

- 서버 단위: Valhalla 응답 **픽스처**(`server/test/fixtures/valhalla-e2e-north.json`, 실제 응답을 저장)로 매칭 파이프라인 전체(합산·인정·오도미터 대조·low_confidence·unnamed 제외·집계 SQL)를 검증. 도로 DB는 테스트용 소형 sqlite(`server/test/fixtures/roads-test.sqlite`, 세종대로 일대 way 수십 개)를 스크립트로 생성해 커밋(크기 < 1MB).
- 차량 단위: 폴링·표시 문자열 생성.
- E2E(`pnpm e2e:car`): 기존 feat/01 flow(GPX `e2e-north` 30점)는 그대로 두고 **두 번째 flow `road-coloring.yaml`** 을 추가한다. 새 GPX `e2e-sejong.gpx`는 도로 DB(`roads-test.sqlite`)의 `nm:세종대로`/`nr:31` way 기하에서 **차로 중심선을 따라 약 25m 간격으로 생성**(광화문 → 숭례문 방향 약 1.5km, 점 60개, 고정 시드의 ±3m 지터)해 `car/app/src/debug/assets/`에 커밋하고, 생성 스크립트 `scripts/make-gpx-from-road.mjs`도 커밋한다. 기존 `e2e-north`는 골목에 매칭되므로 도로 색칠 단언에 쓰지 않는다.
- `valhalla-up.sh`로 실제 Valhalla 기동, 서버 도로 DB는 전국(`server/data/roads-*.sqlite`) 전제다. 없으면 서버는 503이며 픽스처는 `NUBI_ROADS_DB`에 명시했을 때만 쓰고, 그 경우 `verify-trip.mjs`가 경고 후 도로 색칠 검증을 중단한다. `scripts/verify-trip.mjs`에 두 번째 트립 단언 추가: `matching.status == done`, `newKm ≥ 1.0`, `coverage/roads`에 `roadKey == 'nr:31'`이고 `names`에 `세종대로`가 포함된 항목, `coverage/summary.nationalPercent > 0`, `coverage/segments`(bbox = GPX 범위) feature ≥ 5, 첫 트립(`e2e-north`)의 결과는 `done`이되 `newKm`은 0 이상(골목 매칭이라 작을 수 있음). 차량 화면 Maestro: `새 도로 .*km` 보임. **2회 연속 통과(재시도 없는 통과만 인정, 아래 재시도 규칙)**.
- 실제 Valhalla 응답은 결정적이므로 E2E 기대값은 1회 실측 후 ±10% 허용으로 고정한다.
- 실측(2026-11-09, 스모크): edge 17개·851m, unmatched 1점, `edge.length` 단위 km, service 등급 way 2개는 도로 DB에 없어 `ignored_ways`. 전국 도로 DB: way 734,533·road 79,478, 총 227,980km, **이름 있는 길이 140,444km(분리 차로 1/2 적용 전) → 적용 후 분모 122,422km**, unnamed 길이 비율 38.4%, 동명이로(`nm:` 키 범위 대각선 > 50km) 3,668개(4.7%). 기획서 6-3·15장에 반영할 것.

## 9. 기준값 (가안은 기획서 14장에 반영)

| 항목 | 값 | 상태 |
|---|---|---|
| search_radius / gps_accuracy / breakage_distance | 50m / 10m / 2,000m | 가안 |
| 인정 임계 | 커버리지 0.7 또는 매칭 500m | 가안 |
| 완주 | 95% | 결정 |
| 짧은 트립 제외 | 20점 미만 또는 100m 미만 | 가안 |
| 오도미터 대조 | GPS 길이 > odo×1.1 + 1km → 제외 | 가안 |
| low_confidence | unmatched 점 > 50% | 가안 |
| 포함 등급 | motorway·trunk·primary·secondary·tertiary·unclassified·residential (+link) | 결정 |
| 재시도 | 5분 간격, 최대 24h | 가안 |
| segments 최대 | 5,000 feature, bbox 한 변 ≤ 1° | 가안 |

## 10. 확인이 필요한 것 · 알려진 한계
- **도로 키의 지역 범위**: 지방도 번호는 시도마다 겹치고(같은 '지방도 7호선'이 여러 도에 있음), 도로명도 시군구마다 겹친다(전국 `nm:` 키의 4.7%가 50km 넘게 흩어짐). 1단계는 전국 통합 키로 가고, **feat/03(시군구 판정)에서 지방도는 (시도, 번호), 도로명은 (시군구, 이름)으로 키를 바꾼다**. 그 전까지는 기획서 15장에 한계로 적는다.
- 분리 차로 1/2 규칙은 근사다. 상·하행 way를 기하로 짝짓는 정확한 방식은 확장 과제.
- Valhalla arm64 이미지의 정확한 태그와 한국 타일 빌드 시간·용량(설치 때 기록).
- OSM 한국 `ref`·`name` 채움률(도로 DB 빌드 때 통계로 기록: unnamed 비율).
- 동명이로 문제의 규모(같은 name의 road_key가 몇 개 시군구에 걸치는지) — 빌드 통계로 기록.
- OSM 래스터 타일을 시연 뷰어에 쓰는 것은 개발용에 한함(OSMF 타일 정책). 배포 시 자체 타일 또는 유료 타일.

## 11. 구현 결과와 가안(구현자) — 2026-11-09, 리뷰 반영 2026-11-10

구현 위치: 서버 `server/src/roads/`(도로 DB 접근·집계 SQL), `server/src/matching/`(Valhalla·파이프라인·워커), `server/src/routes/coverage.ts`, `server/src/viewer/`. 도로 DB 규칙(분류·oneway·유효 길이·names_json·스키마)은 `scripts/road-rules.mjs`에 한 곳에 두고 빌더와 서버 테스트 도구가 같이 쓴다. 차량 `trip/Coverage.kt`, `trip/TripStatus.kt`(`numbersVisible`), `MainActivity`. E2E `scripts/e2e-car.sh`·`verify-trip.mjs`(`--pick`·`--road-coloring`)·`scripts/make-gpx-from-road.mjs`.

**사양에서 달라진 점·가안(구현자)** (2·3-2·5·7장으로 승격된 항목 — 묶음별 상한, newKm 정의, 소수 4자리, `names_json` 200/20, 503·픽스처 명시, 기어 P 숫자 규칙, 60초 시작 기준 폴링, 캐시·재시도 — 은 이 장에서 뺐다)
- **`roads.split_length_m` 열 추가(3-2)**: 묶음별 상한을 SQL 한 번으로 구하려고 분리 구간 묶음의 상한을 열로 둔다(양방향 상한 = `total_length_m − split_length_m`). 이 열이 없는 옛 도로 DB는 서버가 열지 않는다(재빌드 필요, 조회 503).
- **way의 묶음 판정**: DB에는 `eff_length_m < length_m`이면 분리 구간이다(주요 4등급 + link이면서 oneway). `ways.oneway`에는 `yes`·`-1`·`implicit`(motorway 암묵)·태그 원문을 저장한다. 명시적 `oneway=no`는 motorway의 암묵 규칙보다 우선한다.
- **Valhalla 분할**: 한 걸음이 `breakage_distance`(2,000m)를 넘는 점프에서 조각을 끊고(겹치는 점 없음), 점 16,000개·누적 150km에서는 점 하나를 겹쳐 끊는다. 점프 사이에 외따로 남은 점은 요청에 못 들어가므로 unmatched로 센다.
- `trip_matching`에 `queued_at` 열 추가(24시간 재시도 한도 기준). 실패 상태 `error`는 `retryable:<코드>`·`permanent:<코드>`. 매칭 응답에 `startedAt`·`finishedAt`. `driven_ways` 갱신과 `status = done`은 같은 트랜잭션이다. `trip_id_first`는 `first_driven_at`이 더 이른 값으로 바뀔 때 함께 바뀐다.
- 결과 `result_json`에 `outcome`(`counted`·`skipped`·`suspect`·`low_confidence`)·`reason`·`ignoredUnnamed`·`matchedKm`·`unmatchedRatio`를 더했다. 건너뜀·의심·낮은 신뢰도도 `status = done`이다. 오도미터 대조는 Valhalla 호출 전에 한다(의심이면 호출하지 않음).
- `POST /trips/:id/end` 응답의 `matching`은 항상 `'queued'`(같은 End 재전송에도 같은 본문을 주려는 멱등성). 실제 상태는 `GET /trips/:id/matching`. 매칭 요청이 없는 트립은 404.
- 사용자 DB 연결에 도로 DB를 `mode=ro`로 ATTACH해 같은 연결에서 집계 SQL을 돌린다(파일은 분리 유지).
- 차량 앱: 영구 실패가 아닌 `failed(retryable)`는 계속 폴링하고, 시작 시각 기준 60초가 지나도 끝나지 않으면 줄을 보이지 않는다. 새 트립이 시작되면(상태기계 Started, 기어 null 차량의 변위 50m 재개 포함) 이전 트립의 종료 줄과 진행 중이던 폴링을 지운다. 종료 알림은 `Uploader.onTripEnded`(End 업로드 성공 시)로 받는다.
- 샘플·거리 숫자는 release에서도 같은 기어 규칙으로 보인다(debug 전용은 아님). 1초 갱신 루프는 상태 문구용으로 두 빌드 모두 돈다. 가안.
- debug 주입에 `park=1`(gpx 재생이 끝나면 기어 P)을 더했다. 숫자가 기어 P에서만 보이므로 E2E가 재생 끝을 화면으로 알기 위한 것이다.
- E2E GPX는 연속 두 점 사이가 21m 아래가 되면(차량 앱 채택 기준 20m) 시드를 하나씩 올려 다시 뽑는다(기본 시드 20261109 → 20261130 채택, 결정적). 경로는 국도 48호선 하행 → 국도 31호선 → 세종대로(`nr:48`·`nr:31`·`nm:세종대로`) 약 1.48km, 60점.
- E2E는 설치 뒤 `pm clear`, 검증 대상 트립은 GPX의 점 수·첫/끝 좌표로 고르고 후보가 여럿이면 가장 늦게 시작한 것을 쓴다. flow 재시도는 1회차 트립이 서버에 **없을 때만**(Maestro 드라이버 중단 등) 허용하고(시도별 출력·logcat 보존), 트립이 이미 생겼으면 재시도하지 않고 실패로 끝낸다(화면 단언 실패를 가리지 않음). 재시도한 실행은 통과 출력과 `summary.json`에 `retried=<flow>`가 남고, **2회 연속 통과 기준에는 재시도 없는 통과만** 인정한다. 완료율 정합 허용 오차는 `1e-6 + 0.0005/totalKm`. 단언에 `(nationalPercentAfter − Before)/100 ≈ newKm / totalKm`(±1e-6)과 차량 화면 `전국 .*% 달렸어요`(P 상태)가 더해졌다. 도로 DB는 `NUBI_ROADS_DB`로 항상 명시해 서버에 넘긴다.
- 호스트의 8787 포트를 다른 프로젝트가 쓰고 있으면 `PORT=8788 pnpm e2e:car`로 돌린다.

**실측 갱신**은 `docs/sdk-check.md` 7절(도로 DB 재빌드 뒤 분모, nr:48 수동 확인, E2E 실측)에 있다.
