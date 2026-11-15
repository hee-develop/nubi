# 05c. 폰 앱 (T3, 2026-11-11 야간)

계약서 `docs/specs/05-night-plan.md`의 T3 트랙. 응답 형태·오류 코드는 T2 실제 구현(`docs/specs/05b-server-ext.md`, `server/src/routes/*`)에 맞췄다(계약서보다 우선). 폰은 차량 중심 앱의 보조다: 차에서 할 수 없는 입력(연결·동의·설정)과 열람·공유를 맡는다. 코드는 `phone/`에만 있다.

## 1. 화면과 상태

공통: 다크 브랜치(00 시안) 색, 터치 타깃 48dp 이상, 레벨·바램은 색과 글자를 함께 쓴다. 문자열은 `phone/src/lib/strings.ko.ts`(기준)·`strings.ja.ts`(부분, 없는 키는 ko로 대체). 상태 5종: loading / empty / error / offline / 권한 거부.

| 화면(경로) | 데이터 | loading | empty | error | offline | 권한 거부 |
|---|---|---|---|---|---|---|
| 연결 `/connect` | `POST /pair/claim` | 버튼 비활성 | - | 만료·없는 코드·형식 오류 문구 | 서버에 연결하지 못함 문구 | - |
| 스캔 `/scan?mode=pair\|guest` | 카메라, claim | 권한 확인 중 | - | 모르는 QR·종류 불일치 안내 | 연결 화면과 같음 | 설정 열기/카메라 허용 + 6자리 코드 직접 입력 |
| 홈 `/(tabs)` | `/coverage/summary`, `/regions/summary`, `/reports/daily`·`monthly`, `/trips` | 구역별 | 트립 없음 안내 | 구역별 다시 시도 | 구역별 다시 시도 | - |
| 지도 `/(tabs)/map` | WebView `/viewer?vehicleId=` | 오버레이 | 연결 없음·목 모드 안내 | 로드 실패 시 다시 시도 | 같음 | - |
| 도감 `/(tabs)/dex` | `/regions/list` | O | 칸 없음 | O | O | - |
| 도로 `/(tabs)/roads` | `/coverage/roads` (almost·percent) | 구역별 | 구역별 | 구역별 | 구역별 | - |
| 게스트 동의 `/guest/consent?code=` | `POST /guest/claim` | 버튼 비활성 | - | 동의 필요·만료·없는 코드 | 연결 실패 문구 | - |
| 게스트 세션 `/guest` | `/me/summary`, `POST /guest/:id/end` | O | 세션 없음 | O | O | - |
| 공유 `/share` | `POST /share/cards`, 트립·도로 선택 목록 | O | 트립·도로 없음 | 만들기 실패 | 서버 연결 실패 | 공유 시트 사용 불가 안내 |
| 설정 `/settings` | `GET/PUT /vehicles/:id/settings`, `DELETE /vehicles/:id/data`, `DELETE /pair`, `/guest/sessions` | O | - | O | O | - |
| 더보기 `/(tabs)/more` | 없음 | - | - | - | - | - |

- 시작: 연결된 차 → 탭, 게스트 세션만 → 게스트 화면, 없으면 연결 화면.
- 도감: 시도별 묶음(229칸), 탭으로 인구감소지역 92칸. 바램 칸은 점선 테두리와 `바램` 글자.
- 도로: '거의 다 달린 도로'(`filter=almost`, 80% 이상 95% 미만) 카드가 상단.
- 설정: 데이터 지우기는 2단계(안내 → `삭제` 입력 후 활성). 연결 해제는 서버 실패 시 '이 폰에서만 해제'를 제공.
- 공유: 카드 종류(전국·여행·도로) → 만들기 → 미리보기 → OS 공유 시트(`expo-sharing`). 비식별 안내 문구 상시 표기.
- 토큰(`expo-secure-store`): 차주 연결 `nubi.pairing`, 게스트 세션 `nubi.guest`. SecureStore 실패 시 메모리 대체.

## 2. API 모드 (한 곳 설정)

`phone/src/api/config.ts`. 환경 변수 `EXPO_PUBLIC_NUBI_API_URL`, `EXPO_PUBLIC_NUBI_API_MODE`.

| 모드 | 동작 |
|---|---|
| `mock` | 전부 앱 안의 목(서버 불필요). URL이 없으면 기본 |
| `hybrid` | 서버에 있는 API(`/coverage/*`, `/regions/*`, `/trips`, `/viewer`)는 실서버, 아직 없는 새 API는 목. URL만 주면 기본 |
| `live` | 전부 실서버(T2를 합친 뒤) |

- 기존 API 응답 타입은 Hono RPC `AppType`에서 추론(`phone/src/api/types.ts`). 새 API는 같은 파일에 손으로 쓴 '계약 타입'. T2 병합 뒤에는 이 부분만 RPC 추론으로 바꾼다.
- 에뮬레이터에서 호스트 서버는 `http://10.0.2.2:<포트>`(T3는 8792). Android `usesCleartextTraffic`는 `expo-build-properties`로 켠다(개발용. 제출 빌드에서는 끌 것).
- 목 코드: `000000` = 만료, `111111` = 없는 코드, 그 밖의 6자리 = 성공.

## 3. 목으로 둔 API (hybrid에서 목, T2 합친 뒤 live)

`/reports/daily`·`monthly`, `/pair/claim`, `DELETE /pair`, `/guest/claim`, `/guest/:id/end`, `DELETE /guest/:id/data`, `/guest/sessions`, `/me/summary`, `/share/cards`, `GET/PUT /vehicles/:id/settings`, `DELETE /vehicles/:id/data`. 또 `/regions/list`의 `faded`(없으면 바램 아님), `/coverage/roads?filter=almost`(서버가 모르면 무시).

## 4. T2와 맞춘 요청·응답·오류 코드

| 호출 | 폰이 보내는 것 | 폰이 읽는 것 / 오류 코드 → 문구 |
|---|---|---|
| `POST /pair/claim` | `{ code, consent: true }`(연결 화면에서 위치정보 동의 체크 후) | `{ accountId, token, vehicleId }` / 400 `consent_required`·`invalid_body`, 404 `code_not_found`, 410 `code_expired`·`code_used`, 409 `already_paired`, 429 `too_many_requests` |
| `DELETE /pair` | Bearer 차주 토큰 | `{ ok, vehicleId }` |
| `POST /guest/claim` | `{ code, consent: true, nickname? }`(Bearer 없음) | `{ sessionId, token }` / 위 코드 + 409 `guest_limit`·`already_in_session`·`own_vehicle` |
| `POST /guest/:id/end` | Bearer 게스트 토큰 | `{ ok, endedAt, alreadyEnded }`(재호출도 200) / 404·401이면 서버에 세션이 없으니 로컬 세션을 지운다 |
| `DELETE /guest/:id/data` | Bearer 게스트 토큰 | `{ ok }` |
| `GET /me/summary` | Bearer 게스트 토큰 | `{ role, vehicleId? \| activeSessionId?, regions: {total,colored,byLevel,depop:{total,colored}} \| null, coverage: {nationalPercent,drivenKm,totalKm,roadsStarted,roadsCompleted} \| null, snapshotMonth }` (null·누락은 0으로 표시) |
| `GET /reports/daily\|monthly` | `vehicleId`, `date`/`month`(KST) | `{ tripCount, distanceKm, newKm, newWays, revivedKm, newRegions[], newStays[], (monthly) daysDriven }` |
| `GET/PUT /vehicles/:id/settings` | PUT은 **부분 갱신**(바꾼 필드만) | `{ recordingPaused, homeRegion, statsOptIn, drivingMap, hideHomeInCards, consentWithdrawnAt }` / 400 `invalid_region` |
| `DELETE /vehicles/:id/data` | - | `{ ok, deleted: {trips,points,ways,regions} }` (기록 멈춤·동의 철회 표시가 남는다) |
| `POST /share/cards` | `{ vehicleId, kind, tripIds? \| roadKey? }` | `{ id, url, imageUrl }` / 409 `too_short`·`not_completed`, 429 |

- 토큰: 차주 토큰을 SecureStore(`nubi.pairing`)에 두고 **모든 차량 API(Hono RPC 포함)에 `Authorization: Bearer`를 붙인다**(`NUBI_AUTH=optional|required`). claim 두 호출은 토큰 없이 보낸다. 게스트 호출은 게스트 토큰을 명시한다.
- 요청 타임아웃 12초 → `ApiError('offline', 0, 'timeout')`(화면에서는 offline 상태, 연결·게스트 claim은 '응답이 늦습니다').
- 게스트 세션: 내리기에 성공하면 로컬 세션을 `ended`로 두고 토큰을 남겨 기록 열람·`내 기록 삭제`(2단계 확인 후 `DELETE /guest/:id/data`)를 계속 쓸 수 있다. offline이면 '서버에는 아직 탑승 중일 수 있음' 안내와 '이 폰에서만 끝내기'를 보인다.
- 차주 위치정보 이용 동의: 연결 화면에 동의 문구·체크. 체크 전에는 QR 스캔·코드 연결이 모두 비활성이고, QR 스캔은 `consent=1` 파라미터 없이는 claim하지 않는다.
- 목 코드: `000000` 만료, `111111` 없음, `222222` 사용됨, `333333` 이미 연결(차주), `444444` 시도 제한, `555555` 게스트 가득, `666666` 이미 세션 중, `777777` 내 차. 그 밖의 6자리는 성공.

## 5. 가정과 한계

- **`/viewer`는 production(`NODE_ENV=production`)에서 라우트가 없다**(`NUBI_VIEWER=1`이 아니면). 지도 탭은 시연 서버에서만 열린다. 아침에 사용자가 결정할 사항이라 그대로 둔다.
- `NUBI_AUTH=required`에서 `/viewer`는 토큰을 못 실어 열려도 그 안의 API 호출이 401이다(T2 한계). WebView는 서버 origin 밖 이동을 막는다(`originWhitelist`·`onShouldStartLoadWithRequest`).
- Android http(cleartext): `app.config.ts`가 `NUBI_ALLOW_CLEARTEXT=1` 또는 EAS `development` 프로필일 때만 켠다(preview·production은 항상 끔). live 모드에서 http 주소를 쓰면 더보기 탭에 경고와 콘솔 경고가 나온다. Expo Go에서는 이 설정과 무관하게 동작한다.
- 공유 이미지: 목 카드는 앱 아이콘을 쓴다. 서버가 `.svg`를 주면 Android `Image`가 못 그릴 수 있어 PNG(변환기 설치)가 필요하다. 공유 캐시 파일명은 `[\w-]`만 쓴다.
- 내 지역은 시군구 코드를 그대로 표시(이름 조회 없음). 푸시·구독·트립 상세·'내 주행 아님'·지역 소개 카드(`/regions/:code/intro`)는 범위 밖.
- ja 문자열은 핵심 화면·동의 문구·오류 문구 위주 부분 번역, 나머지는 ko로 대체. en 없음. RN Android에는 `keep-all`이 없어 ko 줄바꿈이 단어 중간에서 끊길 수 있다.
- 에뮬레이터 확인은 첫 작업 때 Expo Go(mock)로 연결·홈·도감·도로·더보기·공유 화면까지만 했다. 5556을 chagok 세션과 공유해 이번 수정은 테스트·타입·린트로만 검증했다.

## 5. 검증

`pnpm typecheck`, `pnpm phone:test`(Jest: API 목·live 경로·토큰 헤더·타임아웃·QR 파싱·화면별 상태·i18n·라우팅 가드), `pnpm --filter @nubi/phone lint --max-warnings 0`. 에뮬레이터 `emulator-5556` + Expo Go 실행 스크린샷은 작업 보고 참조.
