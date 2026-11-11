# 사양 05d: 차량 부가 기능(T4)

계약서 `05-night-plan.md` 1장 T4·4장의 구현 사양이다. 소스는 `car/app/src/main/java/com/nubi/car/{screens,voice}/`와 `MainActivity`·`trip/TripEngineProvider`·`FeatureFlags`. 어긋나면 계약서가 우선이고 다르게 한 점은 아래 '계약서와 다른 점'에 모았다.
**주행 중 규칙은 그대로다**: D·R·N에서는 숫자·버튼·카드·QR·메뉴·팝업이 없고 터치는 무시, 음성은 I01만(숫자 없음), DO는 fail-closed, 문자열은 `limitText`.

## FeatureFlags (`FeatureFlags.kt`, 기본값만 바꾸면 기능이 빠진다)

| 플래그 | 기본 | 끄면 |
|---|---|---|
| `voice` | true | 음성 안내 없음. 설정 탭 `음성 안내` 토글(기기 저장)이 같은 값을 끈다 |
| `parkedMenu` | true | 탭(도감·도로·오늘·설정)과 하차 요약 카드 없음. 지도 탭(기존 정차 화면)만 |
| `guest` | true | 정차 패널의 게스트 카드와 설정 탭의 `같이 탄 사람` 없음 |
| `share` | true | 오늘 탭의 `전국 카드 공유 QR` 없음 |
| `intro` | true | 지역 소개 호출·카드 없음(이웃 카드와 이웃 길안내만) |
| `drivingMap` | true | 서버 설정 `drivingMap`이 false면 꺼진다(아래). 빌드 기본값이 false면 서버가 켜도 켜지지 않는다(`applyServerDrivingMap`) |

## 정차 메뉴 (`screens/ParkedMenu.kt`)

- 정차(P) 화면 헤더에 탭 `지도 · 도감 · 도로 · 오늘 · 설정`(메뉴 깊이: 탭 → 목록·확인 단계, 2단계). 지도 탭은 기존 정차 지도+패널 화면이다. 지도가 아닌 탭은 열 때마다 서버에서 다시 받고(`불러오는 중` → 값 또는 `불러오지 못했어요`) 본문 자리에 그 탭의 내용을 보인다.
- **기어가 D·R·N이 되거나 DO가 걸리면 즉시** 탭·내용이 사라지고 지도 탭으로 돌아가며(주행 화면이 된다) 열려 있던 QR도 닫힌다. 엔진의 기어 콜백(`onGearChange`)이 1초 틱을 기다리지 않고 화면을 다시 그린다. 노출 판단은 순수 함수 `menuAllowed`·`qrAllowed`(`ExtrasRules.kt`).
- **도감**: `/regions/list` 229칸을 시도별로 묶는다. 위에 `시군구 n/229 · 인구감소지역 m/92`, 칸 색은 단계(안 감·통과·방문·숙박)별 앰버 농도, 바랜 곳(`faded`)은 탁한 색, 인구감소지역(92)은 청록 테두리.
- **도로**: `/coverage/roads?filter=almost`(`거의 다 달린 도로`)를 위에, 그 아래 `달린 도로`(완주율 순). 각 줄은 이름·완주율·달린/전체 km. **도로를 눌러 지도에서 그 도로로 이동하는 것은 하지 않았다**(아래 한계).
- **오늘**: `/reports/daily`(새 도로 km, 처음 지난 시군구, 트립 수·거리, 되살린 거리)와 `/reports/monthly`(이번 달 요약). 날짜는 엔진 시계(debug `now=`를 따름)의 KST 날짜다. 아래에 `전국 카드 공유 QR`.
- **설정**: `기록 멈춤`·`주행 중 지도`·`음성 안내` 토글(상태를 글자에 넣어 `기록 멈춤: 꺼짐`), `내 지역`(시도별 시군구 이름 목록에서 고르기, `지정 안 함`), `같이 탄 사람 추가`, `차주 연결 QR`, `데이터 지우기`.
- **데이터 지우기**(`DeleteStep`): `데이터 지우기` → 1단계 `위치정보 이용 동의를 철회하고 …` [계속/취소] → 2단계 `정말 지울까요? …` [지우기/취소] → `DELETE /vehicles/:id/data`. 1·2단계 어디서든 취소하면 서버를 부르지 않는다(JVM 테스트). 끝나면 설정을 다시 읽어 `consentWithdrawnAt`을 반영한다(기록 멈춤 상태가 된다).

## QR (게스트·차주 연결·공유)

- QR 인코딩은 `com.google.zxing:core:3.3.3`(순수 Java)이고 모듈 행렬(`qrMatrix`)을 비트맵으로 그린다(`QrBitmap.kt`). 서버가 주는 `url`을 그대로 넣는다(주소의 호스트는 서버의 `NUBI_PUBLIC_URL`·요청 origin 규칙을 따른다).
- 게스트: 정차 패널의 게스트 카드(`게스트 QR`)에서 `같이 탄 사람 추가` → `POST /guest/code { vehicleId, gear:'P' }` → QR + `코드 123456 · 남은 시간 4:59`(1초 갱신, 기기 단조 시계로 센 5분). `같이 탄 사람 n명`(`/guest/sessions`, 처음 보일 때와 15초마다)과 `모두 내리기`(`/guest/end-all`). 패널이 좁아 게스트 카드가 접히는 상태(시군구를 알 때 등)를 위해 설정 탭에도 같은 기능이 있다(같은 상태를 공유). `준비 중` 고정 QR 자리표시는 없앴다.
- 차주 연결: 설정 탭 `차주 연결 QR` → `POST /pair/code`. 공유: 오늘 탭 → `POST /share/cards { kind:'national' }`의 `url`.
- **기어가 P를 벗어나거나 DO면 QR·코드를 바로 닫는다.** 요청 중에 기어가 바뀌어 응답이 늦게 오면 보이지 않고 버린다. 코드가 5분이 지나면 지운다. 오류: 403 `not_parked`·409 `guest_limit`/`already_paired`·503·그 밖은 짧은 문구.

## 지역 소개 카드 (`screens/IntroTracker.kt`)

- 정차 패널의 이웃 카드 아래 `지금 있는 곳 소개`: 지금 시군구의 `GET /regions/:code/intro?lat=&lon=`에서 관광지(`attraction`)·축제(`festival`) 첫 항목(서버가 가까운 순). 시군구가 바뀔 때만 한 번 받고 실패하면 60초 동안 다시 묻지 않는다(429 대비). 현재 위치가 시군구 밖이라 400이면 좌표 없이 한 번 더 묻는다.
- 응답 `sample: true`면 항목에 `예시 항목`, 출처 `자료: 한국관광공사(예시)`. 실데이터면 주소와 `자료: 한국관광공사`.
- 각 카드의 `길안내`는 **그 항목의 좌표**로 `NaviLauncher.request`(NaviHelper `requestRoute`)를 부른다. 이웃 카드에는 이웃 중심점 길안내 하나(이름 줄 오른쪽)를 남겼다. 결과는 카드 아래 한 줄(팝업·토스트 없음).
- 좁은 영역의 축약형 카드에서는 소개 카드를 접는다(이웃 길안내만).

## 음성 안내 (`voice/`)

- **I01**: 처음 들어선 시군구 한 문장(`강원 홍천군에 처음 왔어요`). 잠정 색칠 응답(`/trips/:id/live`)의 `region.firstTime`이 오면 주행 중(P가 아닌 기어)에 말한다. 한 트립에서 같은 시군구는 한 번. 숫자·질문 없음.
- **I03**: 하차 브리핑 한 문장(`이번 주행에서 새 도로 1.2킬로미터를 달렸어요`). 트립 정산이 끝났을 때 기어가 P이고 새 도로가 0.05km 이상일 때만. 숫자는 P에서만 말한다.
- 규칙(plan 4-4)은 순수 함수 `decide`·`VoiceGate`·`isValidSentence`(`VoiceRules.kt`, JVM 테스트): 플래그 → 상황(I01은 주행 중에만, I03은 P에서만) → 문장(5초 이내 추정, 질문 아님, 주행 중 숫자 없음, 시군구 이름은 한글·공백만) → 빈도(같은 종류 10분에 1회 이하). 주행 중에는 질문하지 않고 상호·광고는 읽지 않는다(문장은 템플릿과 시군구 이름뿐, TourAPI 항목은 읽지 않는다).
- 소리 내기(`VoiceAdapter`): Pleos `TextToSpeech`(ON_DEVICE). 오디오 포커스는 `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`(`USAGE_ASSISTANCE_NAVIGATION_GUIDANCE`·SPEECH, `setWillPauseWhenDucked(false)`)로 받고 끝·오류·상한(8초)·포커스 상실 때 반납한다. 포커스를 못 받으면 말하지 않는다. 선행 묵음: 포커스를 받은 뒤 **200ms 뒤** 재생을 시작한다(가이드 150~200ms). TTS 초기화 실패·미지원·예외는 모두 삼키고 아무 일도 하지 않으며(크래시 없음), 초기화 실패 뒤 5분은 다시 시도하지 않는다. 로그(태그 `NubiVoice`)에는 종류와 글자 수만 남기고 문장은 남기지 않는다. 권한 `pleos.car.permission.TTS_SERVICE` 추가(normal 등급).
- 에뮬레이터 로그 예(E2E, 소리 자체는 확인하지 못함):
  `TTS 준비됨` → `TTS 요청 I01 글자=14` → `오디오 포커스 GRANTED(MAY_DUCK)` → `TTS 시작`(요청 후 약 0.2초) → `오디오 포커스 반납(TTS 완료)`. 같은 종류가 10분 안에 또 오면 `I01 건너뜀: 빈도 제한`.

## 기록 멈춤·서버 설정 (`ExtrasController`, `TripEngine.recordingPaused`)

- `GET /vehicles/:id/settings`를 앱이 화면에 들어올 때·정차 진입 때·설정 탭을 열 때 읽는다. `recordingPaused` 또는 `consentWithdrawnAt`이면 엔진이 새 위치 샘플을 상태기계에 넣지 않고 버린다(새 트립도 시작하지 않는다, 기어는 계속 읽는다). 마지막 값은 `SharedPreferences`에 저장해 재시작 직후 서버 응답 전에도 지킨다.
- 상태 문구: 대기·종료 상태에서 `기록 멈춤`(헤더 상태·주행 지도 위 한 줄에 모두). 기록 중인 트립이 있으면 `기록 중`이 우선이다.
- 서버 `POST /trips/:id/points`의 `{accepted:0, paused:true}`는 200이라 업로더가 정상 완료로 처리한다(재시도 없음, 기존 동작).
- `drivingMap` 서버 설정은 `FeatureFlags.drivingMap`을 끈다(켜는 쪽은 빌드 기본값 AND). `voice`는 서버 설정에 필드가 없어 **기기에만** 저장한다(설정 탭). 업로드 간격 규칙(지도 화면이 보일 때만 20초, 그 밖 60초)은 `uploadIntervalFor`가 `drivingMap`을 읽어 그대로 반영한다.
- `PUT /vehicles/:id/settings`는 부분 갱신(`recordingPaused`·`drivingMap`·`homeRegion`)이다.

## 토큰 헤더 (`trip/Auth.kt`, `VehicleIdResolver`)

- `POST /vehicles/register` 응답의 `vehicleToken`(서버 `NUBI_AUTH`≠off일 때만)을 차량 ID와 같은 DEK 암호화로 저장한다(`vehicle-token.enc`, 평문 저장 없음). 모든 API(`getText`·`postJson`·`putJson`·`deleteRequest`, 업로드·`Coverage`·`Place`·`HttpMapApi`·새 API)가 `Authorization: Bearer`를 붙인다. 등록 요청에는 붙이지 않는다.
- 401·403을 받으면 재등록(`registerWithToken`)을 **1회** 시도한다(응답 성공 전까지 반복하지 않음). 실패하거나 재등록 뒤에도 거절되면 `Auth.failed`가 켜져 상태 문구 `서버 인증에 실패했어요`가 보인다. 요청이 성공하면 풀린다. **업로드 큐는 버리지 않는다**(401·403은 기존대로 그 트립을 보류하고 백오프 뒤 다시 올린다).
- VIN은 재등록용으로 메모리에만 둔다(저장·로그 없음). 저장된 차량 ID만 있고 토큰이 없는 앱이 VIN을 읽으면 토큰을 받아 보려고 한 번 등록한다(인증이 꺼진 서버는 토큰을 안 주므로 프로세스당 한 번).

## 하차 요약 카드 (`screens/TripSummary.kt`, `SummaryCard.kt`)

- 트립이 끝나(엔진 `onTripEnded`) 로컬 궤적의 범위와 복사본을 떠 두고(정산 때 원본 궤적이 지워진다), 정산이 끝나 새 도로 0.05km 이상 또는 처음 지난 시군구가 있으면 정차(P, DO 아님) 화면 왼쪽 아래에 `이번 주행` 카드: `새 도로 N.Nkm`, `처음 지난 곳: …`, 그 트립 범위에 맞춘 **정적 지도 썸네일**(만지지 못하는 `NubiMapView`, 별도 `MapRepository`라 주 지도의 보기를 바꾸지 않는다. 정산 뒤 다시 받아 달린 길이 보인다. `© OpenStreetMap contributors` 포함). 30초 뒤 또는 탭하면 닫힌다. 새 트립이 시작되면 지운다. 이번 실행에서 끝난 트립이 아닌 정산(오프라인 백로그)은 카드를 만들지 않는다.

## E2E

`scripts/e2e-car.sh`는 flow 4개를 돈다(앞 3개 유지, 새 `e2e/maestro/car/parked-menu.yaml`). 정차 메뉴 flow: 탭 5개·도감 229/92·도로·오늘(리포트·공유 QR)·설정 토글(`기록 멈춤` 상태 문구 포함)·내 지역·차주 연결 QR·게스트 QR 표시와 **기어 D에서 사라짐**·데이터 지우기 2단계 확인과 끝까지 진행. 끝나면 스크립트가 서버에서 트립 0개·동의 철회를 확인하고, logcat에서 TTS 요청(I01·I03)·오디오 포커스 GRANTED·반납을 확인한다. 기존 flow에서 바뀐 단언: `준비 중`(없어야 함)·`같이 탄 사람 추가`(있어야 함), 지도 레이어 토글 `도로`는 정차 메뉴 탭과 이름이 같아 `id`로 누름, 지역 소개는 이웃보다 늦게 오므로 `예시 항목`을 기다림(`지금 있는 곳 소개` 추가). 주행 중 단언(숫자·카드·QR·메뉴 없음)은 모두 유지하고 탭 이름(`도감`·`오늘`·`설정`)을 더했다.

## 리뷰 반영(2차)

**데이터 삭제 뒤 로컬 정리**: 서버 삭제가 성공하면 `ExtrasController`가 `onDataDeleted`를 부르고 순서는 (1) 로컬 `recordingPaused=true` 켜고 저장, (2) 업로드 큐·dead-letter·서버 등록 비우기(`Uploader.clearAll`), (3) 진행 중 트립·상태기계 버리기(`TripEngine.purgeAfterDataDeletion`, release에서도 동작, debug `reset`과 같은 `discardState`를 쓴다), (4) 요약 카드·궤적·잠정 결과·coverage(전국 완료율·도감 저장값 포함)·place·intro·도감 캐시·지도 캐시 비우기. 설정 조회가 실패해도 로컬 멈춤은 유지된다. 서버도 두 겹으로 막는다: `POST /trips`·`/trips/:id/end`가 기록 멈춤·동의 철회 차량이면 행을 만들지 않고 200 `{ paused: true }`(`routes/account.ts`, 점 업로드와 같은 방식, 서버 테스트). 차량 업로더는 이 응답(`PausedByServer`)을 받으면 그 트립의 큐 항목·등록을 재시도 없이 버린다. 삭제 실행기가 작업을 거절하거나 서버 호출이 실패하면 `DeleteStep.FAILED`로 두고 다시 시도할 수 있다.

**인증 오류 분류**: 재등록은 401 또는 응답 `{error:'unauthorized'}`일 때만 한다(진행 중 플래그를 원자적으로 잡아 한 번만, `Auth.beginReregister`). `forbidden`·`local_only`·`not_parked`는 인증 실패가 아니라 오류 문구(`CodeError.FORBIDDEN`·`LOCAL_ONLY`·`NOT_PARKED`)로 따로 보인다. 토큰이 없는 모드에서도 2xx면 `Auth.failed`를 푼다. 업로더의 Alias 단계는 401·403이면 격리(dead-letter)하지 않고 보류한다. 차량 ID가 없을 때(`NO_VEHICLE`)·429(`RATE_LIMITED`)도 문구가 따로 있다.

**기록 멈춤(오프라인)**: 멈춤 **켜기**는 로컬(엔진)에 즉시 적용·저장한 뒤 서버에 보내고, 못 보내면 `pausePending`으로 남겨 정차 진입·화면 복귀·30초 주기(`syncPendingPause`)에 다시 보낸다(대기 중에는 서버 값으로 덮지 않는다). **끄기**는 서버가 확인한 뒤에만 로컬에 적용한다. 멈춤 중에는 `place.refresh()`(`/regions/at`)와 지역 소개 호출을 하지 않는다(위치 좌표를 서버로 보내지 않는다). 지도 칸 요청은 화면에 보이는 영역의 bbox라 막지 않았다(기록이 아니라 열람이다).

**음성**: 말하기 직전(포커스 요청 전과 선행 묵음 지연 뒤 실제 `speak` 직전)에 호출자의 `stillAllowed`(기어·플래그, I01은 주행 중·I03은 P)를 다시 확인하고, 기어가 바뀌면(`engine.addGearListener` → `VoiceAdapter.recheck`) 말하는 중이어도 즉시 멈추고 포커스를 반납한다. `onDone`·`onError` 콜백은 발화 상태(`SpeechTurns`)가 소리가 **시작된** 지금 발화의 것일 때만 받아들인다(취소한 발화의 늦은 콜백이 새 발화를 끝내지 못한다). 10분 빈도 제한은 **실제로 말하기 시작할 때만** 기록한다(초기화 실패·포커스 거절은 횟수를 쓰지 않고 다음 응답에서 다시 시도한다). 규칙으로 건너뛴 시군구는 지나간 일로 보고 10분 뒤에도 말하지 않는다. 서비스 `onDestroy`·`onTaskRemoved`에서 `VoiceAdapter.release()`(재생 중단 → 포커스 반납 → TTS 해제)를 부르고 `open()` 전까지 새 재생·포커스 요청을 막는다(서비스 시작 때 `open`).
- 오디오 usage 근거: 가이드 오디오 컨텍스트 표(`audio-focus-development-guide`)에서 `USAGE_ASSISTANT`는 VOICE_COMMAND, `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE`는 NAVIGATION이다. 누비의 문장은 음성 비서 응답이 아니라 주행 위치 기반 짧은 안내라 NAVIGATION 컨텍스트가 맞다고 보고 바꿨다. `ANNOUNCEMENT` 컨텍스트는 공개 SDK(compileSdk 36 `AudioAttributes`)에 usage 상수가 없어 쓸 수 없었다. 순정 내비 안내와 겹치면 시스템 포커스 정책(NAVIGATION 간 충돌)이 정하며 실차 확인이 필요하다.
- 선행 묵음은 SDK 한계(TTS가 오디오 데이터를 주지 않음) 때문에 가이드가 권장하지 않는 재생 지연 방식(200ms)으로 대체했다. 음성 문구는 위치·주행 결과를 알리는 상태 알림뿐이고 보상·유도·질문·광고는 없다.

**주행 규제**: `CarUxRestrictions.activeRestrictions`의 `UX_RESTRICTIONS_NO_SETUP` 비트를 따로 보관(`setupBlocked`, 모르면 true)하고 DO와 함께 메뉴·QR·설정·삭제·하차 카드·게스트 카드 판정에 넣는다(`UxState.blocked`). QR은 **실제 기어가 P일 때만**(기어를 모르면 거부) 받고 서버에도 실제 기어를 보낸다. QR 요청마다 세대 번호를 두고 기어가 바뀌면 올려서 늦게 온 응답을 버린다. 탭·버튼·내 지역 칸의 클릭마다 `allowedNow`로 한 번 더 확인한다.

**조작성**: 정차 메뉴 탭과 버튼은 최소 높이 80dp·글자 32sp(내 지역 칸은 28sp), Back은 하위 상태(내 지역 목록·데이터 지우기 확인·QR·다른 탭)에서 한 단계만 되돌리고 최상위(지도 탭)에서만 `moveTaskToBack`. 정차 패널의 오른쪽 열은 이웃 카드(이름·인구감소 태그·길안내 1개, 한 줄)와 `지금 여기: {시군구}` 소개 카드(관광지·축제·길안내)로 나눴다(공간이 모자라면 소개 카드가 우선). 게스트 카드는 문구를 두 줄로 나누고 코드와 남은 시간을 따로 줄에 둔다.

**기타**: `zxing:core`를 3.5.4(Maven Central 최신 안정, 3.3.3에서 올림)로 올렸다. `SummaryCard`는 `onDestroy`에서 썸네일 저장소 리스너를 끊는다.

## 계약서와 다른 점

1. `voice` 서버 설정은 서버에 없어 기기 로컬 저장이다. `drivingMap`·`voice` 모두 "끌 수만 있다"(빌드 기본값 AND): 계약은 "덮어쓴다"이지만 아침에 기본값을 false로 빼면 서버가 되살리지 못하게 했다.
2. I03(하차 브리핑)은 I01과 빈도 제한을 **따로** 센다(종류별 10분에 1회). 한 몫으로 세면 트립 끝 브리핑이 직전 시군구 안내에 막힌다.
3. 선행 묵음은 오디오 데이터가 아니라 **재생 지연 200ms**다(TTS SDK가 오디오를 주지 않는다, 위 '음성' 참고). 가이드가 권장하지 않는 방식이라 실차에서 첫 음절 손실을 확인해야 한다.
4. 게스트 QR 기능을 설정 탭에도 뒀다(패널이 좁아 게스트 카드가 접히는 상태가 있어서).
5. 도로를 눌러 지도로 이동하는 기능은 구현하지 않았다.

## 한계

- 도로 → 지도 이동: `/coverage/roads`가 좌표(bbox)를 주지 않고 `/coverage/segments`·`/map/base`는 bbox를 먼저 요구해 도로 하나의 위치를 알 방법이 없다. 서버에 `roadKey → bbox`가 생기면 `MapScreen.centerOn`으로 이을 수 있다.
- 음성은 소리를 확인하지 못했다(로그만). I01은 잠정 색칠 폴링(화면이 떠 있을 때만 돈다)에 의존해, 화면이 백그라운드면 나오지 않는다. TTS SDK 신청은 콘솔에서 아직 '준비 중'(차곡 docs/sdk-check.md), 실차 오디오 포커스 정책은 미확인.
- 기록 멈춤 중에는 위치 샘플을 모두 버리고 `/regions/at`도 부르지 않아서 정차 화면의 `지금 시군구`·지도 내 위치가 갱신되지 않는다.
- QR의 주소는 서버가 만든 `url`이라 `NUBI_PUBLIC_URL`을 배포 주소로 두지 않으면(에뮬레이터는 `http://10.0.2.2:<포트>/…`) 폰에서 열리지 않는다. 폰이 `/g/:code`로 실제 게스트 참여하는 흐름은 에뮬레이터로 확인하지 않았다.
- 토큰 인증(`NUBI_AUTH`≠off)은 JVM 테스트(헤더 부착·401/403 재등록 1회·저장)로만 확인했다. E2E 서버는 인증이 꺼져 있다(기본값).
- 지역 소개는 TourAPI 키가 없어 `sample: true`만 에뮬레이터로 확인했다.
- 하차 요약 카드는 정차 화면 왼쪽 아래에 겹쳐 뜬다. 좁은 앱 영역에서는 패널과 겹칠 수 있다.
