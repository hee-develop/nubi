# 05b. 서버 확장 (T2, 2026-11-11 야간)

계약서 `05-night-plan.md` 3장 'T2 소유'의 구현 사양이다. 서버(`server/`)와 `scripts/recompute-coverage.mjs`만 바뀌었다. 기획서 7-4·8·9·10·11-2·12-2·12-3이 원 기획이고, 이 문서가 구현된 모양이다.

## 코드 배치
- 라우트: `server/src/routes/{pair,guest,share,intro,account,reports,b2b,pages}.ts`, 진입점 `routes/ext.ts`의 `createExt(deps)`가 `{ middleware, routes }`를 준다. `app.ts`는 체인 **맨 앞**에 `.use('*', ext.middleware)`, 어디든 `.route('/', ext.routes)`를 둔다. 미들웨어가 맨 앞이라 뒤에 붙는 모든 라우트(T1 `/map/base`·`/trips/:id/live` 포함)에 같은 인증·본문 한도가 적용된다.
- 공용: `server/src/ext/{auth,sessions,stats,cards,render,html,tourapi,settings,util}.ts`, `server/src/shared/fade.ts`, 테이블 `server/src/db/schema-ext.ts`.
- `schema.ts`는 건드리지 않았다. 확장 테이블은 `openDb()`가 기본 스키마 뒤에 `ensureExtSchema(db)`로 만든다(전부 `IF NOT EXISTS`, 앞 버전 테이블에는 열을 더하는 마이그레이션). `createExt()`도 한 번 더 부른다(멱등).
- 기존 파일 변경: `app.ts`(import·`ext` 옵션·`createExt`·`regionsRoutes`/`coverageRoutes`에 `now` 전달), `db/index.ts`(`ensureExtSchema` 호출), `routes/coverage.ts`(`faded`·`revivedKm`·`filter=almost`), `routes/regions.ts`(`faded`), `matching/pipeline.ts`·`matching/worker.ts`(삭제와의 경합 확인, 아래 'M3').
- 의존성 추가: `@resvg/resvg-js`(공유 카드 PNG). 없으면 SVG로 내려간다.

## 환경변수·옵션 (`createApp(db, { ext })`로도 덮는다)
| 환경변수 | 옵션 | 기본 | 설명 |
|---|---|---|---|
| `NUBI_AUTH` | `ext.auth` | `off` | `off`/`optional`/`required` |
| `NUBI_DEBUG=1` | `ext.debug` | 꺼짐 | `POST /debug/age`(production에서는 켜지지 않는다) |
| `NUBI_TRUST_PROXY=<n>` | - | 0(신뢰 안 함) | 서버 앞의 신뢰하는 프록시 **홉 수**. X-Forwarded-For의 **오른쪽에서 n번째**를 클라이언트 주소로 쓴다(맨 왼쪽 금지). 아래 '배포 설정' 참고 |
| - | `ext.inProcessLocal` | false | **테스트 전용**: 소켓 주소가 없는 프로세스 안 호출(`app.request`)을 로컬로 본다. 실제 서버는 항상 소켓 주소가 있어 영향 없음 |
| `NUBI_PUBLIC_URL` | `ext.publicUrl` | 요청 origin | QR·공유 링크 바탕 주소 |
| `NUBI_B2B_KEY` | `ext.b2bKey` | 없음 | 없으면 B2B API는 503 |
| `NUBI_TOURAPI_KEY` | `ext.tourApiKey` | 없음 | 없으면 지역 소개는 예시 |
| `NUBI_INSTALL_URL` | `ext.installUrl` | 없음 | `/s/:id`의 설치 링크(없으면 링크를 내지 않는다) |
| `NUBI_CARD_FONT` | `ext.fontFile` | 시스템 글꼴 | PNG 변환용 한글 글꼴 파일 |
| `NUBI_TRUST_PROXY=1` | - | 꺼짐 | 시도 제한의 출처 키로 `X-Forwarded-For`를 쓴다 |

## API
오류는 `{ error: '<code>' }`이고 입력 값을 되돌려 주지 않는다. 성공은 모두 200(예외: B2B 코스 생성 201). 차량 ID 쿼리·본문은 기존대로 `vehicleId`(alias는 정본 처리).

| 호출 | 설명 | 오류 |
|---|---|---|
| `POST /pair/code { vehicleId, gear }` | P일 때만. `{ code(6자리), url, expiresAt(5분) }`. 새 코드를 내면 안 쓴 이전 코드는 무효 | 403 `not_parked`, 409 `already_paired`, 400, 429 |
| `POST /pair/claim { code, consent: true }` | `{ accountId, token, vehicleId }`. 차 1대에 차주 1명. **`consent: true` 필수**(없거나 false면 400 `consent_required`, 동의 시각을 `accounts.consent_at`에 기록). 토큰은 API scope(180일) | 400 `consent_required`, 404 `code_not_found`, 410 `code_expired`/`code_used`, 409 `already_paired`, 429 |
| `GET /pair?vehicleId=` | `{ paired, pairedAt? }` | 400 |
| `DELETE /pair` | 차주 토큰 또는 그 차 차량 토큰(Bearer). 계정·토큰 삭제, 그 계정의 게스트 세션 종료 | 401, 403(게스트 토큰), 404 `not_paired` |
| `POST /guest/code { vehicleId, gear }` | P만. `{ code, url, expiresAt }` | 403 `not_parked`, 409 `guest_limit`, 400, 429 |
| `POST /guest/claim { code, consent: true, nickname? }` | `{ sessionId, token }`. 동의 없으면 400 `consent_required`(세션 안 열림). Bearer(차주·기존 게스트 토큰)를 주면 그 계정으로 앉는다 | 400, 401, 403(차량 토큰), 404, 410, 409 `guest_limit`/`already_in_session`/`own_vehicle`, 429 |
| `POST /guest/:id/end` | 게스트 본인(Bearer), 그 차 차량·차주 토큰, 인증 off일 때 본문 `{ vehicleId }`가 세션 차량과 같은 차. 다시 불러도 200 `alreadyEnded: true` | 401, 403, 404 |
| `POST /guest/end-all { vehicleId }` | 차주 '모두 내리기'. `{ ok, ended }` | 400, 401, 403 |
| `GET /guest/sessions?vehicleId=` | `{ active: n }`(차주는 인원만) | 400 |
| `DELETE /guest/:id/data` | 게스트가 세션 기록 삭제(Bearer, 본인만) | 401, 403, 404 |
| `GET /me/summary` · `GET /me/regions` | Bearer(차주 또는 게스트 API 토큰). 차주는 내 차량 **+ 내가 게스트로 탄 기록**, 게스트는 앉았던 세션의 기록만. `{ role, vehicleId?(차주), activeSessionId(차주도, 게스트로 탄 세션이 열려 있으면 값), regions:{total,colored,byLevel,depop}, coverage:{nationalPercent,drivenKm,totalKm,roadsStarted,roadsCompleted}, snapshotMonth }` / `{ items:[{code,name,displayName,sidoName,level,depop92,lastAt}] }` | 401, 503 |
| `POST /share/cards { vehicleId, kind: 'national'\|'trip'\|'road', tripIds?, roadKey? }` | `{ id, url(/s/:id), imageUrl(.png) }`. PNG를 만들 때 한 번 렌더해 저장한다 | 400, 404 `trip_not_found`/`road_not_found`, 409 `too_short`/`not_completed`/`trip_not_eligible`(전부 의심 트립), 503 `png_unavailable`(변환기 없음)·`roads_db_unavailable`, 429 |
| `GET /share/cards/:id.png` · `DELETE /share/cards/:id?vehicleId=` | 저장된 PNG(토큰 없이 열림, id는 추측 불가, `private, max-age=300`, CSP `sandbox`). **`.svg` 공개 경로는 없다** | 404 |
| `GET /regions/:code/intro?lat=&lon=` | `{ sample, source:'한국관광공사', code, displayName, items:[{kind,title,lat,lon,addr?,distanceM?}] }`(종류별 가까운 순 3개) | 400, 404, 502 `tourapi_unavailable`, 503 |
| `GET/PUT /vehicles/:id/settings` | `{ recordingPaused, homeRegion, statsOptIn, drivingMap, hideHomeInCards, consentWithdrawnAt }`. PUT은 부분 갱신 | 400 `invalid_region` 등 |
| `DELETE /vehicles/:id/data` | 트립·점·매칭·인정 도로·시군구·공유 카드·게스트 기록 즉시 삭제, 기록 멈춤·동의 철회 표시. `{ ok, deleted:{trips,points,ways,regions} }` | - |
| `GET /reports/daily?vehicleId=&date=YYYY-MM-DD` · `monthly?month=YYYY-MM` (KST) | `{ date\|month, tripCount, distanceKm, newKm, newWays, revivedKm, newRegions, newStays, (monthly) daysDriven }` | 400 `invalid_date`/`invalid_month` |
| `GET /coverage/roads?...&filter=almost` | 완주율 80% 이상 95% 미만 | 400 `invalid_filter` |
| `POST /debug/age { vehicleId, days }` | 마지막 인정·판정 시각을 days일 당긴다. production(`NODE_ENV`)·`ext.debug=false`에서는 라우트가 없다 | 400 |
| `GET /b2b/regions/:code/monthly?month=` | Bearer `NUBI_B2B_KEY`. `{ code, displayName, month, k:5, pass, visit, stay, dwell3h }`, 칸은 `{ vehicles: n }` 또는 5대 미만이면 `{ vehicles: null, suppressed: true }` | 401, 429, 503 `b2b_not_configured`, 400, 404 |
| `POST /b2b/courses { name, regionCode, roadKeys }` · `GET /b2b/courses` | 코스 등록(201)·목록. 응답에 `lengthKm` | 400 `unknown_road`/`invalid_region` |
| `GET /b2b/courses/:id/completions?month=` | 그 달 완주 차량 수(k=5 숨김) | 404, 400 |
| `GET /courses` | 공개 목록 `{ items:[{id,name,regionCode,lengthKm}] }`(도로 키는 내보내지 않음) | - |
| `POST /courses/:id/certificate { vehicleId }` · `GET /c/:id` | 완주한 차량만 발급 → `{ id, number, url(/c/:id) }`(멱등). `/c/:id`는 추측 불가 id의 공개 HTML이고 URL에 차량 ID가 없다. 발급 시점의 코스 정보를 스냅샷으로 보관(차량 ID·운전자·날짜 없음, 판정 근거 문구는 실제 기준 95%) | 400, 404, 409 `not_completed`, 503 |
| `GET /g/:code` · `POST /g/:code/join` | 게스트 웹 페이지(동의 체크 → 세션 → `303 /me?t=`) | 404/410/429/409 페이지 |
| `GET /p/:code` · `POST /p/:code/join` | 차주 연결 웹 페이지 | 〃 |
| `GET /me` · `GET /me?v=<24h 링크>` · `POST /me/link` · `POST /me/leave` · `POST /me/delete-session` · `POST /me/withdraw` · `DELETE /me` | 내 지도 요약 페이지(쿠키 `nubi_me`: HttpOnly·SameSite=Lax·https면 Secure, 7일). `?v=`는 24시간 읽기 전용 링크로 쿠키를 심고 `/me`로 보낸다(주소에서 토큰 제거). 내리기·기록 삭제·탈퇴 폼은 `web` 쿠키만(읽기 전용 `view`는 불가). `POST /me/link`(Bearer)가 24시간 링크를 낸다. `DELETE /me`는 게스트 API 탈퇴(세션 기록·닉네임·계정 삭제) | 401 페이지 |
| `GET /s/:id` | 공유 카드 페이지(이미지·줄 글·OG 태그) | 404 페이지 |

기존 응답 변경: `/coverage/segments` 항목 `properties.faded`, `/regions/list` 항목 `faded`, `/regions/geo` `properties.faded`, `/coverage/summary` `revivedKm`, `/vehicles/register`에 `vehicleToken`(`NUBI_AUTH`가 `off`가 아닐 때만), 기록 멈춤 중 `POST /trips/:id/points`는 `{ accepted: 0, duplicated: 0, paused: true }`(200).

## 바램·되살린 거리 (plan 8장)
- `shared/fade.ts` `isFaded(lastAt, now, days=365)`: 365일이 **지났으면**(초과) true. 완료율·등급은 그대로이고 표시용 `faded`만 계산한다. 저장하는 것은 마지막 시각뿐.
- 되살린 거리: `driven_ways`의 `last_driven_at`이 UPDATE로 365일 넘게 앞서면 DB 트리거가 `way_revived`에 한 줄을 더한다(매칭 파이프라인 무수정). 길이는 트리거가 도로 DB를 볼 수 없어서 조회 때 `rd.ways.eff_length_m`과 합친다(`revivedKm`).
- `POST /debug/age`는 `first/last_driven_at`, `visited_regions.first/last_at`을 당긴다(트리거는 감소에는 반응하지 않는다).

## 월간 재계산 (`scripts/recompute-coverage.mjs`)
`node scripts/recompute-coverage.mjs --roads <새 도로 DB> [--db <nubi.sqlite>] [--apply]`. 기본은 읽기만 하고 차량별 새 달 집계(달린 m·분모·완료율·시작/완주 도로·새 DB에 없는 way 수)와 직전 스냅샷 값을 JSON으로 출력한다. `--apply`는 `coverage_snapshots`에 기록하고 새 DB에 있는 way의 `snapshot_month`를 새 달로 맞춘다. 새 DB에 없는 way는 지우지 않는다(분자에서만 빠진다). 집계식은 서버 `DRIVEN_CTE`·`ROAD_DRIVEN_CTE`의 사본이고 테스트가 같은 값인지 확인한다.

## 토큰 인증 (`NUBI_AUTH`)
- 토큰은 32바이트 무작위 base64url이고 DB에는 SHA-256 해시만 저장한다. 종류: 차량 토큰(register 응답, 차량당 최근 5개, 만료 없이 폐기만), 계정 토큰(차주·게스트). 계정 토큰 scope: `api`(Bearer, 180일), `web`(쿠키, 7일, 내리기·삭제 가능), `view`(24시간 읽기 전용). `auth_tokens.expires_at`·`revoked_at`로 만료·폐기하고(연결 해제 = 폐기) Bearer API는 `api` scope만 받는다.
- `optional`: Bearer가 있을 때만 검증(틀리면 401, 다른 차량이면 403). `required`: 모든 API에 Bearer 필요. 요청이 가리키는 **모든** 차량 ID(쿼리 `vehicleId`(반복 키 포함)·`/vehicles/:id/…` 경로·`/trips/:id…`의 트립 소유 차량·JSON 본문 `vehicleId`/`toVehicleId`/(alias 외) `fromVehicleId`)를 모아 하나라도 토큰 범위 밖이면 403. 본문을 16KB까지 읽지 못하면 413 fail-closed(트립 점 업로드는 본문을 파싱하지 않고 경로의 트립 소유만 본다). 게스트 계정은 차량 API 접근 불가.
- alias(`POST /vehicles/alias`): `toVehicleId`는 토큰 범위여야 하고, `fromVehicleId`는 토큰이 있는 정본·차주 연결된 차량·다른 alias의 대상이면 409 `alias_source_is_vehicle`(모든 모드). **인증 모드(optional·required)에서는 트립·인정 도로·시군구 기록이 하나라도 있는 ID도 출발점이 될 수 없다**(그 기록은 이미 누군가의 것). `off`에서는 차량 앱이 UUID로 올린 트립을 나중에 서버 ID에 잇는 기존 흐름을 위해 데이터 검사를 하지 않는다.
- 본문 한도: 앱 전역 1MB(`content-length`를 먼저 보고 스트림도 센다, 미들웨어가 라우트보다 앞), settings·debug·B2B·share는 더 작게(1~8KB).
- `off`에서도 파괴적·민감 호출(`DELETE /vehicles/:id/data`, `PUT /vehicles/:id/settings`, `POST /pair/code`, `POST /guest/code`, `POST /guest/end-all`)은 **로컬 접속(127.0.0.1·::1)만** 허용한다. 차량 에뮬레이터 트래픽도 호스트에서는 127.0.0.1로 보인다(10.0.2.x는 로컬이 아니다). **소켓 주소를 모르면 로컬이 아니다**(fail-closed). 신뢰 프록시 설정이 없는데 프록시 헤더(`X-Forwarded-For`·`Forwarded`·`X-Real-IP`)가 있으면 로컬이 아니다. 맞는 차량 토큰이 있으면 원격에서도 허용(optional). 차량 앱의 트립 업로드·조회 경로는 그대로다.
- **공개 배포는 `NUBI_AUTH=optional` 이상이 필수이고, `off`는 로컬 개발 전용이다**(off의 보호는 위 로컬 제한뿐이다).
- 본문 파싱(C1): 미들웨어가 JSON 본문을 **한 번만** 파싱해(Fetch 표준: UTF-8, 앞의 BOM 제거, UTF-16 등은 실패) 컨텍스트에 두고 범위 검사와 **모든 라우트**(`trips`·`vehicles` 포함)가 그 값만 쓴다(`bodyOf(c)`, 라우트가 `c.req.json()`을 직접 부르지 않는다). 인증 모드에서 비어 있지 않은 본문이 파싱에 실패하거나 JSON 객체가 아니면(배열·문자열·숫자·null) 미들웨어가 400 `invalid_body`로 막는다. 빈 본문은 라우트가 400. 폼 페이지(`/g`·`/p`·`/me`)는 JSON 파싱 대상이 아니다.
- 경로 정규화: 차량 경로 판정은 점 구간·연속 슬래시·끝 슬래시를 접고 구간을 디코드한 경로로 한다(`/vehicles/V/./data` 우회 방지). `/vehicles/:id/…` 전체(alias·register 제외)를 차량 경로로 본다. 디코드할 수 없으면 400. 경로 파라미터에 차량 ID를 받는 새 라우트는 `vehicleScoped(deps)` 가드(기본 거부)를 함께 단다.
- 면제: `/health`, `POST /vehicles/register`, `POST /pair/claim`, `POST /guest/claim`, 웹 페이지(`/g`·`/p`·`/me`·`/s`·`/c`), `/b2b/*`(자체 키), `/viewer`, `GET /share/cards/*`, `GET /courses`.
- 코드 시도 제한: 출처(IPv6는 /64 단위)별 실패 10회/5분을 넘으면 맞는 코드도 429. 전역 잠금은 없다(서비스 거부 방지). 전체 실패가 많으면 실패 응답에 지연(최대 2초)만 건다. 한 코드를 건드린(페이지 열람·claim) 횟수가 8회를 넘으면 그 코드는 무효(410 `code_used`). JSON API와 웹 페이지가 한 카운터를 쓴다. 출처별 제한·카드·B2B 키 실패 제한은 메모리라 재시작하면 초기화된다.

## 배포 설정 (프록시·쿠키)
- 서버 앞에 리버스 프록시(예: nginx·ALB)가 n개 있으면 `NUBI_TRUST_PROXY=n`. 클라이언트 주소는 X-Forwarded-For의 **오른쪽에서 n번째**(프록시가 덧붙인 값)이고 맨 왼쪽은 클라이언트가 위조할 수 있어 쓰지 않는다. 프록시는 들어온 XFF를 지우지 말고 **뒤에 덧붙여야** 한다(프록시가 있는데 미설정이면 로컬 판정은 fail-closed, 시도 제한은 모든 사용자가 프록시 주소 하나로 묶인다). XFF가 n개보다 짧으면 소켓 주소로 돌아간다.
- 같은 설정이 있을 때만 `X-Forwarded-Proto: https`를 믿어 쿠키에 `Secure`와 `__Host-` 접두사를 붙인다. 공개 주소가 https(`NUBI_PUBLIC_URL`)여도 같다. http 개발에서는 접두사 없는 `nubi_me`. 읽을 때는 두 이름을 모두 본다.
- POST 웹 페이지(`/g|p/:code/join`, `/me/leave|delete-session|withdraw`)는 Origin(없으면 Referer)이 있으면 서비스 호스트와 같아야 하고 아니면 403(헤더가 없으면 통과). 쿠키는 SameSite=Lax라 이중 방어다.

## 게스트 규칙 구현
- 인정 기준은 하나: **트립의 점 중 시각이 세션 창(시작~종료)에 드는 부분**. 트립 규칙(P 5분 등)은 바꾸지 않았고, 정차 중 탑승·하차(트립 도중)도 겹친 구간만 인정한다.
  - 도로: 읽을 때(`/me/*`·`/me` 페이지) 겹친 점이 만드는 경로 30m 안에서 **차량이 인정한 way**(`driven_ways`)를 찾아 커버리지(덮인 비율)를 트립 단위로 `guest_trip_ways`에 계산해 둔다. 인정 기준은 매칭과 같다(70% 이상 또는 덮은 길이 500m 이상). 차량 MAX 커버리지를 복사하지 않는다. 확정 매칭(`done`, outcome `counted`)이 끝난 트립만이고 창·점 수가 바뀌면 다시 계산한다.
  - 시군구: 같은 겹친 점으로 통과를 판정하고(의심 트립 제외), 방문·숙박은 트립의 마지막 점이 창 안일 때(내리기 전에 도착)만 `region_events`에서 인정한다.
- 차주 계정이 다른 차에 게스트로 탄 기록은 `/me/summary`·`/me/regions`·`/me` 페이지의 도로·시군구·완료율에 내 차량 기록과 합쳐 보인다(way·시군구별 최댓값).
- 종료(먼저 오는 것): 내리기 · `end-all` · 마지막 트립 종료(진행 중이면 마지막 점) 후 12시간(읽기·claim·새 트립 시작 때 게으르게 적용, 종료 시각은 마지막 활동 + 12시간) · 게스트(차주 계정)가 자기 차에서 트립을 시작(`POST /trips` 성공 응답을 미들웨어가 본다).
- 겹침: 같은 계정이 열린 세션이 있으면 새 세션은 409. 세션 전 트립은 소급하지 않는다. 웹에서 차주 쿠키로 `/g/:code/join`하면 그 차주 계정으로 앉는다(새 익명 계정·쿠키 재발급 없음).
- 캐시: 게스트 도로 계산은 (세션 창·겹친 점 수·그 차량 `driven_ways` 갱신 버전)이 같으면 재사용하고, 시군구 계산도 입력 서명이 같으면 재사용한다.
- 삭제: 세션 삭제는 도로 기록과 닉네임(`guest_sessions.nickname`)을 지운다. 게스트 탈퇴(`DELETE /me`, 웹 `/me/withdraw`)는 세션·닉네임·토큰·계정을 지운다.
- 주의: 이 판정은 `driven_ways`를 **읽기만** 한다. `driven_ways`를 바꾸는 DB 트리거(되살림 `way_revived`)는 확정 매칭(`runMatching`의 upsert)만 대상이어야 한다. **T1의 실시간 잠정 매칭은 `driven_ways`에 쓰면 안 된다**(완료율·도감·되살림에 섞인다).

## 삭제·매칭 경합 (M3)
`DELETE /vehicles/:id/data`(동의 철회)가 진행 중인 매칭과 겹쳐도 결과가 되살아나지 않게, 결과를 쓰기 **직전**(같은 틱)에 `tripDataState(db, tripId)`로 트립 존재와 `consent_withdrawn_at`을 다시 확인한다. 지워진 트립(`deleted`)은 아무것도 쓰지 않고(`skipped`/`trip_deleted`), 철회 상태(`withdrawn`)는 `skipped`/`consent_withdrawn`으로 끝낸다. 지역 판정 작업(`region_jobs`)도 같은 확인 뒤 지운다. 기록 차단 판정 `isRecordingBlocked(db, vehicleId)`(기록 멈춤 또는 철회)는 `POST /trips/:id/points`에 적용되고 **`GET /trips/:id/live`도 같은 훅을 쓴다**: 차단된 차량은 `{ status: 'idle', upToSeq: -1, ways: [], paused: true }`를 받고 T1의 라우트는 불리지 않는다(T1은 `ext.routes`보다 뒤에 붙이고, 잠정 결과를 쓰기 직전 `tripDataState`를 부른다).

## 비식별 규칙
- 공유 카드·`/me`·인증서의 SVG/HTML에는 **픽셀 좌표와 글자만** 들어간다. 위경도 원본, way id, road key, 트립 id, 차량 ID, 날짜·시각(월 단위 표기만)을 넣지 않는다(테스트가 소수 4자리 이상 숫자·id 문자열을 검사한다).
- 이미지는 **PNG만** 공개한다(래스터). 만들 때 SVG를 렌더해 PNG로 1회 변환·저장하고(SVG는 내부 보관, 변환기가 없으면 생성 503) 좌표는 **정수 픽셀**로 양자화·단순화(점 간격 솎기)한다. 응답에 CSP `sandbox`·`private, max-age=300`.
- 전국 카드는 전국 축척 고정(좌표·날짜 없음). 여행 카드는 의심(suspect) 트립을 빼고, 트립마다 출발·도착 반경 1km 안의 점과 경로를 따라 300m를 더 지운 뒤(경계에 남는 첫 조각이 1km 지점을 드러내지 않게) '내 지역'(`homeRegion`, `hideHomeInCards` 기본 켜짐) 구간을 숨긴 뒤 남은 조각만 확대한다(틀 최소 0.06도). 남는 것이 없으면 409 `too_short`. 도로 카드는 완주(95%+) 도로 전체만, '내 지역' 구간은 숨긴다.
- 모든 카드에 `© OpenStreetMap contributors`와 `누비`. 원본 데이터 내보내기 API는 없다(OSM ODbL).
- 응답·로그에 VIN·좌표·토큰을 남기지 않는다. TourAPI 키는 요청 URL에만 쓰고 로그엔 오류 분류 코드만 남긴다.
- B2B: 차량 단위·월 단위, 5대 미만 칸 숨김, '내 지역'이 그 시군구인 차량과 익명 통계 참여를 끈 차량 제외, 응답에 차량 ID·좌표 없음. 통과 = 매칭 결과 `regions.passed`, 방문·숙박 = `region_events`(그 달), 체류 3시간 = 트립 종료~다음 트립 시작(종료 지점이 그 시군구, 7일 넘는 간격 제외) 하루(KST) 합계 3시간 이상인 날이 있는 차량.

## 테이블 (`schema-ext.ts`)
`way_revived`(`cov` 열: 되살린 길이 = 유효 길이 x 커버리지, 같은 차량(alias 포함)의 이전 마지막 시각 기준 UPDATE·INSERT 트리거, 중복 방지 유니크), `coverage_snapshots`, `accounts`, `auth_tokens`(`scope`·`expires_at`·`revoked_at`), `link_codes`(`attempts`), `guest_sessions`, `guest_trip_ways`·`guest_trip_cache`, `vehicle_settings`, `share_cards`(`png`), `intro_cache`(`fetched_at`)·`intro_calls`, `courses`, `certificates`. 테이블·열 이름에 `vin` 부분 문자열이 들어가면 기존 'VIN 미저장' 테스트가 실패하므로 피한다(그래서 `drive_map`).

## 기록 멈춤의 정의(2026-11-12 확정)
**기록 멈춤 = 이후 기록만 멈춘다**(plan 11-2 '일시 중지 요구권'). 멈춤 판정은 요청이 **도착한 시각이 아니라 기록된 시각**(트립 `startedAt`, 점 `ts`)이 멈춤 구간 안인지로 한다. 멈춤 전에 기록됐지만 늦게(오프라인 백로그 등) 올라온 데이터는 받아 정산하고, 폰에서 멈췄다 켠 구간의 점은 올라오는 시점과 무관하게 제외한다. 이미 쌓인 기록은 그대로이며 지우는 일은 '데이터 지우기'(동의 철회)가 맡는다.
- 구간 테이블 `recording_pauses(vehicle_id, paused_at, resumed_at)`(정본 차량 기준, `schema-ext.ts`). `PUT /vehicles/:id/settings`가 `recordingPaused`를 켜면 구간을 열고(열린 구간이 있으면 그대로) 끄면 닫는다. 데이터 삭제 때는 옛 구간을 지우고 새 구간을 연다.
- **의도 시각**: `recordingPaused`를 바꾸는 요청은 `intentAt`(ISO, 그 기기 시계)을 실을 수 있다. 구간의 시작·끝은 `intentAt`이고(없으면 서버 시각), **마지막 멈춤 상태 변경 시각보다 오래된 `intentAt`은 무시하고 현재 값을 돌려준다**(다른 기기가 더 늦게 바꾼 상태를 되돌리지 않는다. 오래된 켜기를 보낸 차량은 `recordingPaused:false` 응답을 받으면 대기를 버리고 서버 값을 따른다). 기기 시계가 서로 다르면 기기 간 순서는 그 시계 차이만큼 어긋날 수 있다.
- `POST /trips`(새 트립): 동의 철회면 항상 막고, 멈춤이면 `startedAt`이 열린·닫힌 구간 **안**일 때만 막는다(200 `{ paused:true, pausedAt }`, 행 없음). 멈춤 전에 시작한 트립은 받는다. 같은 `(vehicleId, localId)`가 **정본·alias 어느 ID로든 이미 있으면** 차단보다 멱등 응답(기존 tripId)이 먼저다(다른 ID로 만든 행이면 그 tripId를 그대로 돌려주고 중복 행을 만들지 않는다).
- `POST /trips/:id/points`: 점마다 `ts`가 구간 안이면 그 점만 버리고 나머지는 저장한다. 응답은 `{ accepted, duplicated, dropped? }`, 전부 구간 안이면 `{ accepted:0, duplicated:0, paused:true, dropped }`. 동의 철회면 전부 버린다(`paused:true`).
- `POST /trips/:id/end`: **동의 철회일 때만** 막는다(200 `{ paused:true }`). 단순 멈춤이면 End를 받아 정산(매칭 큐)한다.
- 차량 업로더는 `POST /trips`가 `paused`면 그 트립이 **멈춤 뒤에 시작한 경우에만**(`startedAt >= pausedAt` 또는 `pausedAt` 없음=철회) 큐에서 버리고, 점 응답이 `paused`·`dropped > 0`이면 차량도 즉시 멈춘다(서버 설정을 다시 읽는다).
- 구현은 `routes/account.ts`의 사전 미들웨어이고(`/trips`보다 앞) 라우트(`trips.ts`)는 그대로다(점 필터는 같은 본문 객체를 걸러서 넘긴다).

## 한계
- 기록 멈춤은 서버에서 **점 업로드를 저장하지 않는 것**까지만 한다(트립 시작·종료는 받는다). 차량이 설정을 읽어 멈추는 쪽은 T4.
- 게스트 도로는 '차량이 인정한 way ∩ 겹친 점 30m 이내'라서 차량이 그 way를 인정하지 않았으면(매칭 실패 등) 게스트도 못 받는다. 점 간격이 200m를 넘는 구간은 이어 보지 않는다.
- 여행 카드는 원시 궤적(`trip_points`, 30일 보관 가안)을 쓴다. 매칭된 way는 트립별로 저장하지 않아서 궤적이 지워진 트립은 카드를 만들 수 없다.
- 코스 완주 월 구분은 '코스 도로 중 가장 늦은 마지막 인정 시각이 그 달'인 근사다(완주 시각을 따로 저장하지 않는다).
- B2B 체류 집계는 트립·점을 훑는 O(트립 수) 계산이다(캐시 없음). 지자체 월 리포트용 배치로 돌리는 규모를 가정한다.
- TourAPI는 키가 없어 실호출을 해 보지 못했다(가짜 fetch 테스트만). 응답 필드(`mapx`·`mapy`·`title`·`addr1`·`dist`)는 KorService2 문서 기준 추정이다.
- PNG는 시스템 글꼴을 쓴다(macOS 기본 한글 글꼴 확인). 한글 글꼴이 없는 Linux 컨테이너에서는 `NUBI_CARD_FONT`를 지정해야 한다.
- register가 VIN만 알면 차량 토큰을 내준다(plan 12-2의 VIN 대입 표면은 그대로). 토큰이 가리키는 차량을 라우트가 직접 꺼내 쓰는 방식까지는 가지 않았다(미들웨어가 요청이 가리키는 모든 차량을 검사한다).
- 인증 `required`에서 `/viewer`는 토큰을 못 실어 열리지만 그 안의 API 호출은 401이다(시연용 페이지).

## 변경 이력 (리뷰 반영, 2026-11-11)
폰(T3)·차량(T4)이 맞춰야 하는 변경이다. 처음 구현에서 바뀐 경로·응답·오류 코드만 적는다.

| 대상 | 이전 | 이후 | 영향 |
|---|---|---|---|
| `POST /pair/claim` | `consent`는 보내면 true | **`consent: true` 필수**(없거나 false면 400 `consent_required`) | T3: 연결 때 `consent: true` 전송 |
| `POST /pair/claim`·`/guest/claim` 응답 `token` | 만료 없음 | API scope, **180일 만료**, 연결 해제 시 폐기(`revoked_at`). 만료·폐기면 401 | T3: 401이면 다시 연결 |
| `GET /me?t=<token>` | 장기 토큰이 URL에 | **제거**. `/me`는 쿠키(`nubi_me`) 또는 `?v=<24시간 읽기 전용 링크>`(→ 쿠키로 바꾸고 `/me`로 303). `?t=`는 401 | T3: 웹 링크는 `POST /me/link`(Bearer)로 받는다 → `{ url, expiresAt }` |
| `GET /g/:code`·`/p/:code` 가입 | 303 `/me?t=<API 토큰>` | 303 `/me` + `Set-Cookie: nubi_me`(HttpOnly·SameSite=Lax·https면 Secure), API 토큰 미발급. 같은 브라우저 재참여는 같은 게스트 계정 | - |
| `POST /me/leave`·`/me/delete-session` | 폼의 토큰 | 쿠키 `web` scope만(읽기 전용 링크는 401). `POST /me/withdraw` 추가 | - |
| `DELETE /me` | 없음 | 게스트 API 탈퇴(세션·닉네임·계정 삭제). 차주는 403 | T3: 게스트 탈퇴 |
| `POST /me/link` | 없음 | Bearer → `{ url(/me?v=…), expiresAt(24시간) }` | T3 |
| `GET /me/summary` | 게스트는 `activeSessionId`, 차주는 `vehicleId` | 차주도 `activeSessionId` 포함(게스트로 탄 세션), 차주 값은 **내 차량 + 게스트로 탄 기록** 합산 | T3 |
| 게스트 인정 | 세션 중 `driven_ways` 변경의 마지막 시각 기준(차량 MAX 복사) | **트립 점 시각이 세션 창과 겹치는 부분**, 도로 커버리지는 겹친 점이 덮은 비율, 시군구 방문·숙박은 내리기 전 도착일 때만 | 정차 중 탑승·하차 결과가 이전보다 적다 |
| `GET /share/cards/:id.svg` | SVG | **404**(PNG만 공개) | T3·T4: `imageUrl`은 항상 `.png` |
| `POST /share/cards` | 변환기 없으면 `.svg` imageUrl | 변환기 없으면 **503 `png_unavailable`**. 새 409 `trip_not_eligible`(고른 트립이 전부 의심) | T3: 오류 처리 |
| `GET /courses/:id/certificate?vehicleId=` | HTML(차량 ID가 URL에) | **제거**. `POST /courses/:id/certificate { vehicleId }` → `{ id, number, url(/c/:id) }`(멱등, 완주 아니면 409 `not_completed`), 조회는 공개 `GET /c/:id` | T3: 인증서 링크 형태 |
| 인증서 문구 | `완주 구간 100%` | `코스 도로 N개를 모두 완주율 95% 이상으로 완주` | - |
| `POST /vehicles/alias` | 중복·충돌만 검사 | `toVehicleId`가 토큰 범위 밖이면 403, `fromVehicleId`가 이미 정본(토큰·차주 연결·alias 대상)이면 409 `alias_source_is_vehicle` | T4: 새 UUID만 `from`으로 |
| 토큰 범위 검사(`optional`·`required`) | 쿼리 → 경로 → 트립 → 본문 중 **첫 번째** 하나 | 요청이 가리키는 **모든** 차량(반복 쿼리·경로·트립 소유·본문)이 범위 안이어야 함. 본문 16KB 초과면 413 | T4: 한 요청에 서로 다른 차량 ID를 섞지 않는다 |
| 인증 `off`의 `DELETE /vehicles/:id/data`·`PUT /vehicles/:id/settings`·`POST /pair/code` | 누구나 | **로컬 접속만**(원격·프록시 경유는 403 `local_only`), 맞는 차량 토큰이면 허용(optional) | T3(폰이 원격에서 호출)은 토큰(`optional` 이상)이 필요. 차량 에뮬레이터(10.0.2.2)와 호스트 로컬은 그대로 |
| 본문 한도 | 라우트마다(트립 1MB·vehicles 4KB) | 앱 전역 1MB를 미들웨어가 라우트보다 먼저 적용, settings·debug·B2B·share는 1~8KB. 초과 413 `payload_too_large` | - |
| 코드 시도 제한 | 출처별 실패 10회 + 전역 잠금 | 출처(IPv6 /64)별 + 코드별 8회 무효화(410 `code_used`), 전역 잠금 대신 지연 | - |
| `GET /regions/:code/intro` | 위치 검증 없음, API `dist` 노출 | `lat`·`lon`은 그 시군구 bbox 안이어야 함(아니면 400 `invalid_point`), 외부엔 0.01도 반올림 좌표, `distanceM`은 요청마다 재계산, 출처별·일일 호출 상한 초과 429 `rate_limited`, 캐시 24시간 | T3·T4: 429 처리 |
| `revivedKm` | 다시 달린 way의 유효 길이 전체 | **유효 길이 x 커버리지**(다시 달린 만큼), 같은 차량(alias 포함)의 이전 마지막 시각 기준, alias INSERT 경로 포함, 중복 누적 없음 | 값이 이전보다 작거나 같다 |
| `POST /debug/age` | NODE_ENV가 production이 아니면 켜짐 | **`NUBI_DEBUG=1`일 때만**(production이면 항상 꺼짐), 옵션 `ext.debug`가 덮음 | 시연 서버는 `NUBI_DEBUG=1`로 띄운다 |
| 여행 카드 | 반경 1km 제거, 의심 트립 포함 | 의심 트립 제외, 경로를 따라 300m 추가 절단, 좌표 정수 px | - |
| 데이터 삭제 | 삭제 후 진행 중 매칭이 결과를 쓸 수 있음 | 쓰기 직전 트립·동의 철회 재확인(경합 방지) | - |
| 스키마 | `extRoutes()`가 만듦 | `openDb()`가 만듦(+열 마이그레이션) | - |
| `app.ts` 연결 | `.route('/', extRoutes(...))`를 `/health` 뒤에 | `.use('*', ext.middleware)`를 **체인 맨 앞**, `.route('/', ext.routes)`는 아무 데나 | T1 합칠 때 |

### 변경 이력 추가분 (재리뷰 반영)
| 대상 | 이전 | 이후 | 영향 |
|---|---|---|---|
| JSON 본문 해석 | 미들웨어(`Buffer.toString`+`JSON.parse`)와 라우트(`Request.json()`)가 따로 읽음(BOM 본문으로 범위 검사 우회) | 미들웨어가 한 번 파싱(Fetch 표준, BOM 제거)해 모든 라우트가 같은 값 사용. 인증 모드에서 비어 있지 않은 본문의 파싱 실패·비객체 JSON은 400 `invalid_body` | T3·T4: 본문은 UTF-8 JSON 객체여야 한다(BOM은 허용) |
| 차량 경로 인식 | `/vehicles/:id/(settings\|data)`만, 원본 경로 | `/vehicles/:id/…` 전체, 정규화한 경로(점 구간·`//`·끝 슬래시), 디코드 실패 400 | - |
| alias 출발점(인증 모드) | 토큰·차주·alias 대상만 거부 | + 트립·인정 도로·시군구 기록이 있는 ID도 409 | T4: `from`은 데이터가 없는 새 UUID만(인증 모드). off는 기존대로 |
| `off`의 로컬 판정 | 주소를 모르면 로컬, 10.0.2.x 허용, 프록시 헤더가 있으면 비로컬 | 주소를 모르면 **비로컬**, 10.0.2.x 비로컬, 신뢰 프록시 설정 시 오른쪽에서 n번째 주소로 판정 | 공개 배포는 optional 이상 필수 |
| `off`의 민감 호출 | data 삭제·settings 변경·pair/code | + `POST /guest/code`·`POST /guest/end-all` | T4: 차량 에뮬레이터는 호스트에서 127.0.0.1로 보여 영향 없음 |
| `NUBI_TRUST_PROXY` | `1`이면 XFF 맨 왼쪽 | `<홉 수>`, XFF 오른쪽에서 n번째 | 배포 설정 절 |
| 웹 차주의 `/g/:code/join` | 새 익명 게스트 계정 + 쿠키 덮어쓰기 | 차주 계정으로 앉고 쿠키는 그대로 | - |
| 웹 쿠키 | `nubi_me`, Secure는 공개 주소가 https일 때만 | https면 `__Host-nubi_me`+Secure(공개 주소·신뢰 프록시의 X-Forwarded-Proto), 읽기는 두 이름 | - |
| `?v=` 링크 | 항상 view 쿠키로 교체 | 기존 web 쿠키가 있으면 덮어쓰지 않음 | - |
| POST 웹 페이지 | 출처 검사 없음 | Origin/Referer이 다른 호스트면 403 | - |
| 이전 계정 토큰(`expires_at` NULL) | 만료 없음 | 마이그레이션으로 생성 후 180일 | - |
| `GET /regions/:code/intro` | 캐시·외부 호출이 (시군구·반올림 좌표) 단위, 출처별 60회/5분 | **시군구 단위**(좌표 무관, 시군구 중심 반올림 좌표로 호출), 출처별 20회/5분 | - |
| `POST /share/cards` 제한 | 차량 ID 기준 | 토큰(있으면)·출처 기준 | - |
