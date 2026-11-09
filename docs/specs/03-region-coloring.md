# feat/03 시군구 3단계 색칠 · 인구감소지역 도감 · 도로 키 지역 접두 — 사양

- 브랜치 `feat/03-region-coloring`, 분기점 `feat/02-road-coloring` 끝. main 병합 보류.
- 근거: heka `nubi-core-policy-decisions-2026-11-08`(시군구+3단계), 기획서 `docs/plan.md` 7장·6-1, 사양 02 10장(도로 키 지역 범위). 어긋나면 이 사양을 고치고 기획서에 반영한다.
- 완료 기준: 단위 테스트 + E2E(세 번째 flow) 2회 연속 통과.

## 1. 범위

| 포함 | 제외 |
|---|---|
| 시군구 경계 데이터 적재(2025년판 + 2026-07-01 전남광주통합특별시 매핑), 트립 점 → 시군구 판정, 통과/방문/숙박 3단계, 인구감소지역 도감(89곳 통계 기준·92곳 재지정 표기), 조회 API, 차량 화면 한 줄, 뷰어에 시군구 레이어 | 읍면동(2단계), TTS 안내, 지자체 집계 API(B2B, 다음), 바램(feat/04) |
| **도로 키 지역 접두**: 지방도 `lr:{시도코드}:{ref}`, 도로명 `nm:{시군구코드}:{name}` (way 중심점의 시군구로 배정, 빌드 시) | 고속도로·국도 키(`mw:`·`nr:`)는 전국 단일 유지 |

## 2. 용어·규칙

| 용어 | 정의 |
|---|---|
| 시군구 | 행정안전부 행정구역 코드 5자리(시도 2 + 시군구 3). 2025-12-31 기준 자치단체 226개, 경계 단위 229개(행정시 2·세종 포함). **2026-07-01 전남광주통합특별시** 출범 후 코드가 바뀐 구역은 매핑 표(`region_alias(old_code → new_code, new_name)`)로 새 코드에 합산. 도감 분모는 새 체계 기준 개수(매핑 후 수를 빌드 시 기록) |
| 통과 | 트립의 채택 샘플 중 1개 이상이 그 시군구 폴리곤 안에 있음 |
| 방문 | 트립이 그 시군구 안에서 끝났고(종료 샘플 위치), **다음 트립 시작까지 10분 이상** 간격. 판정 시점 = 다음 트립 시작(Start 수신) 때. 다음 트립이 24시간 안에 안 오면 24시간 뒤 배치가 방문으로 확정 |
| 숙박 | 방문 조건 + 간격이 **6시간 이상이고 그 사이에 자정(00:00 KST)을 지남**. 같은 시군구에서 다음 트립이 시작해야 함(다른 시군구에서 시작하면 방문만) |
| 단계 | 0 미방문 / 1 통과 / 2 방문 / 3 숙박. 한 시군구의 단계는 최댓값 유지(내려가지 않음) |
| 인구감소지역 | 행안부 지정 목록. 통계 인용·도감 분모는 **89곳(2021 지정)**, 2026-10 재지정 **92곳**은 목록을 함께 저장하고 화면에는 "92곳(통계는 89곳 기준)"으로 표기. 목록 파일 `server/data/regions/depopulation.json`(출처 URL·기준일 포함) |
| 도감 | 시군구 n/**229**(경계 데이터 기준: 자치구·시·군 + 제주시·서귀포시(행정시) + 세종시를 각 1단위로. 기획서의 226은 자치단체 수이며 도감은 사용자가 보는 지역 단위를 쓴다), 인구감소지역 n/89. '칠해짐'은 단계 ≥ 1 |

## 3. 데이터

- 경계(**확정, 2026-11-10**): GitHub `vuski/admdongkor` `ver20251231/HangJeongDong_ver20251231.geojson`(34.6 MB, EPSG:4326, 행정동 3,557개, 키 불필요). 통계청 SGIS 행정동 경계(**공공누리 제1유형, 출처표시**)를 행정동 변경이력 반영해 가공한 것으로 가공분은 CC BY 4.0. 출처표시 문구: "통계청 통계지리정보서비스(SGIS) 행정동 경계를 vuski/admdongkor가 가공(CC BY 4.0)". 기준일 2025-12-31. 다운로드: `https://raw.githubusercontent.com/vuski/admdongkor/master/ver20251231/HangJeongDong_ver20251231.geojson`. SGIS 키(`NUBI_SGIS_KEY`)는 쓰지 않는다. 탈락: SGIS API(키 필요), 도로명주소지도·브이월드(로그인·신청 필요, 시도별 shp라 좌표 변환 필요).
- 빌드: `scripts/build-regions.mjs <geojson> <YYYYMM> [--codes ...] [--out] [--depop]`. 행정동을 시군구 5자리로 묶고(일반구는 상위 시로 합침, 예: 수원시 41110) **공유 간선 상쇄로 병합**(내부 경계 제거) → Douglas-Peucker 30m, 좌표 5자리 → `server/data/regions/regions.sqlite`(`regions(code PK, sido_code, name, sido_name, depop_89, depop_92, area_km2, polygons, minlon,minlat,maxlon,maxlat, geom_json)` + `regions_rtree(region_id=rowid)` + `region_alias` + `snapshot`). 서버 환경변수 `NUBI_REGIONS_DB`. 없으면 지역 API 503, 판정은 재시도 대기(도로 DB와 같은 정책). 확인 스크립트 `scripts/verify-regions.mjs`.
- 판정 알고리즘: R-tree bbox 후보 → ray casting point-in-polygon. 샘플 전수가 아니라 **채택 샘플을 200m 간격으로 솎아** 판정(트립당 최대 2,000점).
- 통합특별시 매핑: `region_alias(old_code, new_code, new_name, new_sido_code, new_sido_name)` 27건(광주 5구 + 전남 5시 17군 → 시도 `12` 전남광주통합특별시, 구·시·군 코드 1:1)을 빌드 스크립트 상수 `REGION_ALIAS`에 둔다. 새 코드는 admdongkor `ver20261001`(SGIS 2026-10 경계)에서 가져왔고 **행안부 코드 고시 원문은 못 찾았다(대조 필요)**. `regions`는 새 코드로 적재한다. 인천(중·동·서구 → 제물포·영종·서해·검단구)·화성(일반구 4개) 2026-07 개편은 분할이라 alias로 못 다루며 이 사양 범위 밖(2025 경계 유지).
- 도로 키 접두: `build-road-db.mjs`가 regions.sqlite를 읽어 way 중심점의 시군구를 구해 `nm:{sgg}:{name}`, `lr:{sido}:{ref}`로 키를 만든다(없으면 기존 키 + `:00`). `roads.display_name`은 "{시군구명} {도로명}" / "{시도명} 지방도 {ref}호선". 전국 DB 재빌드와 분모 재기록.

## 4. 처리 흐름(서버)

1. 트립 매칭(feat/02) 완료 직후 같은 워커에서 **지역 판정**: 솎은 샘플 → 시군구 집합 → `visited_regions(vehicle_id, code, level, first_at, last_at, passes, visits, stays)` upsert(통과 +1).
2. `region_pending(vehicle_id, code, ended_at, trip_id)`에 트립 종료 지점 시군구를 기록.
3. 새 트립 Start 수신 시(또는 24시간 배치): `region_pending`을 꺼내 간격·자정·같은 시군구 조건으로 방문/숙박 판정 → `visited_regions` 단계 갱신 → `region_events(vehicle_id, code, kind: pass|visit|stay, at, trip_id)` 기록.
4. 매칭 결과(`result_json`)에 `regions: { passed: [code], newPassed: [code], visitPending: code|null }` 추가.

## 5. API

| 호출 | 응답 |
|---|---|
| `GET /regions/summary?vehicleId=` | `{ total, colored, byLevel: {1,2,3}, depop: { total89, colored89, total92, colored92 }, lastEvent }` |
| `GET /regions/list?vehicleId=&filter=all|depop|uncolored&sort=recent|name` | `[{ code, name, sidoName, level, depop89, depop92, firstAt, lastAt }]` |
| `GET /regions/geo?vehicleId=&bbox=` | GeoJSON(시군구 폴리곤, 속성 `code,name,level,depop89`). bbox 한 변 ≤ 3°, 폴리곤은 단순화본 |
| `GET /regions/neighbors?code=` | 인접(경계 공유) 시군구 목록 — 10-2 '안 가 본 이웃' 추천용, 미방문·인구감소지역 우선 정렬 |
| `/viewer`에 시군구 레이어 토글 추가 | |

## 6. 차량 앱

- 대기(P) 화면 한 줄: `시군구 {colored}/{total} · 인구감소지역 {colored89}/89`.
- 종료 화면(P): 매칭 결과에 `newPassed`가 있으면 `처음 지난 곳: {name}(, {name})` 최대 3개. 방문·숙박 확정은 다음 트립 시작 때 생기므로 **다음 대기 화면**에 `어제 {name}에서 하룻밤` / `{name} 방문` 한 줄(마지막 이벤트 1개, 24시간 내).
- 숫자·문구 표시 규칙은 feat/02 7장(기어 P 기준) 그대로. 문자열은 strings.xml.

## 7. 테스트·E2E

- 서버 단위: point-in-polygon 경계·구멍(도넛) 폴리곤, 통합특별시 매핑 합산, 통과/방문/숙박 판정(10분·6시간·자정·같은 시군구 조건, 24시간 배치), 단계 비하락, 도감 집계, neighbors 정렬, 도로 키 접두 빌드 규칙(`road-rules.mjs` 확장).
- 테스트 픽스처: 서울 중구·종로구·용산구 + 강원 홍천군·양구군 폴리곤만 담은 `server/test/fixtures/regions-test.sqlite`(< 500KB), depop 목록 축약본.
- E2E 세 번째 flow `region-coloring.yaml`: 기존 세종대로 트립(종로구→중구) 종료 후 debug `now`를 +15분으로 주입하고 새 트립 시작 → `GET /regions/summary` colored ≥ 2, 중구 level 2(방문). 이어서 `now`를 다음 날 07:00로 주입하고 중구에서 트립 시작 → 중구 level 3(숙박). 차량 화면 `시군구 2/… ` 보임. verify 스크립트 단언 추가. **2회 연속 통과**.

## 8. 기준값(가안)

| 항목 | 값 |
|---|---|
| 방문 간격 | 10분 |
| 숙박 | 6시간 + 자정 통과 + 같은 시군구 시작 |
| 미확정 배치 | 24시간 |
| 판정 샘플 간격 | 200m, 트립당 최대 2,000점 |
| 폴리곤 단순화 | 30m, 좌표 5자리 |
| 도감 분모 | 시군구(새 체계 수, 빌드 시 기록) / 인구감소지역 89 |

## 9. 확인이 필요한 것
- ~~SGIS 키 발급~~ → admdongkor로 대체(3장). 2026-07-01 통합특별시 코드 고시 원문 대조(미확보). 시군구 개수가 사양 2장의 226과 다름(빌드 229, sdk-check 8장) — 분모 확정 필요.
- 인구감소지역 92곳 재지정 목록 원문(행안부 2026-10-07 발표, 보도로는 89곳 + 금정구·동두천시·통영시)과 89곳 고시 원문 URL. 현재 `depopulation.json`은 이름 기준 가안(커밋됨, `git add -f`).
- 도로 키 접두 적용 후 `nm:` 키 수·동명이로 해소 비율을 sdk-check에 기록.

## 10. 구현자 가안 (사양에 없어 정한 것)

| 항목 | 가안 |
|---|---|
| 판정 대상 트립 | 매칭 결과가 `suspect`(오도미터 불일치)가 아니면 시군구를 판정한다. 점이 20개 미만인 `too_short`와 `low_confidence`도 포함(시군구는 GPS 점만 쓰고 Valhalla 결과와 무관) |
| pending 판정 시점 | 새 트립 Start(방문 간격 확인), **점 업로드**(숙박은 다음 트립의 첫 점이 필요해 Start 시점에는 시작 지점을 모른다 — Start 때 방문까지 반영하고 `region_pending.visit_done=1`로 남겨 첫 점이 오면 숙박 확정), 매칭 직후, 24시간 배치(1시간마다 실행) |
| 숙박 이벤트 | `stay`는 `visit` 위에 따로 기록(같은 트립 쌍에 `visit`·`stay` 둘 다). `visits`는 방문 횟수, `stays`는 숙박 횟수이며 숙박은 방문 횟수에 다시 더하지 않는다 |
| 24시간 배치 확정 시각 | 이벤트 시각 = 종료 + 24시간 |
| 이벤트 종류 | `pass`는 그 시군구를 **처음** 칠한 트립(시군구 첫 통과 시각)만 기록. 차량 화면의 마지막 이벤트는 `visit`·`stay`만 쓴다 |
| 결과 추가 필드 | `result_json.regions`에 `newPassedNames`(차량 화면용 이름)·`ms`(판정 소요) 추가 |
| API 응답 형태 | 목록류는 배열 대신 `{ snapshotMonth, attribution, items: [...] }`(모든 응답에 attribution을 싣기 위해). `summary.byLevel`의 키는 `"1"`·`"2"`·`"3"`(정확히 그 단계인 개수). `lastEvent` = `{ kind, code, name, sidoName, at, tripId }` 또는 null. `list`의 인구감소지역 필터는 89 또는 92. `list` 기본 정렬 name(시도 코드 → 이름), `recent`는 최근 지난 순·미방문 뒤 |
| neighbors | 선택 인자 `vehicleId`를 받는다(없으면 모두 미방문). 정렬: 미방문 먼저 → 인구감소지역(89 또는 92) 먼저 → 이름. 꼭짓점만 닿는 시군구도 이웃으로 센다(거리 < 50m). 결과는 프로세스 안에 캐시 |
| 지역 접두 없음 | 시군구를 못 찾은 way(해상·경계 밖)는 `nm:00:{name}`·`lr:00:{ref}`(사양 3장의 "기존 키 + :00"을 접두 형태로 해석), 표시 이름은 접두 없는 기존 규칙. way 위치 = 중간 정점(못 찾으면 처음·끝 정점) |
| 지역 DB 없음 | 매칭이 `retryable:regions_db_unavailable`로 5분 간격 재시도(24시간까지). 지역 DB 없이 판정을 생략하는 모드는 없다 |
| 차량 화면 | 도감 한 줄은 대기·종료 화면(기어 P 규칙). 조회 시점: 서비스 시작·새 트립 시작·**매칭 종료 뒤**(방문·숙박이 그 트립 Start 때 확정되므로). 마지막 이벤트는 `{name} 방문`/`{name}에서 하룻밤`(「어제」는 붙이지 않음), 엔진 시계(debug 주입 포함) 기준 24시간 내 |
| E2E | 같은 서버·차량이라 flow 2의 세종대로 트립이 flow 3의 '앞 트립'이다(flow 순서 의존). 중구 트립 GPX `e2e-junggu`는 점 간격 22m로 12점(모두 채택되게 20m 이상, 20점 미만이라 맵매칭은 too_short) |
