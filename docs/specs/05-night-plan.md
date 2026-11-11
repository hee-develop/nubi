# 05. 차량 중심 전면 구현 (야간 작업 계약서, 2026-11-11)

사용자 요청(2026-11-11): "앱은 차량이 중심이어야 한다. 차 안에서 달리는 길의 색이 바뀌는 것을 지도에서 확인할 수 있어야 한다. 생각했던 모든 기능 + 추가하고 싶은 것을 다 구현하라. 아침에 뺄 것을 뺀다."

- 기준 브랜치 `night/base`(= `feat/04-car-design` + 이 문서). 제출 브랜치·제출 APK(`apk/`)는 건드리지 않는다. **푸시 금지**.
- 아침에 빼기 쉽게: 기능마다 커밋을 나누고, 차량 기능은 `FeatureFlags`(아래)로 켜고 끈다.
- 기획서(`~/Projects-my/nubi-docs/docs/plan.md`)의 4·8·9·10·11·12-3장이 원 기획이다. 이 문서와 어긋나면 이 문서가 우선이다(차량 중심으로 바뀜).

## 1. 트랙과 소유 파일

| 트랙 | 브랜치 / worktree | 범위 | 소유(새로 만들 파일) |
|---|---|---|---|
| T1 차량 지도 | `feat/05-car-map` / `~/Projects-my/nubi-wt/map` | 차량 지도 뷰(주행·정차), 실시간 색칠, 서버 `/map/base`·`/trips/:id/live` | `server/src/routes/map.ts`, `server/src/matching/live.ts`, `server/src/db/schema-map.ts`, `car/.../map/*` |
| T2 서버 확장 | `feat/06-server-ext` / `~/Projects-my/nubi-wt/server` | 바램·되살린 거리, 월간 재계산, 차주 연결, 게스트, 공유 카드, 지역 소개, 설정·삭제, 리포트, B2B·코스 인증, 토큰 인증(선택), QR 랜딩 웹 페이지 | `server/src/routes/{pair,guest,share,intro,account,reports,b2b,pages}.ts`, `server/src/db/schema-ext.ts`, `server/src/shared/fade.ts` |
| T3 폰 앱 | `feat/08-phone` / `~/Projects-my/nubi-wt/phone` | Expo 앱(보조): 연결·홈·지도·도감·도로·게스트·공유·설정 | `phone/**` |
| T4 차량 부가 | `feat/07-car-extras` (T1·T2 합친 뒤) | TTS, 정차 메뉴(지도·도감·도로·오늘·설정), 게스트·연결·공유 QR 실제 연동, 지역 소개 카드, 기록 멈춤, 토큰 헤더 | `car/.../screens/*`, `car/.../voice/*` |

공유 파일(`server/src/app.ts` 라우트 체인, `server/src/db/schema.ts`의 초기화 호출, `car/.../MainActivity.kt`, `AndroidManifest.xml`, `strings.xml`)은 **최소한만** 고친다. 새 테이블은 각자 `schema-*.ts`에 두고 `schema.ts`에서는 한 줄로 이어 붙인다. 라우트는 `app.ts` 체인에 `.route()` 한 줄씩. 서식은 기존 파일 그대로(작은따옴표·긴 줄, prettier 재포맷 금지).

## 2. 화면 원칙 (차량 중심)

| 상태 | 화면 |
|---|---|
| 주행 중(D·R·N) | **지도가 주인공**. 앱 영역 전체 지도, 내 위치 따라가기(북쪽 위, 고정 축척 z≈14), 이번 주행에서 칠해지는 길이 색으로 바뀐다. 상단 한 줄 `기록 중 · 서울 중구`(지금 시군구 이름). **숫자(거리·%·n/229)·버튼·카드·QR·팝업·애니메이션 없음, 터치 무시**. 화면 갱신 1초 1회 이하. `FeatureFlags.drivingMap=false`면 기존 03b 화면 |
| 정차 중(P) | 지도가 화면의 넓은 쪽(가로 약 60%), 오른쪽 패널에 지금 시군구·도감·이웃 카드(기존 03 요소). 지도는 터치로 이동·확대, `+`/`−`/`내 위치`/`전국` 버튼, 레이어 `도로`/`시군구` 토글. 정차 메뉴(T4): 지도 · 도감 · 도로 · 오늘 · 설정(메뉴 깊이 2단계 이내) |
| 주행 규제(DO) | 기존 규칙 유지: DO면 버튼·카드·QR 숨김, fail-closed |

지도 색(브랜드 00): 배경 #0f141b, 안 간 도로 #2a3544(가는 선), 달린 도로 앰버 #f59e0b, 이번 주행 새 도로 #fbbf24(굵게), 바랜 도로/지역은 채도 50%(#c79a4c 계열), 시군구 칠은 앰버 농도 3단계(통과·방문·숙박, 투명도), 안 간 인구감소지역 바탕 #1c323a, 내 위치 흰 화살표/원, 지도 모서리 `© OpenStreetMap contributors`.

바탕 타일은 쓰지 않는다(OSMF 타일 서버 금지, 자체 타일은 이번 범위 밖). 서버가 준 도로·시군구 도형만 그린다. 차량 앱은 커스텀 `View`(Canvas, Web Mercator)로 그리고 새 지도 라이브러리를 넣지 않는다.

## 3. API 계약

모든 응답 JSON, 오류는 `{ error: '<code>' }`. 차량 ID 쿼리는 기존대로 `vehicleId`(alias 정본 처리 `canonicalVehicleId`). 좌표는 `[lon, lat]`, 소수 5자리.

### T1 소유
- `GET /map/base?bbox=minlon,minlat,maxlon,maxlat&z=<정수>&vehicleId=` → `{ z, ways: [{ id, cls, rk, c: [[lon,lat],...], d?: { at: ISO, cov: 0~1 } }], regions?: 생략 }`
  - `cls`: `mw`(motorway·trunk)·`pr`(primary)·`sc`(secondary·tertiary)·`mn`(그 밖 이름 있는 길). z<9는 mw만, z<11은 mw·pr, z<13은 +sc, 그 위 전부. bbox 한 변 상한 z별(가안: z<9 6°, z<11 2°, z<13 0.5°, 그 위 0.15°), 최대 8,000 way. 도형은 z별 Douglas-Peucker 단순화. `d`는 그 차량이 인정받은 way(`at` = 마지막 인정 시각, `cov` = 커버리지). 시군구 폴리곤은 기존 `GET /regions/geo` 사용.
- 실시간 색칠: `POST /trips/:id/points` 뒤 서버가 그 트립의 **진행 중 부분 매칭**을 디바운스(30초)로 돌린다(Valhalla trace, 최근 창 + 이미 매칭한 끝 겹침). 결과는 **잠정**이며 완료율·도감에 넣지 않는다(확정은 기존 트립 종료 매칭).
- `GET /trips/:id/live` → `{ status: 'idle'|'running'|'ready', upToSeq, ways: [{ id, c, isNew }], region?: { code, displayName, level, firstTime } }` — `isNew`는 그 차량이 처음 달리는 way, `region`은 마지막 점의 시군구(`firstTime` = 그 차량 단계 0이었던 곳).
- 차량 업로드 주기: 주행 중 지도를 켠 경우 배치 간격 60초 → **20초**(점 수 기준 100 유지). 앱은 업로드와 별개로 **로컬 원시 궤적**을 즉시 얇은 선으로 그려, 서버 잠정 결과가 오기 전에도 지나온 길이 바로 보이게 한다.

### T2 소유 (경로 가칭은 plan 12-3 따름)
- 바램: `server/src/shared/fade.ts` `isFaded(lastAt, now, days=365)`. `/coverage/segments`·`/regions/geo`·`/regions/list` 항목에 `faded: boolean` 추가. 다시 달려 바램이 풀린 길이는 `revived_m`로 누적, `/coverage/summary`에 `revivedKm`. 시연용 `POST /debug/age { vehicleId, days }`(production에서는 라우트 없음): 그 차량의 마지막 인정·판정 시각을 days만큼 당긴다.
- 월간 재계산: `scripts/recompute-coverage.mjs --roads <새 DB>`(스냅샷 교체 시 차량별 달린 길이·분모 재계산), 테스트.
- 차주 연결: `POST /pair/code { vehicleId, gear }`(P일 때만, 6자리 코드 + 5분) → `{ code, url, expiresAt }`; `POST /pair/claim { code }` → `{ accountId, token, vehicleId }`; `DELETE /pair`(Bearer).
- 게스트: `POST /guest/code { vehicleId, gear }`(P만) → `{ code, url, expiresAt }`; `POST /guest/claim { code, consent: true, nickname? }` → `{ sessionId, token }`(동의 없으면 400); `POST /guest/:id/end`; `GET /guest/sessions?vehicleId=` → `{ active: n }`(차주는 인원만). 세션 중 그 차 트립은 게스트에게도 인정(`GET /me/summary`, `/me/regions`, Bearer). 차량당 동시 4명.
- QR 랜딩 웹 페이지(폰 앱 없이 동작, 모바일 브라우저용 서버 렌더 HTML): `GET /g/:code`(게스트: 동의 체크 → 참여 → 내 기록 링크), `GET /p/:code`(차주 연결), `GET /me?t=<token>`(내 지도 요약: 도감 숫자 + 정적 지도 이미지), `GET /s/:id`(공유 카드).
- 공유 카드: `POST /share/cards { vehicleId, kind: 'national'|'trip'|'road', tripIds?, roadKey? }` → `{ id, url, imageUrl }`; `GET /share/cards/:id.png`(또는 .svg). 비식별(plan 10-1): 전국 축척 고정, 여행 카드는 출발·도착 반경 1km 제거, 날짜는 월 단위, 좌표 원본·way id 미포함, `© OpenStreetMap contributors` + 누비 표기.
- 지역 소개: `GET /regions/:code/intro` → `{ sample: boolean, source: '한국관광공사', items: [{ kind: 'attraction'|'festival'|'food', title, lat, lon, addr? }] }`. 키 `NUBI_TOURAPI_KEY`가 없으면 시군구별 고정 예시(`sample: true`, 제목에 실명 대신 '예시' 표기 가능). 키가 있으면 TourAPI 4.0 호출·하루 캐시.
- 설정·삭제: `GET/PUT /vehicles/:id/settings { recordingPaused, homeRegion, statsOptIn, drivingMap }`; `DELETE /vehicles/:id/data`(트립·점·커버리지·지역 기록 전부 삭제, 위치정보 동의 철회).
- 리포트: `GET /reports/daily?vehicleId=&date=YYYY-MM-DD`(KST) → 새 km, 처음 지난 시군구, 트립 수·거리; `GET /reports/monthly?vehicleId=&month=YYYY-MM`.
- 거의 다 달린 도로: `GET /coverage/roads?...&filter=almost`(완주율 ≥ 80% 그리고 < 95%).
- B2B(`Authorization: Bearer <NUBI_B2B_KEY>` 필수): `GET /b2b/regions/:code/monthly?month=` → 통과·방문·숙박 차량 수, 하루 정차 3시간 이상 차량 수, k=5 미만 칸 숨김, '내 지역'인 차량 제외; 코스 인증: `courses` 테이블(코스 = roadKey 목록 + 이름 + 시군구), `GET /b2b/courses/:id/completions?month=`, `GET /courses/:id/certificate?vehicleId=`(완주 시 인증서 HTML, 05-gov-certificate 시안 참고).
- 토큰 인증(선택): `NUBI_AUTH=off|optional|required`(기본 `off`). `/vehicles/register` 응답에 `vehicleToken` 추가. `required`면 차량 쓰기 API·조회 API에 `Authorization: Bearer` 필요. 기본 off라 기존 E2E 영향 없음.

## 4. 차량 FeatureFlags (T1이 만들고 T4가 채운다)
`car/.../FeatureFlags.kt`: `drivingMap`(기본 true), `liveColoring`(true), `voice`(true, T4), `parkedMenu`(true, T4), `guest`(true), `share`(true), `intro`(true). 서버 설정 `drivingMap`이 오면 덮어쓴다(T4). 아침에 빼려면 기본값만 바꾸면 되게.

## 5. 검증과 공용 자원 규칙
- 각 트랙 완료 기준: typecheck·서버 테스트·차량 단위 테스트·`assembleRelease` 통과, 해당 트랙 E2E(있으면) **재시도 없이 2회 연속**. 새 기능은 E2E 단언을 추가하고 기존 단언은 약하게 하지 않는다.
- **에뮬레이터·Maestro 잠금**: Maestro나 adb로 화면을 조작하기 전 `mkdir ~/.nubi/device.lock` 성공 시에만 진행, 끝나면 `rmdir`. 실패하면 60초 간격으로 기다린다(2시간 넘은 잠금은 작성자 확인 뒤 제거). `pgrep -fl maestro`로 차곡 세션도 확인.
- 차량: adb `-s emulator-5554`, Gradle `ANDROID_SERIAL=emulator-5554`. 실물 폰 R3CTA09K5FB에 절대 설치 금지. 폰 앱: `Pixel_10_Pro_XL`을 `-port 5556`(`emulator-5556`)으로만.
- 서버 포트: 8787은 사용자 수동 시연 서버(건드리지 않음). T1 E2E 8790, T2 8791, T3 8792, T4 8793. 8788은 손대지 않는다.
- 데이터: 각 worktree의 `server/data/`는 메인 트리 파일로 심볼릭 링크(도로 DB·시군구 DB). Valhalla 컨테이너는 이미 8002에서 동작.
- 커밋: 기존 스타일 한국어, 끝에 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. 작성자 설정은 저장소 로컬 그대로. `git stash`·reset --hard·rebase 등 파괴적 조작 금지.
