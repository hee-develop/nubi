# SDK 실측 기록 (주행 기록 기능)

- 환경: Pleos 에뮬레이터 `Pleos_Connect_v2_1`(`emulator-5554`, user 빌드, 앱은 사용자 10에서 실행), 2026-11-08 실측
- SDK: FusedLocation 1.1.3, Vehicle 2.3.2
- 판정: ✅ 확인됨(로그 근거) · ⚠️ 에뮬레이터에서 확인 못 함(실차 확인 필요) · ❌ 안 됨 · 🚫 수집하지 않기로 함
- 로그 태그: `NubiLoc`(위치), `NubiTrip`(상태기계·업로드), `NubiVehicle`(VIN·오도미터), `NubiCarSignals`(기어), `NubiService`

## 요약

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | `adb emu geo fix`가 FusedLocation `onChanged`로 중계됨 | ✅ | 5회 모두 그 좌표로 도착 |
| 2 | 다른 앱이 앞에 있어도 서비스가 위치를 계속 받음 | ✅ | 설정 앱을 앞에 두고 geo fix 3회, 모두 수신·샘플 채택 |
| 2' | `ERROR_DRIVING_RESTRICTED` 발생 조건 | ⚠️ | 에뮬레이터(user 빌드)에서 실제 주행 상태를 만들 수 없어 확인 못 함 |
| 3 | 권한 등급 | ✅ | 아래 표 |
| 3' | VIN·오도미터 실제 값 | ✅ | VIN은 9자 문자열(해시해서 사용), 오도미터는 0.0 |
| 4 | 기어(AAOS) 읽기 | ✅ | `GEAR_SELECTION`=4(PARK) |
| 5 | 속도(AAOS) 읽기와 거부 시 동작 | 🚫 수집 안 함 | 2026-11-08 결정으로 `CAR_SPEED` 요청·`PERF_VEHICLE_SPEED` 읽기 코드를 모두 제거함(아래 §4의 실측 기록은 제거 전 값) |
| 6 | Android 14 `location` 타입 포그라운드 서비스 | ⚠️ | Pleos 위치 권한만으로는 시작 불가, `ACCESS_COARSE_LOCATION` 추가 필요(아래) |
| 7 | 실제 주행 중 기어·위치 | ⚠️ | 에뮬레이터는 기어 P 고정. 기어 D는 debug 주입으로만 확인 |
| 8 | Suspend(IGN OFF) 처리 | ⚠️ | 별도 콜백이 없어 서비스 `onDestroy`·`onTaskRemoved`에서 트립 종료 + 다음 서비스 시작 때 미종료 트립 복구로 대응(§5). 에뮬레이터에서 확인 못 함 |

## 1. geo fix 중계

`adb -s emulator-5554 emu geo fix <lon> <lat>`를 좌표를 바꿔 5회(각 3초 간격) 보낸 결과, `NubiLoc`에 그 좌표가 그대로 찍혔다.

```
11-08 18:31:13 NubiLoc: onChanged lat=37.5      lon=127.0
11-08 18:31:16 NubiLoc: onChanged lat=37.5099.. lon=127.01
11-08 18:31:19 NubiLoc: onChanged lat=37.5664.. lon=126.978
11-08 18:31:22 NubiLoc: onChanged lat=35.1796   lon=129.075
11-08 18:31:25 NubiLoc: onChanged lat=33.4996   lon=126.5312
```

- 앱 시작 직후 geo fix가 없으면 기본 좌표(37.421998, -122.084, 마운틴뷰)가 **약 1초 간격**으로 계속 온다. 값이 같아도 매초 콜백이 온다.
- `LocationData` 값 관찰: `heading`은 항상 0.0, `confidence`는 5.0(문서의 0~1 가정과 다름, 단위 미확인), `timestampMillis`는 epoch ms.
- 그래서 E2E는 geo fix 대신 **debug 위치 주입(gpx 재생)** 을 쓴다. 이유는 중계 실패가 아니라 (a) 1초 간격 재생을 앱 안에서 정확히 통제할 수 있고, (b) 기본 좌표 스트림이 섞이는 것을 `acceptRealLocation=false`로 막을 수 있기 때문이다. geo fix 경로도 동작한다.

## 2. 백그라운드 수신

기록 중(`Started` 이후)에 `am start -a android.settings.SETTINGS`로 설정 앱을 앞에 띄우고(`topResumedActivity=com.android.car.settings`) geo fix 3회를 보냈다.

```
18:32:07 NubiLoc: onChanged lat=37.5 lon=127.04
18:32:07 NubiTrip: 이벤트 PointsAccepted seq=6 ...
18:32:10 NubiLoc: onChanged lon=127.0499..  /  NubiTrip: PointsAccepted seq=7
18:32:12 NubiLoc: onChanged lon=127.06      /  NubiTrip: PointsAccepted seq=8
```

- 서비스는 포그라운드 서비스(`foregroundServiceType=location`)이고, Activity가 `onStop`이어도 계속 받는다.
- `ERROR_DRIVING_RESTRICTED`: 이 에뮬레이터에서는 `hmg_car_service`가 없고(`Can't find service`), `cmd car_service emulate-driving-state`는 user 빌드라 거부(`requires non-user build`), 가상 콘솔(8088)의 `/vehicle/gear`는 `emulator_inactive`로 막힌다. 기어 D 주입은 앱 안의 신호일 뿐 차량 주행 상태를 바꾸지 않으므로 이 조건을 확인하지 못했다. 앱은 `onError`를 `NubiLoc`에 기록만 한다. **실차 확인 항목**: 주행 중(D, 주행 중)에 위치 콜백이 끊기거나 `onError(ERROR_DRIVING_RESTRICTED)`가 오는지.

## 3. 권한 등급

`adb shell pm list permissions -f`의 protectionLevel.

| 권한 | 등급 | 비고 |
|---|---|---|
| `pleos.car.permission.FUSED_LOCATION` | dangerous | 런타임 요청. 설명 카드의 버튼으로 `requestPermissions`를 부르면 Pleos 권한은 시스템 다이얼로그 없이 부여되고, 위치(COARSE)만 다이얼로그가 뜬다 |
| `pleos.car.permission.CAR_INFO` | normal | 설치 때 부여 |
| `pleos.car.permission.CAR_DRIVE` | normal | 설치 때 부여 |
| `android.car.permission.CAR_POWERTRAIN` | normal | 기어. 설치 때 부여 |
| `android.car.permission.CAR_SPEED` | dangerous | **요청하지 않음**(속도 미수집 결정). 과거 실측: 거부돼도 기록은 계속됐음 |
| `android.permission.FOREGROUND_SERVICE_LOCATION` | normal\|instant | 설치 때 부여 |

### Android 14 포그라운드 서비스 위치 권한 (발견)

`foregroundServiceType="location"` 서비스를 `ACCESS_COARSE_LOCATION`·`ACCESS_FINE_LOCATION` 없이 시작하면 앱이 죽는다.

```
SecurityException: Starting FGS with type location ... requires permissions:
 allOf=true [android.permission.FOREGROUND_SERVICE_LOCATION]
 allOf=false [android.permission.ACCESS_COARSE_LOCATION, android.permission.ACCESS_FINE_LOCATION]
```

`FUSED_LOCATION`(Pleos)을 줘도 같은 오류다. 그래서 매니페스트에 `ACCESS_COARSE_LOCATION`을 추가하고 `FUSED_LOCATION`과 함께 요청한다(사양의 권한 목록에서 벗어난 점). 위치 값은 계속 Pleos FusedLocation에서만 읽는다. Pleos 앱 심사가 이 표준 권한을 허용하는지는 **확인 필요**. 권한이 빠진 채로 서비스가 시작돼도 앱이 죽지 않게 `startForeground` 실패는 잡아서 서비스만 접는다.

## 4. VIN·오도미터·기어(·속도: 제거됨)

| 항목 | 결과 |
|---|---|
| VIN (`CarInfo.getVINInfo`) | 성공, 길이 9의 문자열(에뮬레이터 더미로 보임). VIN을 서버(`POST /vehicles/register`)에 보내 `HMAC-SHA256(서버 키, VIN)` 차량 ID를 받아 암호화 저장·재사용(앱 pepper 방식은 폐기). 서버는 VIN을 저장·로그하지 않음. 원문은 앱 로그에 길이만 남김. ID를 받기 전에는 UUID를 저장하지 않고 업로드를 보류. 서버 ID를 UUID 대체 뒤에 받으면 `POST /vehicles/alias`로 이어 준다. 서버는 VIN을 정규화(trim·대문자)해 `[A-Z0-9]{1,64}`만 받으며 9자 더미도 통과하고, 표준 17자 형식이 아니면 응답에 `vinFormat: nonstandard`만 표시한다(2026-11-08 E2E 2회 통과). 2026-11-08 E2E: 등록 성공, 서버 저장 트립의 vehicleId가 hex 64자 |
| `FusedLocation.isSupported()` | 에뮬레이터에서 `true`(logcat `NubiLoc isSupported=true`). false면 앱은 UNSUPPORTED로 두고 콜백을 등록하지 않음(실차 미확인) |
| 오도미터 (`Odometer.getCurrentDistanceDriven`) | 성공, `0.0`(트립 시작·종료 모두). 단위는 km로 가정(에뮬레이터 값이 0이라 단위 확인 못 함) |
| 기어 (`GEAR_SELECTION`) | 4(`VehicleGear.GEAR_PARK`). 차곡과 같은 방식으로 읽힘 |
| 속도 (`PERF_VEHICLE_SPEED`) | **제거됨.** 제거 전 실측: `CAR_SPEED` 허용 시 `0.0 m/s` 수신, 거부 시 `getCarPropertyConfig`가 null |

## 5. 에뮬레이터에서 안 되는 것 (실차 확인 목록)

| 항목 | 상태 |
|---|---|
| 주행 중 `ERROR_DRIVING_RESTRICTED`와 위치 콜백 지속 | ⚠️ 주행 상태를 만들 수 없음 |
| 기어 D·R·N 전환 | ⚠️ 가상 콘솔 주입이 `emulator_inactive`. debug 주입으로만 대체 |
| 오도미터 단위·증가 | ⚠️ 에뮬레이터 값 0 고정 |
| VIN 실제 형식(17자)과 `CAR_INFO` 승인 여부 | ⚠️ 더미 값만 확인 |
| 위치 `confidence` 단위, `heading` 실제 값, 갱신 주기(실차) | ⚠️ 에뮬레이터는 1초·heading 0·confidence 5 |
| Suspend(IGN OFF) 때 서비스 종료·`onDestroy` 호출 | ⚠️ 에뮬레이터에서 못 일으킴. 처리 방식(변경됨): `onDestroy`·`onTaskRemoved`에서 마지막 채택 샘플 시각으로 트립을 종료하고 `Vehicle.release()`를 부른다. `onDestroy` 없이 프로세스가 죽을 수 있으므로 **서비스 시작 때 '시작했으나 End를 못 보낸 트립'에 마지막 샘플 시각으로 End를 큐에 넣는다**(미종료 트립 복구). 실차에서 어느 경로로 끝나는지 확인 필요 |
| 시동 ON 때 앱·서비스 자동 실행 | ⚠️ 이번 범위 밖. 서비스는 앱을 한 번 열어야 시작됨 |
| 실제 네트워크 단절·셀룰러 | ⚠️ 서버 정지로 업로드 실패·재시도 로그만 확인 |

## 6. 주입 도구 (debug 전용)

`nubi-debug://signal?reset=1&vin=<VIN>&real=1&gear=P|R|N|D&loc=<lat>,<lon>[,<heading>]&gpx=<파일명>&park=1&now=<epoch ms>&flush=1` (`android.permission.DUMP` 호출자만, 속도 주입은 제거됨). `reset=1`은 상태·큐를 비우고 **실제 위치 수신을 끈다**(이후 `loc`·`gpx`만 받는다. 다시 켜려면 `real=1`). 끄는 일은 즉시, 비우는 일은 엔진 큐로 처리하므로 reset 뒤에 시작한 gpx 샘플이 비우기보다 먼저 처리되지 않는다(이전에는 reset이 실제 위치를 다시 켜 `gpx`와 순서가 엇갈릴 수 있었다). `vin`은 차량 SDK 대신 그 VIN으로 서버 차량 ID를 받게 한다(E2E가 `pm clear` 뒤에도 서버 발급 ID를 쓰려고). `park=1`은 gpx 재생이 끝나면 기어를 P로 바꾼다(숫자는 기어 P에서만 보이므로 재생 끝을 화면으로 알 수 있다). `now`는 기어 처리 뒤에 시계를 옮기며(`gear=P&now=+6분`으로 P 5분 종료를 건너뜀) 상태기계에 넘기는 elapsedRealtime·벽시계에만 더해지고 서버 재시도 간격·VIN 대기에는 쓰이지 않는다. 엔진의 `setClock`·`reset`·`flush`는 `BuildConfig.DEBUG`일 때만 동작한다.

## 7. 맵매칭 인프라 실측 (feat/02, 2026-11-09, Apple Silicon arm64)

설치: Colima 0.10.3(`--cpu 4 --memory 6 --disk 40`, aarch64 VM, Docker 서버 29.5.2), docker CLI 29.9.3, osmium-tool 1.19.1(도로 DB 빌드용, brew로 추가 설치). 모두 brew.

| 항목 | 값 |
|---|---|
| Valhalla 이미지 | `ghcr.io/gis-ops/docker-valhalla/valhalla:3.5.1`(멀티아크, arm64 매니페스트 확인. 태그 목록에 3.5.1이 가장 새 버전 번호라 고정, `latest` 미사용) |
| pbf | `south-korea-latest.osm.pbf` 291,304,615 B(278 MB), OSM 타임스탬프 2026-11-08T21:21:00Z, way 3,859,299개. 다운로드 약 2분 40초 |
| 타일 빌드 | 약 3분(컨테이너 생성부터 `/status` 200까지 183초). `server/data/valhalla` 1.7 GB = `valhalla_tiles/` 746 MB + `valhalla_tiles.tar` 669 MB + admin 8 MB(디렉터리는 빌드 중간 산출물이지만 이미지가 둘 다 남김). 타일 595개 |
| 컨테이너 메모리 | 빌드 중 최대 약 4.3 GiB(VM 5.77 GiB 중), 서빙 대기 약 110~155 MiB |
| 도로 DB | `roads-202611.sqlite` 361 MB(361,291,776 B, 재빌드 뒤 `roads.split_length_m` 열 포함), 빌드 12.9초(osmium 필터·export 포함, 2026-11-10 재빌드), 최대 RSS 2.1 GB(최초 빌드) |
| 멱등성 | `setup-valhalla.sh` 재실행 0.3초(기존 컨테이너 재사용), `valhalla-up.sh` 정지 상태에서 2.2초 |

도로 DB 통계(전국, 사양 3-2 등급, **2026-11-10 oneway 규칙 정정 후 재빌드**): way 734,533개, road_key 79,478개(`nm:` 78,811), 총 길이 227,980 km, 이름·번호 있는 길이 140,444 km(분리 차로 1/2 적용 전) → **122,263.24 km(적용 후, 분모)**. 재빌드 전 분모는 122,421.73 km였고 **−158.49 km** 줄었다: oneway를 `yes`뿐 아니라 `-1`(이름 있는 주요 4등급 way 129개, 58.4 km → 유효 −29.2 km)과 motorway(_link)의 암묵 oneway(태그 없는 610개, 258.5 km → −129.3 km)까지 분리 구간으로 봤기 때문이다. way·road 개수와 등급별 길이는 그대로. 분리 구간으로 센 way(`eff_length_m < length_m`)는 138,508개 → 139,575개, `roads.split_length_m` 합계 18,180.9 km. 이름·번호 없는 way 377,897개(51.4%), 길이로 38.4%(87,536 km).

| highway | km | way |
|---|---|---|
| residential | 76,048 | 351,321 |
| tertiary | 41,363 | 82,061 |
| unclassified | 37,927 | 109,413 |
| secondary | 25,538 | 49,911 |
| primary | 15,622 | 33,399 |
| trunk | 11,046 | 25,207 |
| motorway | 10,656 | 20,414 |
| trunk_link | 3,368 | 17,096 |
| motorway_link | 2,997 | 11,604 |
| primary_link | 1,584 | 13,309 |
| secondary_link | 1,093 | 11,155 |
| tertiary_link | 740 | 9,643 |

동명이로: `nm:` 키 78,811개 중 way 중심점 범위의 대각선이 50 km를 넘는 키가 3,668개(4.7%, 해당 way 50,574개). 사양 6-1의 '알려진 한계' 규모.

스모크(E2E GPX 30점, `POST /trace_attributes`, 사양 3-1 파라미터): 응답 `server/test/fixtures/valhalla-e2e-north.json`. edge 17개·합계 851 m(GPS 725 m), unmatched 1점(첫 점), matched 29점. 문제·주의:
- GPX 궤적(경도 126.978 고정)이 세종대로 차로 위가 아니라 인접 골목(세종대로20·22길, 청계천로, 종로1길 등)으로 붙었다. 세종대로 이름이 붙은 edge는 way 378453707 하나(23 m)뿐이고 이 way는 `ref=31`이 있어 6-1 규칙으로 road_key가 `nr:31`('국도 31호선')이 된다. 종로 way(474532059)도 `nr:6`. 따라서 **사양 8장 E2E 단언 'coverage/roads에 displayName이 세종대로를 포함'은 이 궤적으로는 성립하지 않는다**(`nm:세종대로` road는 DB에 있으나 궤적이 지나지 않음). 궤적 좌표를 세종대로 차로 중심선으로 옮기거나 단언을 바꿔야 한다.
- edge 중 way 221974030·1551642275(`service_other`)는 도로 DB(service 제외)에 없어 `ignored_ways`로 센다. 이름 없는 way(`unnamed:*`) 5개(primary_link 2·residential 3)는 분자·분모에서 빠진다.
- Valhalla `edge.length` 단위는 km(응답 `units: kilometers`)다. 미터 환산 필요.
- 타일 빌드 중 북한 행정구역 relation 경고(`missing way member`)가 나오나 무시해도 된다.

### 7-1. 도로 색칠 E2E 실측 (feat/02, 2026-11-10 리뷰 반영 뒤, `pnpm e2e:car` 두 flow)

전국 도로 DB(`roads-202611.sqlite`, 재빌드 뒤 분모 122,263.24 km)와 실제 Valhalla 3.5.1 컨테이너. GPX `e2e-sejong`(광화문 → 숭례문 방향 60점, GPS 거리 1,481 m). 설치 뒤 `pm clear`로 앱 데이터를 비우고, 검증 대상 트립은 GPX의 점 수·첫/끝 좌표로 골랐다.

| 항목 | 실측 |
|---|---|
| newKm(세종대로 트립, 전국 달린 길이 증가분) | 1.245 km (기대 1.12~1.37, ±10%) |
| newKm(e2e-north 트립) | 0.163 km (골목 매칭, `done`) |
| 완료율 전후(세종대로 트립) | before 0.0001% → after 0.0012%(소수 4자리) |
| `(after − before)/100` vs `newKm / totalKm` | 1.100e-5 vs 1.018e-5, 차 8.2e-7 ≤ 1e-6(반올림 오차 상한, 테스트 허용 1.01e-6) |
| 누적 drivenKm / nationalPercent | 1.41 km / 0.0012 % |
| 매칭 소요(서버 `finishedAt - startedAt`) | 9 ms(Valhalla 로컬 호출 포함) |
| segments(GPX bbox) / 시작한 도로 | 11개 / 5개 |
| 차량 화면(기어 P, 종료됨) | `새 도로 1.2km · 전국 0.0012% (+0.0011)` + 대기 줄 `전국 0.0012% 달렸어요`. 기어 D로 바꾸면 두 줄 모두 숨음 |
| 차량 화면(기어 D, 기록 중) | `샘플`·`거리`·`전국` 숫자 줄 없음. 재생이 끝나 기어 P가 되면(`park=1`) `샘플 30`/`샘플 60`·`거리 …m` |
| 사정 | `PORT=8788`로 실행(8787은 차곡). 에뮬레이터 VIN(9자)은 서버 VIN 형식 검사에 걸려 `POST /vehicles/register`가 400이라, 이전에는 앱에 저장돼 있던 옛 차량 ID가 쓰였다. `pm clear` 뒤에는 그 ID가 없어 UUID로 대체되므로 debug 신호 `vin=`으로 주입한 VIN(`E2EAPPVIN0000001`)으로 서버 발급 ID를 받고, `verify-trip`이 `HMAC(키, 주입 VIN)`과 트립의 vehicleId가 같은지 본다 |

### 7-2. 묶음별 상한 수동 확인: 국도 48호선 `nr:48` (feat/02, 2026-11-10)

전국 도로 DB(`roads-202611.sqlite`, 재빌드 뒤)의 `nr:48` = way 305개: 분리 구간 273개(Σ length 100.126 km → 상한 `split_length_m` 50.063 km) + 양방향 32개(10.246 km) = 총길이 `total_length_m` 60.308 km. 서버 `createApp`에 이 DB를 붙이고 `driven_ways`에 way별 커버리지 1.0을 직접 넣어 `/coverage/roads`·`/coverage/summary`로 확인했다.

| 넣은 way | Σ 커버리지×length | 도로 달린 길이 / 총길이 | 완주 | 전국 달린 길이(summary) |
|---|---|---|---|---|
| 분리 구간 상·하행 273개 전부 | 100.126 km | 50.063 / 60.308 km = **83.01%** | 아니오 | 50.06 km |
| 양방향 구간 32개만 | 10.246 km | 10.246 / 60.308 km = 16.99% | 아니오 | 10.25 km |
| 전부(305개) | 110.371 km | 60.308 / 60.308 km = 100% | 예 | 60.31 km |

도로 단위 상한만 두던 이전 정의(`min(Σ, 총길이)`)는 첫 줄을 min(100.126, 60.308) = 60.308 km, 즉 **100% 완주**로 셌다. 묶음별 상한에서는 상·하행을 모두 달려도 양방향 구간의 몫(10.2 km)을 채우지 못해 83.01%에 그친다. 같은 정의는 단위 테스트(`server/test/matching.test.ts` 묶음별 상한: 분리 구간 2개 + 양방향 구간 1개 혼합 도로)로 고정했다.

## 8. 시군구 경계 데이터 (feat/03, 2026-11-10)

| 항목 | 값 |
|---|---|
| 원본 | vuski/admdongkor `ver20251231/HangJeongDong_ver20251231.geojson` 34,635,834 B, EPSG:4326(CRS84), 행정동 3,557개·252개 시군구 코드(일반구 포함). 저장소 최신은 ver20261001(전남광주통합특별시 코드 12, 인천 4개 신설구, 화성 일반구 반영) |
| 출처·라이선스 | 통계청 SGIS 행정동 경계(공공누리 제1유형, 출처표시 필수) → vuski 가공분 CC BY 4.0. 출처표시 문구는 사양 03 3장. 저장소 LICENSE-DATA 확인 |
| 기준일 | 2025-12-31. 2026-07-01 통합특별시는 `REGION_ALIAS` 27건으로 새 코드에 매핑(코드는 ver20261001 기준, 행안부 고시 원문 대조 못 함) |
| 빌드 | `node scripts/build-regions.mjs HangJeongDong_ver20251231.geojson 202512` → 0.6초, `regions.sqlite` 2,080,768 B(2.0 MB). 시군구 229개, 폴리곤 1,320개(병합 전 4,598), 정점 750,771 → 87,992. 면적 합계 100,627 km²(국토 약 100,364 km²). 홍천 1,807.3·종로 23.8 km² |
| 개수 | 229 = 시도별 서울25 부산16 대구9 인천10 광주·전남27(통합) 대전5 울산5 세종1 경기31 강원18 충북11 충남15 전북14 경북22 경남18 제주2. 사양 2장의 226과 3 차이(세종 1 포함 여부 등, 원인 미확정) |
| 인구감소지역 | depop_89 = 89(전수 매핑), depop_92 = 92(89 + 금정구·동두천시·통영시) |
| 픽스처 | `server/test/fixtures/regions-test.sqlite` 90,112 B: 종로·중·용산·성동 + 홍천·양구·인제 |
| 판정 확인 | `node scripts/verify-regions.mjs`: 세종대로 GPX 첫 점(37.575162,126.977065) = 종로구(11110), 끝 점(37.562023,126.976073) = 중구(11140). 시도 도청 좌표 17곳 전부 해당 시군구로 판정, 동해 한가운데는 없음 |
| 한계 | 행정동 병합 경계라 해안선·섬이 SGIS 수준(30m 단순화 추가). 시군구 간 경계는 각자 단순화돼 최대 약 30m 틈·겹침이 있을 수 있음(판정은 폴리곤 any) |
| 재리뷰 반영(2026-11-10) | `geo-utils.mjs`를 `server/src/shared/`로 옮기고 서버 `build`가 `dist/shared/`로 복사(`node dist/regions/index.js` import 확인). 서버 단위 123개·차량 단위 통과, E2E 세 flow 재시도 없이 2회 연속 통과(`retried` 없음, 시군구 2/229·인구감소지역 0/92·서울 중구 하룻밤) |


## 9. 시군구 판정·도로 키 지역 접두 실측 (feat/03, 2026-11-10)

### 9-1. 도로 키 지역 접두

전국 도로 DB 재빌드: `node scripts/build-road-db.mjs server/data/osm/south-korea-latest.osm.pbf 202611 --regions server/data/regions/regions.sqlite`(19.7초, 361.3 → 367.7 MB).

| 항목 | 값 |
|---|---|
| way 위치 판정 | 733,318개(99.83%)가 시군구 안, 1,215개(0.17%)는 해상·경계 밖이라 `00` 접두 |
| road_key 수 | 79,478 → 88,839. `nm:` 78,811 → 87,699(이 중 `nm:00:` 69), `lr:` 918(시도 접두) |
| 분모(이름 있는 도로 유효 총길이) | 122,263.24 km 그대로(키만 바뀌고 길이는 같음) |
| 동명이로 해소 | 옛 `nm:` 키 중 중심점 범위 대각선 > 50 km인 3,668개가 **전부(100%)** 시군구별로 쪼개져 새 키 11,226개가 됐고, 접두 적용 뒤 대각선 > 50 km인 `nm:` 키는 0개(이전 3,668개·4.7%). 같은 시군구 안 같은 이름 도로는 계속 한 키 |
| 부작용 | 한 도로가 시군구 경계를 넘으면 두 키로 갈린다(예: 세종대로는 `nm:11110:세종대로`(종로구)·`nm:11140:세종대로`(중구)). 도로 완주 기준(95%)은 시군구별로 따로 센다. 표시 이름은 9-4에서 시도 단축명 접두 규칙으로 보정("서울 중구 세종대로") |
| 테스트 DB | `roads-test.sqlite` 재생성(bbox 126.9611,37.5405,127.0024,37.5870, 월 209901): way 830 → 1,328, 606 KB. (정정 2026-11-10: 앞 문서의 bbox 값은 실제 빌드 값이 아니었다. 아래 9-4의 재빌드도 이 bbox다.) `e2e-sejong.gpx`는 새 DB에서 바이트 단위로 같게 재생성됨 |
| E2E 영향 | 도로 색칠 flow 값 불변: newKm 1.245, drivenKm 1.41, `nr:31` 그대로 |

### 9-2. 시군구 판정 소요

| 항목 | 값 |
|---|---|
| E2E 세종대로 트립(60점) | 0.3 ms, 중구 12점 트립 0.13~0.15 ms |
| 서울 → 부산 직선 20,000점(솎아 2,000점, 24개 시군구) | 첫 호출 26.8 ms(폴리곤 파싱 포함), 이후 13.6~14.0 ms |

### 9-3. E2E 실측 (`PORT=8788 pnpm e2e:car`, 세 flow, 재시도 없음 2회 연속)

| 항목 | 1회차(20261110-033126) | 2회차(20261110-033438) |
|---|---|---|
| summary.json `retried` | `""` | `""` |
| 도로 색칠 newKm / drivenKm | 1.245 / 1.41 | 1.245 / 1.41 |
| 시군구: total / colored / byLevel | 229 / 2 / {1:1, 2:0, 3:1} | 같음 |
| 인구감소지역 | total89 89, colored89 0, total92 92 | 같음 |
| 중구(11140) / 종로구(11110) 단계 | 3(숙박) / 1(통과) | 같음 |
| 간격: 세종대로 종료 → 둘째 트립 시작 | 922 s(방문) | 919 s |
| 간격: 둘째 종료 → 셋째 시작(다음 날 07:00 KST) | 97,861 s(≥ 6시간 + 자정) | 97,674 s |
| lastEvent | stay 중구 @ 2026-11-10T22:00:00.580Z | 같음(.578Z) |
| 중구 이웃(neighbors) | 6개 | 6개 |
| 차량 화면(기어 P) | 둘째 트립 뒤 `시군구 2/229 · 인구감소지역 0/89`, `중구 방문`. 셋째 뒤 `중구에서 하룻밤`. 기어 D로 바꾸면 도감 줄·이벤트 줄 모두 숨음 | 같음 |

`처음 지난 곳` 줄은 E2E에서 단언하지 않는다(같은 차량으로 앞 flow가 종로구·중구를 이미 칠했다). 단위 테스트(`RegionsTest`, `regions.test.ts`)로 검증.

### 9-4. 리뷰 반영 재빌드(2026-11-10): 표시 이름·경계 틈 보정·`--regions` 필수

| 항목 | 값 |
|---|---|
| 지역 DB | `node scripts/build-regions.mjs HangJeongDong_ver20251231.geojson 202512`: 229개, 폴리곤 1,320, 2,080,768 B, `regions.display_name` 열 추가. 시도 단축명 접두가 붙은 곳 71개(구 단위 + 고성군 2: "강원 고성군"·"경남 고성군"), 유일한 시·군은 그대로("홍천군") |
| 도로 DB | `node scripts/build-road-db.mjs server/data/osm/south-korea-latest.osm.pbf 202611 --regions server/data/regions/regions.sqlite`(20.6초, 367,996,928 B). 전국 빌드는 `--regions` 없으면 오류, `snapshot.regions_month`=202512 기록 |
| way 위치 판정 | 733,618개 시군구 안(이전 733,318 → +300은 50m 경계 틈 보정), 915개(0.12%)가 `00` 접두 |
| road_key | 88,839 → 88,814(경계 틈 보정으로 `nm:00:` 키가 일부 해당 시군구 키에 합쳐짐), `nm:` 87,679. 동명이로 대각선 > 50km 옛 키 3,668개는 전부 쪼개져 새 키 11,220개. 분모 122,263.24 km 불변 |
| 표시 이름 예 | `nm:11140:세종대로` → "서울 중구 세종대로", `lr:41:43` → "경기 지방도 43호선" |
| 테스트 픽스처 | `regions-test.sqlite`(7곳, display_name 포함) 재빌드. `roads-test.sqlite` 재빌드(bbox 126.9611,37.5405,127.0024,37.5870, 월 209901): way 2,359, 642 roads, 1,028,096 B |
