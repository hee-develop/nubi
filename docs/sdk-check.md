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

`nubi-debug://signal?reset=1&real=1&gear=P|R|N|D&loc=<lat>,<lon>[,<heading>]&gpx=<파일명>&now=<epoch ms>&flush=1` (`android.permission.DUMP` 호출자만, 속도 주입은 제거됨). `reset=1`은 상태·큐를 비우고 **실제 위치 수신을 끈다**(이후 `loc`·`gpx`만 받는다. 다시 켜려면 `real=1`). 끄는 일은 즉시, 비우는 일은 엔진 큐로 처리하므로 reset 뒤에 시작한 gpx 샘플이 비우기보다 먼저 처리되지 않는다(이전에는 reset이 실제 위치를 다시 켜 `gpx`와 순서가 엇갈릴 수 있었다). `now`는 기어 처리 뒤에 시계를 옮기며(`gear=P&now=+6분`으로 P 5분 종료를 건너뜀) 상태기계에 넘기는 elapsedRealtime·벽시계에만 더해지고 서버 재시도 간격·VIN 대기에는 쓰이지 않는다. 엔진의 `setClock`·`reset`·`flush`는 `BuildConfig.DEBUG`일 때만 동작한다.
