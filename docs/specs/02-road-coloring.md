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
  - `ways(way_id PK, road_key, highway, name, ref, length_m, minlon, minlat, maxlon, maxlat, geom_json)` + R-tree `ways_rtree(way_id, minlon, maxlon, minlat, maxlat)`
  - `roads(road_key PK, display_name, highway_major, total_length_m, way_count)`
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
- 같은 이름의 다른 도로(예: 여러 도시의 '중앙로')가 하나로 묶이는 문제는 **알려진 한계**로 사양에 적고, feat/03 이후 시군구 접두를 붙일지 결정(기획서 15장 항목).

### 6-2. 분모
- `snapshot.total_named_length_m` = `Σ ways.length_m where road_key not like 'unnamed:%'`.
- 참고 병기: 국토부 개통연장 107,852km는 API에 넣지 않고 기획서에만.

### 6-3. 양방향·중복
- 같은 way를 반대 방향으로 달려도 1회. 같은 트립 안에서 왕복해도 매칭 길이는 way 길이로 상한.

### 6-4. 매칭 실패·부분 실패
- Valhalla가 `matched.type = unmatched`로 돌려준 점 비율이 50%를 넘으면 트립을 `low_confidence`로 표시하고 인정하지 않는다(가안). 결과에 사유 기록.

## 7. 차량 앱

- 트립 종료 후 `GET /trips/:id/matching`을 3초 간격 최대 60초 폴링(서비스 워커, 메인 스레드 아님). `done`이면 종료 화면에 한 줄 추가: `새 도로 {newKm}km · 전국 {after}% (+{delta})`. `skipped/suspect/low_confidence/failed`이면 `이번 주행은 집계되지 않았어요`(사유는 debug 빌드에서만 괄호 표기).
- 대기 화면: 서비스 시작 때 `GET /coverage/summary`를 1회 받아 `전국 {percent}% 달렸어요` 표시. 실패 시 생략(크래시 금지).
- 주행 규제 중에도 글자만이라 추가 처리 없음(문자열 길이 제한은 feat/01 규칙 그대로).

## 8. 테스트·E2E

- 서버 단위: Valhalla 응답 **픽스처**(`server/test/fixtures/valhalla-e2e-north.json`, 실제 응답을 저장)로 매칭 파이프라인 전체(합산·인정·오도미터 대조·low_confidence·unnamed 제외·집계 SQL)를 검증. 도로 DB는 테스트용 소형 sqlite(`server/test/fixtures/roads-test.sqlite`, 세종대로 일대 way 수십 개)를 스크립트로 생성해 커밋(크기 < 1MB).
- 차량 단위: 폴링·표시 문자열 생성.
- E2E(`pnpm e2e:car`): 기존 흐름(GPX 30점, 세종대로 일대) 뒤에 추가 — `valhalla-up.sh`로 실제 Valhalla 기동, 서버는 실제 도로 DB(전국) 또는 없으면 테스트 DB. `scripts/verify-trip.mjs`에 단언 추가: `matching.status == done`, `newKm ≥ 0.5`, `coverage/roads`에 `displayName`이 `세종대로`를 포함하는 항목, `coverage/summary.nationalPercent > 0`, `coverage/segments`(bbox = GPX 범위) feature ≥ 1. 차량 화면 Maestro: `새 도로 .*km` 보임. **2회 연속 통과**.
- 실제 Valhalla 응답은 결정적이므로 E2E 기대값은 1회 실측 후 ±10% 허용으로 고정한다.

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

## 10. 확인이 필요한 것
- Valhalla arm64 이미지의 정확한 태그와 한국 타일 빌드 시간·용량(설치 때 기록).
- OSM 한국 `ref`·`name` 채움률(도로 DB 빌드 때 통계로 기록: unnamed 비율).
- 동명이로 문제의 규모(같은 name의 road_key가 몇 개 시군구에 걸치는지) — 빌드 통계로 기록.
- OSM 래스터 타일을 시연 뷰어에 쓰는 것은 개발용에 한함(OSMF 타일 정책). 배포 시 자체 타일 또는 유료 타일.
