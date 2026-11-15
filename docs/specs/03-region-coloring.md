# feat/03 시군구 3단계 색칠 · 인구감소지역 도감 · 도로 키 지역 접두 — 사양

- 브랜치 `feat/03-region-coloring`, 분기점 `feat/02-road-coloring` 끝. main 병합 보류.
- 근거: heka `nubi-core-policy-decisions-2026-11-08`(시군구+3단계), 기획서 `docs/plan.md` 7장·6-1, 사양 02 10장(도로 키 지역 범위). 어긋나면 이 사양을 고치고 기획서에 반영한다.
- 완료 기준: 단위 테스트 + E2E(세 번째 flow) 2회 연속 통과.

## 1. 범위

| 포함 | 제외 |
|---|---|
| 시군구 경계 데이터 적재(2025년판 + 2026-07-01 전남광주통합특별시 매핑), 트립 점 → 시군구 판정, 통과/방문/숙박 3단계, 인구감소지역 도감(분모 92곳 현행 지정, 89곳은 통계 인용용 참고), 조회 API, 차량 화면 한 줄, 뷰어에 시군구 레이어 | 읍면동(2단계), TTS 안내, 지자체 집계 API(B2B, 다음), 바램(feat/04) |
| **도로 키 지역 접두**: 지방도 `lr:{시도코드}:{ref}`, 도로명 `nm:{시군구코드}:{name}` (way 중간 정점의 시군구로 배정, 빌드 시) | 고속도로·국도 키(`mw:`·`nr:`)는 전국 단일 유지 |

## 2. 용어·규칙

| 용어 | 정의 |
|---|---|
| 시군구 | 행정안전부 행정구역 코드 5자리(시도 2 + 시군구 3). 2025-12-31 기준 자치단체 226개, 경계 단위 229개(행정시 2·세종 포함). **2026-07-01 전남광주통합특별시** 출범 후 코드가 바뀐 구역은 매핑 표(`region_alias(old_code → new_code, new_name)`)로 새 코드에 합산. 도감 분모는 새 체계 기준 개수(매핑 후 수를 빌드 시 기록) |
| 통과 | 트립의 채택 샘플 중 1개 이상이 그 시군구 폴리곤 안에 있음 |
| 방문 | 트립이 그 시군구 안에서 끝났고(종료 샘플 위치), **다음 트립 시작까지 10분 이상** 간격. 다음 트립 = 종료 이후 `started_at`이 가장 이른 트립(도착 순서와 무관). 다음 트립이 24시간 안에 안 오면 24시간 뒤 배치가 **방문을 잠정 확정**한다(아래 '배치·보존') |
| 숙박 | 방문 조건 + 간격이 **6시간 이상 7일 이하이고 그 사이에 자정(00:00 KST)을 지남**. 같은 시군구에서 다음 트립이 시작해야 함(다른 시군구에서 시작하면 방문만). **간격이 7일을 넘으면 장기 주차로 보고 방문만** |
| 배치·보존 | 다음 트립이 없으면 종료 + 24시간 뒤 배치가 방문을 **잠정 확정**(시각 = 종료 + 24시간)하되 `region_pending`은 **종료 + 7일까지 보존**한다. 그 사이 늦게 도착한 Start·첫 점으로 숙박 승격하거나, 간격이 10분 미만으로 드러나면 잠정 방문을 **취소**한다(이벤트 삭제, 횟수·단계를 횟수에서, `first_at`/`last_at`을 남은 `region_events`에서 재계산). 확정(삭제)은 다음 트립 판정이 끝났을 때 또는 `ended_at + 7일`. 시각 기준은 서버 now가 아니라 `ended_at` 대비 경과이고, Start 즉시·점 업로드·매칭 직후·배치 **어느 경로든 한 함수(`resolvePending`)의 같은 규칙**이라 업로드 시점과 무관하게 같은 결과가 나온다 |
| 단계 | 0 미방문 / 1 통과 / 2 방문 / 3 숙박. 한 시군구의 단계는 최댓값 유지(내려가지 않음) |
| 인구감소지역 | 행안부 지정 목록. **도감 분모는 현행 지정 92곳**(2026-10-20 시행). 89곳(2021 지정)은 정부 통계 인용용 참고 필드로만 API에 남긴다(`depop.total89`·`colored89`). 두 목록을 함께 저장한다. 목록 파일 `server/data/regions/depopulation.json`(출처 URL·기준일 포함) |
| 도감 | 시군구 n/**229**(경계 데이터 기준: 자치구·시·군 + 제주시·서귀포시(행정시) + 세종시를 각 1단위로. 기획서의 226은 자치단체 수이며 도감은 사용자가 보는 지역 단위를 쓴다), 인구감소지역 n/**92**(현행 지정, 2026-10-20 시행 — 결정 2026-11-10: 도감 분모는 92, 89는 정부 통계 인용에만). '칠해짐'은 단계 ≥ 1 |

## 3. 데이터

- 경계(**확정, 2026-11-10**): GitHub `vuski/admdongkor` `ver20251231/HangJeongDong_ver20251231.geojson`(34.6 MB, EPSG:4326, 행정동 3,557개, 키 불필요). 통계청 SGIS 행정동 경계(**공공누리 제1유형, 출처표시**)를 행정동 변경이력 반영해 가공한 것으로 가공분은 CC BY 4.0. 출처표시 문구: "통계청 통계지리정보서비스(SGIS) 행정동 경계를 vuski/admdongkor가 가공(CC BY 4.0)". 기준일 2025-12-31. 다운로드: `https://raw.githubusercontent.com/vuski/admdongkor/master/ver20251231/HangJeongDong_ver20251231.geojson`. SGIS 키(`NUBI_SGIS_KEY`)는 쓰지 않는다. 탈락: SGIS API(키 필요), 도로명주소지도·브이월드(로그인·신청 필요, 시도별 shp라 좌표 변환 필요).
- 빌드: `scripts/build-regions.mjs <geojson> <YYYYMM> [--codes ...] [--out] [--depop]`. 행정동을 시군구 5자리로 묶고(일반구는 상위 시로 합침, 예: 수원시 41110) **공유 간선 상쇄로 병합**(내부 경계 제거) → Douglas-Peucker 30m, 좌표 5자리 → `server/data/regions/regions.sqlite`(`regions(code PK, sido_code, name, sido_name, depop_89, depop_92, area_km2, polygons, minlon,minlat,maxlon,maxlat, geom_json)` + `regions_rtree(region_id=rowid)` + `region_alias` + `snapshot`). 서버 환경변수 `NUBI_REGIONS_DB`. 없으면 지역 API 503, 판정은 재시도 대기(도로 DB와 같은 정책). 확인 스크립트 `scripts/verify-regions.mjs`.
- 판정 알고리즘: R-tree bbox 후보 → ray casting point-in-polygon(겹치면 `ORDER BY code` 첫째). **경계 틈 보정**: 어느 폴리곤에도 안 들면 50m 이내에서 가장 가까운 시군구로 본다(30m 단순화로 이웃 시군구 사이가 벌어짐). 이 규칙의 구현은 `server/src/shared/geo-utils.mjs` 하나이고 빌드 스크립트·verify(`scripts/`)·서버가 import 한다. 서버 `build`가 이 파일을 `dist/shared/`로 복사하므로 **배포 단위는 `server/`(dist) 하나**이고 루트 `scripts/`는 런타임에 필요 없다. 샘플 전수가 아니라 **채택 샘플을 200m 간격으로 솎아** 판정(트립당 최대 2,000점).
- 통합특별시 매핑: `region_alias(old_code, new_code, new_name, new_sido_code, new_sido_name)` 27건(광주 5구 + 전남 5시 17군 → 시도 `12` 전남광주통합특별시, 구·시·군 코드 1:1)을 빌드 스크립트 상수 `REGION_ALIAS`에 둔다. 새 코드는 admdongkor `ver20261001`(SGIS 2026-10 경계)에서 가져왔고 **행안부 코드 고시 원문은 못 찾았다(대조 필요)**. `regions`는 새 코드로 적재한다. 인천(중·동·서구 → 제물포·영종·서해·검단구)·화성(일반구 4개) 2026-07 개편은 분할이라 alias로 못 다루며 이 사양 범위 밖(2025 경계 유지).
- 도로 키 접두: `build-road-db.mjs`가 regions.sqlite를 읽어 way 중간 정점의 시군구를 구해 `nm:{sgg}:{name}`, `lr:{sido}:{ref}`로 키를 만든다(없으면 `nm:00:{name}`). 전국 빌드는 `--regions`가 **필수**(없으면 오류)이고 도로 DB `snapshot.regions_month`에 지역 DB 월을 기록한다. 전국 DB 재빌드와 분모 재기록.
- **표시 이름 규칙(2026-11-10 보정)**: 시군구명이 전국에서 유일하지 않거나(중구·서구·북구·동구·남구·강서구 등) `구`로 끝나면 시도 단축명을 앞에 붙인다 — "서울 중구 세종대로", "대구 중구 달구벌대로". 유일한 시·군은 그대로("홍천군 영서로"). 지방도는 "{시도 단축명} 지방도 {ref}호선". 도감·이벤트 문구의 지역 이름도 같은 규칙(`regions.display_name` 열 추가). 시도 단축명 표: 서울·부산·대구·인천·대전·울산·세종·경기·강원·충북·충남·전북·전남광주·경북·경남·제주.
- **시군구 경계를 넘는 같은 이름 도로**(예: 세종대로 = 종로구 구간 + 중구 구간)는 **시군구별로 별개 도로**로 센다(도로명주소 체계도 시군구 단위로 도로구간을 둠). 기획서 6-1에 명시.

## 4. 처리 흐름(서버)

1. 트립 매칭(feat/02)은 지역 DB와 **무관하게** `done`으로 끝난다. 같은 트랜잭션에서 `region_jobs(trip_id, status, attempts, queued_at)`에 지역 판정 작업을 넣고(의심 `suspect` 트립 제외) `result_json.regions`는 `"pending"`으로 둔다. 워커가 바로 이어서 **지역 판정**을 돌려 결과로 바꾼다. 지역 DB가 없거나 판정이 실패하면 작업은 `queued`로 남아 **5분 간격으로 최대 7일** 재시도한다(`failed`: 7일 초과).
2. 지역 판정 = 솎은 샘플 → 시군구 집합 → `visited_regions(vehicle_id, code, level, first_at, last_at, passes, visits, stays)` upsert(통과 +1). 처음 칠한 판단은 **정본 차량 ID**(`canonicalVehicleId`)와 그 alias 묶음 전체 기준이다.
3. `region_pending(vehicle_id, code, ended_at, trip_id)`에 트립 종료 지점 시군구를 기록.
4. 새 트립 Start·점 업로드·매칭 직후·1시간 배치에서 `resolvePending`(한 함수)이 간격·자정·같은 시군구 조건으로 방문/숙박을 판정 → `visited_regions` 단계 갱신 → `region_events(vehicle_id, code, kind: pass|visit|stay, at, trip_id)` 기록. 규칙은 2장 '숙박'·'배치·보존'.
5. 매칭 결과(`result_json`)에 `regions: { passed: [code], newPassed: [code], visitPending: code|null }` 추가(판정 전에는 `"pending"`).
6. 서버 시작 때: 지역 별칭 합산 + 쌓인 `region_pending` 재처리 배치 1회. 둘 다 실패해도 로그만 남기고 기동은 계속한다.

## 5. API

| 호출 | 응답 |
|---|---|
| `GET /regions/summary?vehicleId=` | `{ total, colored, byLevel: {1,2,3}, depop: { total: 92, colored, total89: 89, colored89 }, lastEvent }` |
| `GET /regions/list?vehicleId=&filter=all|depop|uncolored&sort=recent|name` | `[{ code, name, displayName, sidoName, level, depop89, depop92, firstAt, lastAt, passes, visits, stays }]` |
| `GET /regions/geo?vehicleId=&bbox=` | GeoJSON(시군구 폴리곤, 속성 `code,name,displayName,level,depop89`). bbox 한 변 ≤ 3°, 폴리곤은 단순화본. 도형은 bbox 단위 메모리 캐시(최대 50개·5분), 차량별 단계는 매번 새로 붙인다 |
| `GET /regions/neighbors?code=` | 인접(경계 공유) 시군구 목록 — 10-2 '안 가 본 이웃' 추천용, 미방문·인구감소지역 우선 정렬. 이웃이 0개인 곳(섬)은 중심점 거리순 가장 가까운 3곳을 `nearest: true`로 대신 돌려준다 |
| `GET /trips?vehicleId=&limit=` | **`vehicleId` 필수**(없으면 400 `vehicleId_required`). 전체 열거 차단 |
| `/viewer`에 시군구 레이어 토글 추가 | 요청 순서 보장(마지막 요청만 반영), bbox 3° 초과면 레이어를 비움 |

> **공개 배포 전 필수**: `/regions/*`·`/coverage/*`·`/trips`는 지금 `vehicleId`만 알면 누구나 읽는다. 인증·소유권 확인(기기·계정 토큰, 요청한 차량 ID가 토큰 주체의 것인지 검증), rate limit, TLS 종단을 공개 배포 전에 반드시 붙여야 한다(사양 01 '인증은 범위 밖'과 같은 조건). 지금의 `vehicleId` 필수화는 전체 열거만 막는 임시 조치다.

## 6. 차량 앱

- 대기(P) 화면 한 줄: `시군구 {colored}/{total} · 인구감소지역 {colored}/92`.
- 종료 화면(P): 매칭 결과에 `newPassed`가 있으면 `처음 지난 곳: {name}(, {name})` 최대 3개. 방문·숙박 확정은 다음 트립 시작 때 생기므로 **다음 대기 화면**에 `어제 {name}에서 하룻밤` / `{name} 방문` 한 줄(마지막 이벤트 1개, 24시간 내).
- 숫자·문구 표시 규칙은 feat/02 7장(기어 P 기준) 그대로. 문자열은 strings.xml.

## 7. 테스트·E2E

- 서버 단위: point-in-polygon 경계·구멍(도넛) 폴리곤, 통합특별시 매핑 합산, 통과/방문/숙박 판정(10분·정확히 6시간+자정·같은 시군구 조건·7일 상한, 24시간 배치와 7일 보존·만료, 잠정 방문 취소, 업로드 시점 무관), alias 정본(사전순 앞·뒤), `region_events` alias 병합, suspect 제외, 경계 틈 보정·겹침, 표시 이름 규칙, 이웃 없는 섬, `GET /trips` vehicleId 필수, 단계 비하락, 도감 집계, neighbors 정렬, 도로 키 접두 빌드 규칙(`road-rules.mjs` 확장).
- 테스트 픽스처: 서울 중구·종로구·용산구 + 강원 홍천군·양구군 폴리곤만 담은 `server/test/fixtures/regions-test.sqlite`(< 500KB), depop 목록 축약본.
- E2E 세 번째 flow `region-coloring.yaml`: 기존 세종대로 트립(종로구→중구) 종료 후 debug `now`를 **절대 시각**(스크립트가 계산: B 시작 = max(지금 + 15분, 오늘 KST 22:30), B 종료 = +7분, C 시작 = B 종료 + 정확히 10시간 — 자정을 반드시 지남)으로 주입하고 새 트립 시작 → `GET /regions/summary` colored ≥ 2, 중구 level 2(방문), 화면 `서울 중구 방문`. 이어서 C 시작을 주입하고 중구에서 트립 시작 → 중구 level 3(숙박), 화면 `서울 중구에서 하룻밤`, 중구 visits=2·stays=1. verify 스크립트 단언 추가(목록 조회는 `E2E_VEHICLE_ID` 필요). **2회 연속 통과**.

## 8. 기준값(가안)

| 항목 | 값 |
|---|---|
| 방문 간격 | 10분 |
| 숙박 | 6시간 + 자정 통과 + 같은 시군구 시작 |
| 미확정 배치 | 24시간 뒤 잠정 방문, pending 7일 보존 |
| 숙박 간격 상한 | 7일(초과는 방문만) |
| 경계 틈 보정 | 50m |
| 판정 샘플 간격 | 200m, 트립당 최대 2,000점 |
| 폴리곤 단순화 | 30m, 좌표 5자리 |
| 도감 분모 | 시군구(새 체계 수, 빌드 시 기록) / 인구감소지역 92(89는 통계 인용용 참고) |

## 9. 확인이 필요한 것
- ~~SGIS 키 발급~~ → admdongkor로 대체(3장). 2026-07-01 통합특별시 코드 고시 원문 대조(미확보). 시군구 개수가 사양 2장의 226과 다름(빌드 229, sdk-check 8장) — 분모 확정 필요.
- 인구감소지역 92곳 재지정 목록 원문(행안부 2026-10-07 발표, 보도로는 89곳 + 금정구·동두천시·통영시)과 89곳 고시 원문 URL. 현재 `depopulation.json`은 이름 기준 가안(커밋됨, `git add -f`).
- 도로 키 접두 적용 후 `nm:` 키 수·동명이로 해소 비율을 sdk-check에 기록.

## 10. 구현자 가안 (사양에 없어 정한 것)

| 항목 | 가안 |
|---|---|
| 판정 대상 트립 | 매칭 결과가 `suspect`(오도미터 불일치)가 아니면 시군구를 판정한다. 점이 20개 미만인 `too_short`와 `low_confidence`도 포함(시군구는 GPS 점만 쓰고 Valhalla 결과와 무관) |
| pending 판정 시점 | 새 트립 Start(방문 간격 확인), **점 업로드**(숙박은 다음 트립의 첫 점이 필요해 Start 시점에는 시작 지점을 모른다 — Start 때 방문까지 반영하고 `region_pending.visit_done=1`로 남겨 첫 점이 오면 숙박 확정), 매칭 직후, 24시간 배치(1시간마다 실행). `visit_done=1`은 '방문은 이미 반영했다(Start로 확정 또는 24시간 배치의 잠정 확정)'이며 그 뒤에도 7일간 숙박 승격·방문 취소가 가능하다 |
| 숙박 이벤트 | `stay`는 `visit` 위에 따로 기록(같은 트립 쌍에 `visit`·`stay` 둘 다). `visits`는 방문 횟수, `stays`는 숙박 횟수이며 숙박은 방문 횟수에 다시 더하지 않는다 |
| 24시간 배치 확정 시각 | 잠정 방문 이벤트 시각 = 종료 + 24시간(나중에 Start가 오면 그 트립 시작 시각으로 맞춘다) |
| 이벤트 종류 | `pass`는 그 시군구를 **처음** 칠한 트립(시군구 첫 통과 시각)만 기록. 차량 화면의 마지막 이벤트는 `visit`·`stay`만 쓴다 |
| 결과 추가 필드 | `result_json.regions`에 `newPassedNames`(차량 화면용 이름)·`ms`(판정 소요) 추가 |
| 표시 이름 | `regions.display_name` 열(빌드가 채움)을 `lastEvent.name`·`newPassedNames`·도로 `roads.display_name`·차량 문구가 쓴다. `list`·`geo`·`neighbors`는 `name`(원래 이름)과 `displayName`을 모두 준다. 유일성은 `--codes`로 줄이기 전 전국 이름 기준 |
| API 응답 형태 | 목록류는 배열 대신 `{ snapshotMonth, attribution, items: [...] }`(모든 응답에 attribution을 싣기 위해). `summary.byLevel`의 키는 `"1"`·`"2"`·`"3"`(정확히 그 단계인 개수). `lastEvent` = `{ kind, code, name, sidoName, at, tripId }` 또는 null. `list`의 인구감소지역 필터는 89 또는 92. `list` 기본 정렬 name(시도 코드 → 이름), `recent`는 최근 지난 순·미방문 뒤 |
| neighbors | 선택 인자 `vehicleId`를 받는다(없으면 모두 미방문). 정렬: 미방문 먼저 → 인구감소지역(89 또는 92) 먼저 → 이름. 꼭짓점만 닿는 시군구도 이웃으로 센다(거리 < 50m). 결과는 프로세스 안에 캐시 |
| 지역 접두 없음 | 시군구를 못 찾은 way(해상·경계 밖)는 `nm:00:{name}`·`lr:00:{ref}`(사양 3장의 "기존 키 + :00"을 접두 형태로 해석), 표시 이름은 접두 없는 기존 규칙. way 위치 = 중간 정점(못 찾으면 처음·끝 정점) |
| 지역 DB 없음 | 도로 매칭은 막히지 않고 `done`(`result_json.regions = "pending"`). 지역 판정만 `region_jobs`로 5분 간격 최대 7일 재시도(초과하면 `result_json.regions = "failed"`). 지역 DB 없이 판정을 생략하는 모드는 없다 |
| 차량 화면 | 도감 한 줄은 대기·종료 화면(기어 P 규칙). 조회 시점: 서비스 시작·새 트립 시작·**매칭 종료 뒤**(방문·숙박이 그 트립 Start 때 확정되므로). 마지막 이벤트는 `{name} 방문`/`{name}에서 하룻밤`(「어제」는 붙이지 않음), 엔진 시계(debug 주입 포함) 기준 24시간 내. 도감 캐시(SharedPreferences) 문자열 맨 앞에 포맷 버전(`v2`)을 두어 버전이 다른 옛 캐시(분모 89 시절 등)는 버린다 |
| E2E | 같은 서버·차량이라 flow 2의 세종대로 트립이 flow 3의 '앞 트립'이다(flow 순서 의존). 중구 트립 GPX `e2e-junggu`는 점 간격 22m로 12점(모두 채택되게 20m 이상, 20점 미만이라 맵매칭은 too_short) |
| 경계 도로(한계) | 한 도로가 시군구 경계를 넘으면 way **중간 정점**이 속한 시군구로 통째로 배정한다(way를 경계에서 자르지 않는다). 같은 이름 도로는 시군구별 별개 도로로 센다(S3: 도로명주소 체계도 시군구 단위 구간). 긴 way가 경계에 걸치면 한쪽에 몰려 들어가는 오차가 있다 |
| 인증(한계) | 위 5장 박스: `/regions/*`·`/coverage/*`·`/trips`의 인증·소유권 확인은 공개 배포 전 필수. 지금은 `GET /trips`의 전체 열거만 막았다 |
| 순서 뒤바뀜(한계) | 이미 끝낸 pending(방문·숙박 판정 완료로 삭제)은 **다시 판정하지 않는다**. 오프라인 큐로 아주 늦게 올라온 트립이 그 사이에 끼어도 앞 트립의 확정 결과(방문 간격·숙박)는 바뀌지 않는다. 재기동 복구는 `region_jobs`를 `trips.started_at` 순으로 처리해 쌓인 작업의 순서 뒤바뀜만 줄인다 |
| 조회 차량 ID | `/regions/*`는 `vehicleId`를 정본(`canonicalVehicleId`)으로 바꿔 조회한다. alias(UUID)로 조회해도 정본 기록과 합산한다 |
| 지역 DB 스키마 검사 | 붙일 때 `regions.display_name` 열이 없으면(옛 빌드) DETACH 하고 지역 DB 없음으로 취급(지역 API 503) |
| 7일 포기 | `region_jobs`가 7일을 넘기면 `failed`(`retry_exhausted`)로 두고 `result_json.regions`를 `"failed"`로 남긴다 |
| 지역 판정 지연 | 매칭이 끝난 직후 `result_json.regions`는 아주 짧게 `"pending"`일 수 있다(같은 워커가 바로 이어 판정). 차량 앱은 `regions`가 객체가 아니면 `처음 지난 곳`을 비우고 매칭 완료 뒤 도감을 다시 받는다 |
| 차량 화면 규칙(리뷰 반영) | `refreshNational`·`refreshRegions`를 따로 두고 차량 ID 대기·30초 재시도는 executor에서 sleep하지 않고 예약(스케줄러)한다. DO 중 규제 길이보다 긴 줄은 **중간에서 자르지 않고 숨긴다**(상태 문구는 예외로 자름). 줄 우선순위: 상태 > 집계(새 도로) > 시군구 > 처음 지난 곳 > 이벤트 > 전국 > 샘플·거리. 가로(2-window) 높이에서 넘치면 뒤 순위부터 접는다 |
