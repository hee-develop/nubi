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
| 도로 완주율 | `Σ(인정 way의 커버리지 × way 길이) / 도로 총길이` |
| 완주 | 도로 완주율 ≥ 95% (가안) |
| 전국 완료율 | `Σ(인정 way의 커버리지 × way 길이) / 분모` |
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
  - `roads(road_key PK, display_name, highway_major, total_length_m, way_count, names_json)`
  - `snapshot(month PK, built_at, pbf_name, pbf_timestamp, total_named_length_m, total_all_length_m, by_class_json)`
- 길이는 geom 좌표열의 하버사인 합(m). 출처 표기 "© OpenStreetMap contributors (ODbL)"를 뷰어·API 응답 `attribution` 필드에 넣는다.
- 서버 환경변수 `NUBI_ROADS_DB`(기본 최신 `roads-*.sqlite`). 사용자 기록 DB(`nubi.sqlite`)와 **파일을 분리**한다(ODbL 집합 DB 분리 전제).

## 4. 처리 흐름 (서버)

1. `POST /trips/:id/end` 처리 후 매칭 작업을 큐에 넣는다(`trip_matching(trip_id PK, status: queued|running|done|failed, attempts, error, started_at, finished_at, result_json)`). 응답에 `matching: 'queued'`를 더한다. 트립 점이 20개 미만 또는 거리 100m 미만이면 `done(skipped: too_short)`.
2. 워커(프로세스 내 단일 소비자)가 트립 점(ts 순)을 Valhalla `trace_attributes`로 보낸다. 실패(네트워크·5xx)는 재시도, 4xx는 `failed(permanent)`로 기록.
3. 응답 edge를 `way_id`별로 합산 → 매칭 길이. 도로 DB에서 way 길이·road_key를 찾는다. **도로 DB에 없는 way_id**(service 등 제외 등급, 또는 pbf 버전 차이)는 `ignored_ways`에 세고 넘어간다.
4. **오도미터 대조**(5-4): `odometerEndKm - odometerStartKm`이 양수이고 트립 GPS 길이(`distanceM`)가 `odoDelta × 1.1 + 1,000m`를 넘으면 트립을 `suspect`로 두고 **인정하지 않는다**(결과에 사유 `odometer_mismatch`). 오도미터가 null·0·감소면 대조를 건너뛴다(에뮬레이터는 0).
5. 인정 판정(2장) → `driven_ways(vehicle_id, way_id, coverage, first_driven_at, last_driven_at, trip_id_first, snapshot_month)`에 upsert. 커버리지는 더 큰 값으로 갱신, `last_driven_at`은 트립 종료 시각.
6. 집계는 조회 시 SQL로 계산한다(`driven_ways ⨝ ways ⨝ roads`). 결과 요약을 `trip_matching.result_json`에 저장: `{ newWays, newKm, roadsTouched: [road_key], nationalPercentBefore, nationalPercentAfter, suspect, ignoredWays }`.

## 5. API

| 호출 | 응답 |
|---|---|
| `GET /trips/:id/matching` | `{ status, attempts, result?: {...4장 6}, error? }` |
| `GET /coverage/summary?vehicleId=` | `{ snapshotMonth, nationalPercent(소수 2자리), drivenKm, totalKm, roadsCompleted, roadsStarted, attribution }` |
| `GET /coverage/roads?vehicleId=&sort=percent|recent|length&limit=&offset=` | `{ items: [{ roadKey, displayName, highway, drivenM, totalM, percent, completed, lastDrivenAt }], total }` |
| `GET /coverage/segments?vehicleId=&bbox=minlon,minlat,maxlon,maxlat` | GeoJSON FeatureCollection. feature 속성 `wayId, roadKey, displayName, coverage, lastDrivenAt`. bbox 필수, 한 변 ≤ 1도, 최대 5,000개(초과 시 `truncated: true`) |
| `GET /viewer?vehicleId=` (debug·시연) | MapLibre GL JS(CDN) + OSM 래스터 타일(개발용, 출처 표기) 위에 `/coverage/segments` 를 그리는 정적 HTML. 완료율·도로 상위 10개 표시 |

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
- **주행 중(기어 D·R·N) 화면에는 완료율·거리 같은 숫자를 갱신해 보이지 않는다**(Pleos 심사의 '주행 중 게임 요소' 거절 사유 회피). 숫자는 대기(P)·종료 화면에서만. 기록 중 화면은 "기록 중" 상태 문구와 마지막 업로드 결과만 둔다(샘플 수·거리의 1초 갱신은 debug 빌드에서만).

## 8. 테스트·E2E

- 서버 단위: Valhalla 응답 **픽스처**(`server/test/fixtures/valhalla-e2e-north.json`, 실제 응답을 저장)로 매칭 파이프라인 전체(합산·인정·오도미터 대조·low_confidence·unnamed 제외·집계 SQL)를 검증. 도로 DB는 테스트용 소형 sqlite(`server/test/fixtures/roads-test.sqlite`, 세종대로 일대 way 수십 개)를 스크립트로 생성해 커밋(크기 < 1MB).
- 차량 단위: 폴링·표시 문자열 생성.
- E2E(`pnpm e2e:car`): 기존 feat/01 flow(GPX `e2e-north` 30점)는 그대로 두고 **두 번째 flow `road-coloring.yaml`** 을 추가한다. 새 GPX `e2e-sejong.gpx`는 도로 DB(`roads-test.sqlite`)의 `nm:세종대로`/`nr:31` way 기하에서 **차로 중심선을 따라 약 25m 간격으로 생성**(광화문 → 숭례문 방향 약 1.5km, 점 60개, 고정 시드의 ±3m 지터)해 `car/app/src/debug/assets/`에 커밋하고, 생성 스크립트 `scripts/make-gpx-from-road.mjs`도 커밋한다. 기존 `e2e-north`는 골목에 매칭되므로 도로 색칠 단언에 쓰지 않는다.
- `valhalla-up.sh`로 실제 Valhalla 기동, 서버 도로 DB는 전국(`server/data/roads-*.sqlite`)이 있으면 그것, 없으면 테스트 DB. `scripts/verify-trip.mjs`에 두 번째 트립 단언 추가: `matching.status == done`, `newKm ≥ 1.0`, `coverage/roads`에 `roadKey == 'nr:31'`이고 `names`에 `세종대로`가 포함된 항목, `coverage/summary.nationalPercent > 0`, `coverage/segments`(bbox = GPX 범위) feature ≥ 5, 첫 트립(`e2e-north`)의 결과는 `done`이되 `newKm`은 0 이상(골목 매칭이라 작을 수 있음). 차량 화면 Maestro: `새 도로 .*km` 보임. **2회 연속 통과**.
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

## 11. 구현 결과와 가안(구현자) — 2026-11-09

구현 위치: 서버 `server/src/roads/`(도로 DB 접근·집계 SQL), `server/src/matching/`(Valhalla·파이프라인·워커), `server/src/routes/coverage.ts`, `server/src/viewer/`. 차량 `trip/Coverage.kt`, `MainActivity`. E2E `scripts/e2e-car.sh`·`verify-trip.mjs --road-coloring`·`scripts/make-gpx-from-road.mjs`.

**사양에서 달라진 점·가안(구현자)**
- **분리 차로 계산(6-3 해석)**: `ways.eff_length_m`(주요 4등급 oneway=yes면 길이/2)을 `roads.total_length_m`·`snapshot.total_named_length_m`에 쓴다. 달린 길이는 **실제 `length_m` × 커버리지**이고 도로별로 총길이를 넘지 않게 자른다(`MIN(driven, total)`). 사양 문구 그대로 인정 길이도 1/2로 세면 한 방향만 달렸을 때 50%가 되어 "한 방향만 달려도 100%"와 모순이라 이렇게 풀었다. 전국 분모는 140,444km에서 **122,421.7km**로 바뀐다(분리 차로 1/2 적용). 한 방향만 달려도 100%·tertiary 이하 1배·양방향 상한은 단위 테스트로 검증.
- **`names_json` 상위 200개 저장·API 20개 반환**: 국도 31호선 전국 DB에는 구간 거리명이 83개이고 세종대로는 길이 순 20위 안에 들지 않아 20개 저장으로는 검색·E2E 단언이 실패했다. 검색(`q`)은 저장된 200개 전체를 보고, 응답 `names`는 `q`에 걸린 거리명을 앞에 둔 최대 20개다. 그래서 E2E의 `names`에 세종대로 단언은 `GET /coverage/roads?q=세종대로` 결과로 한다.
- **완료율 소수 4자리**(5장은 2자리): 전국 분모가 12만 km대라 1.5km 주행이 2자리에서는 0.00이 된다. 차량 화면은 값이 1% 이상이면 2자리, 0.1% 이상이면 3자리, 그보다 작으면 4자리로 보인다.
- `trip_matching`에 `queued_at` 열 추가(24시간 재시도 한도 기준). 실패 상태 `error`는 `retryable: …`(재시도 대기) 또는 `permanent: …`. 매칭 응답에 `startedAt`·`finishedAt`.
- 결과 `result_json`에 `outcome`(`counted`·`skipped`·`suspect`·`low_confidence`)·`reason`·`ignoredUnnamed`·`matchedKm`·`unmatchedRatio`를 더했다. 건너뜀·의심·낮은 신뢰도도 `status = done`이다. 오도미터 대조는 Valhalla 호출 전에 한다(의심이면 호출하지 않음).
- `POST /trips/:id/end` 응답의 `matching`은 항상 `'queued'`(같은 End 재전송에도 같은 본문을 주려는 멱등성). 실제 상태는 `GET /trips/:id/matching`. 매칭 요청이 없는 트립은 404.
- 도로 DB가 없으면 조회 API는 503, 매칭 작업은 재시도 대기. 서버 기본 도로 DB 선택은 `NUBI_ROADS_DB` → 최신 `server/data/roads-*.sqlite` → 테스트 DB.
- 사용자 DB 연결에 도로 DB를 `mode=ro`로 ATTACH해 같은 연결에서 집계 SQL을 돌린다(파일은 분리 유지).
- 차량 앱: 영구 실패가 아닌 `failed(retryable)`는 계속 폴링하고, 60초가 지나도 끝나지 않으면 줄을 보이지 않는다. 종료 화면에는 이번 주행 줄과 전국 완료율 줄이 함께 나온다. 기록 중에는 샘플·거리 숫자를 숨긴다(debug 빌드 제외). 종료 알림은 `Uploader.onTripEnded`(End 업로드 성공 시)로 받는다.
- E2E GPX는 연속 두 점 사이가 21m 아래가 되면(차량 앱 채택 기준 20m) 시드를 하나씩 올려 다시 뽑는다(기본 시드 20261109 → 20261130 채택, 결정적). 경로는 국도 48호선 하행 → 국도 31호선 → 세종대로(`nr:48`·`nr:31`·`nm:세종대로`) 약 1.48km, 60점.
- 호스트의 8787 포트를 다른 프로젝트가 쓰고 있으면 `PORT=8788 pnpm e2e:car`로 돌린다.

**E2E 실측(전국 도로 DB·Valhalla 3.5.1, 에뮬레이터 emulator-5554)**: 세종대로 트립 newKm 1.245, e2e-north newKm 0.163(done), 누적 drivenKm 1.41·전국 완료율 0.0012%, segments 11, 시작한 도로 5, 매칭 소요 9~20ms. 연속 2회 통과 확인(실패한 실행은 인프라 요인: 앞 실행이 남긴 미종료 트립이 다음 실행의 트립 수 단언을 깨뜨림, Maestro 드라이버 종료). 기대값은 ±10%로 고정(`verify-trip.mjs`).
