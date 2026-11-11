# 05b. 서버 확장 (T2, 2026-11-11 야간)

계약서 `05-night-plan.md` 3장 'T2 소유'의 구현 사양이다. 서버(`server/`)와 `scripts/recompute-coverage.mjs`만 바뀌었다. 기획서 7-4·8·9·10·11-2·12-2·12-3이 원 기획이고, 이 문서가 구현된 모양이다.

## 코드 배치
- 라우트: `server/src/routes/{pair,guest,share,intro,account,reports,b2b,pages}.ts`, 한 줄 진입점 `routes/ext.ts`(`app.ts`는 `extRoutes()` 한 줄만 더했다. 인증 미들웨어가 뒤의 라우트(T1 `/map` 등)까지 덮도록 체인 앞쪽, `/health` 바로 뒤에 둔다).
- 공용: `server/src/ext/{auth,sessions,stats,cards,render,html,tourapi,settings,util}.ts`, `server/src/shared/fade.ts`, 테이블 `server/src/db/schema-ext.ts`.
- `schema.ts`는 건드리지 않았다. 확장 테이블은 `extRoutes()`가 만들 때 `ensureExtSchema(db)`로 만든다(전부 `IF NOT EXISTS`).
- 기존 파일 변경: `app.ts`(import·`ext` 옵션·`extRoutes` 한 줄·`regionsRoutes`/`coverageRoutes`에 `now` 전달), `routes/coverage.ts`(`faded`·`revivedKm`·`filter=almost`), `routes/regions.ts`(`faded`).
- 의존성 추가: `@resvg/resvg-js`(공유 카드 PNG). 없으면 SVG로 내려간다.

## 환경변수·옵션 (`createApp(db, { ext })`로도 덮는다)
| 환경변수 | 옵션 | 기본 | 설명 |
|---|---|---|---|
| `NUBI_AUTH` | `ext.auth` | `off` | `off`/`optional`/`required` |
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
| `POST /pair/claim { code, consent? }` | `{ accountId, token, vehicleId }`. 차 1대에 차주 1명. `consent`는 보내면 true여야 한다(폰이 이미 받았으면 생략) | 400, 404 `code_not_found`, 410 `code_expired`/`code_used`, 409 `already_paired`, 429 |
| `GET /pair?vehicleId=` | `{ paired, pairedAt? }` | 400 |
| `DELETE /pair` | 차주 토큰 또는 그 차 차량 토큰(Bearer). 계정·토큰 삭제, 그 계정의 게스트 세션 종료 | 401, 403(게스트 토큰), 404 `not_paired` |
| `POST /guest/code { vehicleId, gear }` | P만. `{ code, url, expiresAt }` | 403 `not_parked`, 409 `guest_limit`, 400, 429 |
| `POST /guest/claim { code, consent: true, nickname? }` | `{ sessionId, token }`. 동의 없으면 400 `consent_required`(세션 안 열림). Bearer(차주·기존 게스트 토큰)를 주면 그 계정으로 앉는다 | 400, 401, 403(차량 토큰), 404, 410, 409 `guest_limit`/`already_in_session`/`own_vehicle`, 429 |
| `POST /guest/:id/end` | 게스트 본인(Bearer), 그 차 차량·차주 토큰, 인증 off일 때 본문 `{ vehicleId }`가 세션 차량과 같은 차. 다시 불러도 200 `alreadyEnded: true` | 401, 403, 404 |
| `POST /guest/end-all { vehicleId }` | 차주 '모두 내리기'. `{ ok, ended }` | 400, 401, 403 |
| `GET /guest/sessions?vehicleId=` | `{ active: n }`(차주는 인원만) | 400 |
| `DELETE /guest/:id/data` | 게스트가 세션 기록 삭제(Bearer, 본인만) | 401, 403, 404 |
| `GET /me/summary` · `GET /me/regions` | Bearer(차주 또는 게스트 계정). 차주는 내 차량, 게스트는 앉았던 세션의 기록만. `{ role, vehicleId?(차주), activeSessionId?(게스트), regions:{total,colored,byLevel,depop}, coverage:{nationalPercent,drivenKm,totalKm,roadsStarted,roadsCompleted}, snapshotMonth }` / `{ items:[{code,name,displayName,sidoName,level,depop92,lastAt}] }` | 401, 503 |
| `POST /share/cards { vehicleId, kind: 'national'\|'trip'\|'road', tripIds?, roadKey? }` | `{ id, url(/s/:id), imageUrl(.png, 변환기 없으면 .svg) }` | 400, 404 `trip_not_found`/`road_not_found`, 409 `too_short`/`not_completed`, 503, 429 |
| `GET /share/cards/:id.png\|.svg` · `DELETE /share/cards/:id?vehicleId=` | 이미지(토큰 없이 열림, id는 추측 불가) | 404, 503 `png_unavailable` |
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
| `GET /courses/:id/certificate?vehicleId=` | 완주하면 인증서 HTML(차량 ID·운전자·날짜 없음, 번호는 코스·차량의 해시) | 400, 404, 409(미완주), 503 |
| `GET /g/:code` · `POST /g/:code/join` | 게스트 웹 페이지(동의 체크 → 세션 → `303 /me?t=`) | 404/410/429/409 페이지 |
| `GET /p/:code` · `POST /p/:code/join` | 차주 연결 웹 페이지 | 〃 |
| `GET /me?t=<token>` · `POST /me/leave` · `POST /me/delete-session` | 내 지도 요약 페이지(도감 숫자 + 공유 카드 렌더러로 그린 인라인 SVG), 게스트의 내리기·기록 삭제(폼) | 401 페이지 |
| `GET /s/:id` | 공유 카드 페이지(이미지·줄 글·OG 태그) | 404 페이지 |

기존 응답 변경: `/coverage/segments` 항목 `properties.faded`, `/regions/list` 항목 `faded`, `/regions/geo` `properties.faded`, `/coverage/summary` `revivedKm`, `/vehicles/register`에 `vehicleToken`(`NUBI_AUTH`가 `off`가 아닐 때만), 기록 멈춤 중 `POST /trips/:id/points`는 `{ accepted: 0, duplicated: 0, paused: true }`(200).

## 바램·되살린 거리 (plan 8장)
- `shared/fade.ts` `isFaded(lastAt, now, days=365)`: 365일이 **지났으면**(초과) true. 완료율·등급은 그대로이고 표시용 `faded`만 계산한다. 저장하는 것은 마지막 시각뿐.
- 되살린 거리: `driven_ways`의 `last_driven_at`이 UPDATE로 365일 넘게 앞서면 DB 트리거가 `way_revived`에 한 줄을 더한다(매칭 파이프라인 무수정). 길이는 트리거가 도로 DB를 볼 수 없어서 조회 때 `rd.ways.eff_length_m`과 합친다(`revivedKm`).
- `POST /debug/age`는 `first/last_driven_at`, `visited_regions.first/last_at`을 당긴다(트리거는 감소에는 반응하지 않는다).

## 월간 재계산 (`scripts/recompute-coverage.mjs`)
`node scripts/recompute-coverage.mjs --roads <새 도로 DB> [--db <nubi.sqlite>] [--apply]`. 기본은 읽기만 하고 차량별 새 달 집계(달린 m·분모·완료율·시작/완주 도로·새 DB에 없는 way 수)와 직전 스냅샷 값을 JSON으로 출력한다. `--apply`는 `coverage_snapshots`에 기록하고 새 DB에 있는 way의 `snapshot_month`를 새 달로 맞춘다. 새 DB에 없는 way는 지우지 않는다(분자에서만 빠진다). 집계식은 서버 `DRIVEN_CTE`·`ROAD_DRIVEN_CTE`의 사본이고 테스트가 같은 값인지 확인한다.

## 토큰 인증 (`NUBI_AUTH`)
- 토큰은 32바이트 무작위 base64url이고 DB에는 SHA-256 해시만 저장한다. 종류: 차량 토큰(register 응답, 차량당 최근 5개), 계정 토큰(차주·게스트).
- `optional`: Bearer가 있을 때만 검증(틀리면 401, 다른 차량이면 403). `required`: 모든 API에 Bearer 필요. 토큰이 가리키는 차량과 요청의 차량(쿼리 `vehicleId` → `/vehicles/:id/…` → `/trips/:id` 소유 차량 → JSON 본문 `vehicleId`/`toVehicleId`)이 다르면 403, 게스트 계정은 차량 API 접근 불가.
- 면제: `/health`, `POST /vehicles/register`, `POST /pair/claim`, `POST /guest/claim`, 웹 페이지(`/g`·`/p`·`/me`·`/s`), `/b2b/*`(자체 키), `/viewer`, `GET /share/cards/*`.
- 코드 시도 제한: 출처별 실패 10회/5분(전체 200회/5분) 넘으면 맞는 코드도 429. JSON API와 웹 페이지가 한 카운터를 쓴다. 코드·카드·B2B 키 실패 제한은 메모리라 재시작하면 초기화된다.

## 게스트 규칙 구현
- 인정: 세션이 열린 동안의 그 차량 트립. 도로는 `driven_ways` 트리거가 `guest_ways`로 옮긴다(`last_driven_at`이 세션 시간 창 안일 때). 시군구는 조회 때 계산한다: 세션 창 안에 시작한 트립의 매칭 결과 `regions.passed`(통과)와 `region_events`(트립 id에 묶인 방문·숙박).
- 종료(먼저 오는 것): 내리기 · `end-all` · 마지막 트립 종료(진행 중이면 마지막 점) 후 12시간(읽기·claim·새 트립 시작 때 게으르게 적용, 종료 시각은 마지막 활동 + 12시간) · 게스트(차주 계정)가 자기 차에서 트립을 시작(`POST /trips` 성공 응답을 미들웨어가 본다).
- 겹침: 같은 계정이 열린 세션이 있으면 새 세션은 409. 세션 전 트립은 소급하지 않는다.

## 비식별 규칙
- 공유 카드·`/me`·인증서의 SVG/HTML에는 **픽셀 좌표와 글자만** 들어간다. 위경도 원본, way id, road key, 트립 id, 차량 ID, 날짜·시각(월 단위 표기만)을 넣지 않는다(테스트가 소수 4자리 이상 숫자·id 문자열을 검사한다).
- 전국 카드는 전국 축척 고정(좌표·날짜 없음). 여행 카드는 트립마다 출발·도착 반경 1km 안의 점을 지우고 '내 지역'(`homeRegion`, `hideHomeInCards` 기본 켜짐) 구간을 숨긴 뒤 남은 조각만 확대한다(틀 최소 0.06도). 남는 것이 없으면 409 `too_short`. 도로 카드는 완주(95%+) 도로 전체만, '내 지역' 구간은 숨긴다.
- 모든 카드에 `© OpenStreetMap contributors`와 `누비`. 원본 데이터 내보내기 API는 없다(OSM ODbL).
- 응답·로그에 VIN·좌표·토큰을 남기지 않는다. TourAPI 키는 요청 URL에만 쓰고 로그엔 오류 분류 코드만 남긴다.
- B2B: 차량 단위·월 단위, 5대 미만 칸 숨김, '내 지역'이 그 시군구인 차량과 익명 통계 참여를 끈 차량 제외, 응답에 차량 ID·좌표 없음. 통과 = 매칭 결과 `regions.passed`, 방문·숙박 = `region_events`(그 달), 체류 3시간 = 트립 종료~다음 트립 시작(종료 지점이 그 시군구, 7일 넘는 간격 제외) 하루(KST) 합계 3시간 이상인 날이 있는 차량.

## 테이블 (`schema-ext.ts`)
`way_revived`, `coverage_snapshots`, `accounts`, `auth_tokens`, `link_codes`, `guest_sessions`, `guest_ways`, `vehicle_settings`, `share_cards`, `intro_cache`, `courses`. 테이블·열 이름에 `vin` 부분 문자열이 들어가면 기존 'VIN 미저장' 테스트가 실패하므로 피한다(그래서 `drive_map`).

## 한계
- 기록 멈춤은 서버에서 **점 업로드를 저장하지 않는 것**까지만 한다(트립 시작·종료는 받는다). 차량이 설정을 읽어 멈추는 쪽은 T4.
- 게스트 도로 커버리지는 차량 인정 커버리지 값(`MAX`)을 그대로 쓴다(세션 안에서 더 낮게 달렸어도 차량 값). 시군구는 세션 창 트립 기준이라 정확하다.
- 여행 카드는 원시 궤적(`trip_points`, 30일 보관 가안)을 쓴다. 매칭된 way는 트립별로 저장하지 않아서 궤적이 지워진 트립은 카드를 만들 수 없다.
- 코스 완주 월 구분은 '코스 도로 중 가장 늦은 마지막 인정 시각이 그 달'인 근사다(완주 시각을 따로 저장하지 않는다).
- B2B 체류 집계는 트립·점을 훑는 O(트립 수) 계산이다(캐시 없음). 지자체 월 리포트용 배치로 돌리는 규모를 가정한다.
- TourAPI는 키가 없어 실호출을 해 보지 못했다(가짜 fetch 테스트만). 응답 필드(`mapx`·`mapy`·`title`·`addr1`·`dist`)는 KorService2 문서 기준 추정이다.
- PNG는 시스템 글꼴을 쓴다(macOS 기본 한글 글꼴 확인). 한글 글꼴이 없는 Linux 컨테이너에서는 `NUBI_CARD_FONT`를 지정해야 한다.
- 토큰이 URL(`/me?t=`)에 들어간다(계약대로). 페이지는 no-store·no-referrer지만 공개 배포 전 짧은 수명 토큰·쿠키로 바꾸는 것이 좋다. register가 VIN만 알면 차량 토큰을 내준다(plan 12-2의 VIN 대입 표면은 그대로).
- 인증 `required`에서 `/viewer`는 토큰을 못 실어 열리지만 그 안의 API 호출은 401이다(시연용 페이지).
