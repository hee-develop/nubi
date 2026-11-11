# 05c. 폰 앱 (T3, 2026-11-11 야간)

계약서 `docs/specs/05-night-plan.md`의 T3 트랙. 폰은 차량 중심 앱의 보조다: 차에서 할 수 없는 입력(연결·동의·설정)과 열람·공유를 맡는다. 코드는 `phone/`에만 있다.

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

## 3. 목으로 둔 API (서버에 아직 없음)

`/reports/daily`, `/reports/monthly`, `/pair/claim`, `DELETE /pair`, `/guest/claim`, `/guest/:id/end`, `/guest/sessions`, `/me/summary`, `/share/cards`, `GET/PUT /vehicles/:id/settings`, `DELETE /vehicles/:id/data`. 또 `/regions/list`의 `faded`(없으면 바램 아님으로 처리), `/coverage/roads?filter=almost`(서버가 모르는 쿼리라 무시되므로 hybrid에서는 상단 카드에 전체 상위가 나온다 — T2 병합 시 해소).

## 4. 가정과 한계

- `GET /me/summary` 응답 형태가 계약서에 없어 `{ regionsColored, regionsTotal, newKm, tripCount }`로 가정(`MeSummary`). 다르면 타입과 `GuestSessionScreen`만 고친다.
- 리포트 응답도 `{ date|month, newKm, newRegions[{code,displayName}], tripCount, distanceKm }`로 가정.
- 공유 이미지: 목 카드는 앱 아이콘 이미지를 미리보기·공유에 쓴다. 실서버 카드는 `imageUrl`(png 또는 svg)을 캐시에 받아 공유한다. svg는 Android `Image`가 못 그릴 수 있어 서버가 png를 주는 쪽이 맞다.
- 지도는 서버 `/viewer` 웹 페이지(WebView)라 차량 지도(T1)와 별개다. 신규 지도 라이브러리는 넣지 않았다.
- 내 지역은 시군구 코드를 그대로 표시(이름 조회 없음).
- ja 문자열은 핵심 화면 위주 부분 번역, 나머지는 ko로 대체. en 없음. 푸시 알림·구독(2단계)·트립 상세·'내 주행 아님'은 이번 범위 밖.
- Expo Go로 실행 확인(dev client 미빌드). 네이티브 설정(카메라 권한 문구, cleartext)은 prebuild·dev client에서만 완전히 반영된다.

## 5. 검증

`pnpm typecheck`, `pnpm phone:test`(Jest: API 목·live 경로·QR 파싱·화면별 상태·i18n), `pnpm --filter @nubi/phone lint --max-warnings 0`. 에뮬레이터 `emulator-5556` + Expo Go 실행 스크린샷은 작업 보고 참조.
