# SDK 실측 기록 (주행 기록 기능)

- 환경: Pleos 에뮬레이터 `Pleos_Connect_v2_1`(`emulator-5554`, user 빌드, 앱은 사용자 10에서 실행), 2026-11-08 실측
- SDK: FusedLocation 1.1.3, Vehicle 2.3.2
- 판정: ✅ 확인됨(로그 근거) · ⚠️ 에뮬레이터에서 확인 못 함(실차 확인 필요) · ❌ 안 됨
- 로그 태그: `NubiLoc`(위치), `NubiTrip`(상태기계·업로드), `NubiVehicle`(VIN·오도미터), `NubiCarSignals`(기어·속도), `NubiService`

## 요약

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | `adb emu geo fix`가 FusedLocation `onChanged`로 중계됨 | ✅ | 5회 모두 그 좌표로 도착 |
| 2 | 다른 앱이 앞에 있어도 서비스가 위치를 계속 받음 | ✅ | 설정 앱을 앞에 두고 geo fix 3회, 모두 수신·샘플 채택 |
| 2' | `ERROR_DRIVING_RESTRICTED` 발생 조건 | ⚠️ | 에뮬레이터(user 빌드)에서 실제 주행 상태를 만들 수 없어 확인 못 함 |
| 3 | 권한 등급 | ✅ | 아래 표 |
| 3' | VIN·오도미터 실제 값 | ✅ | VIN은 9자 문자열(해시해서 사용), 오도미터는 0.0 |
| 4 | 기어(AAOS) 읽기 | ✅ | `GEAR_SELECTION`=4(PARK) |
| 5 | 속도(AAOS) 읽기와 거부 시 동작 | ✅ | 허용 시 0.0m/s, 거부 시 "미지원 속성"만 남기고 앱 유지 |
| 6 | Android 14 `location` 타입 포그라운드 서비스 | ⚠️ | Pleos 위치 권한만으로는 시작 불가, `ACCESS_COARSE_LOCATION` 추가 필요(아래) |
| 7 | 실제 주행 중 기어·속도·위치 | ⚠️ | 에뮬레이터는 기어 P 고정. 기어 D·속도는 debug 주입으로만 확인 |

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
- `ERROR_DRIVING_RESTRICTED`: 이 에뮬레이터에서는 `hmg_car_service`가 없고(`Can't find service`), `cmd car_service emulate-driving-state`는 user 빌드라 거부(`requires non-user build`), 가상 콘솔(8088)의 `/vehicle/gear`는 `emulator_inactive`로 막힌다. 기어 D 주입은 앱 안의 신호일 뿐 차량 주행 상태를 바꾸지 않으므로 이 조건을 확인하지 못했다. 앱은 `onError`를 `NubiLoc`에 기록만 한다. **실차 확인 항목**: 주행 중(D, 속도>0)에 위치 콜백이 끊기거나 `onError(ERROR_DRIVING_RESTRICTED)`가 오는지.

## 3. 권한 등급

`adb shell pm list permissions -f`의 protectionLevel.

| 권한 | 등급 | 비고 |
|---|---|---|
| `pleos.car.permission.FUSED_LOCATION` | dangerous | 런타임 요청. 설명 카드의 버튼으로 `requestPermissions`를 부르면 Pleos·CAR_SPEED는 시스템 다이얼로그 없이 부여되고, 위치(COARSE)만 다이얼로그가 뜬다 |
| `pleos.car.permission.CAR_INFO` | normal | 설치 때 부여 |
| `pleos.car.permission.CAR_DRIVE` | normal | 설치 때 부여 |
| `android.car.permission.CAR_POWERTRAIN` | normal | 기어. 설치 때 부여 |
| `android.car.permission.CAR_SPEED` | dangerous | 속도. 거부돼도 기록은 계속됨 |
| `android.permission.FOREGROUND_SERVICE_LOCATION` | normal\|instant | 설치 때 부여 |

### Android 14 포그라운드 서비스 위치 권한 (발견)

`foregroundServiceType="location"` 서비스를 `ACCESS_COARSE_LOCATION`·`ACCESS_FINE_LOCATION` 없이 시작하면 앱이 죽는다.

```
SecurityException: Starting FGS with type location ... requires permissions:
 allOf=true [android.permission.FOREGROUND_SERVICE_LOCATION]
 allOf=false [android.permission.ACCESS_COARSE_LOCATION, android.permission.ACCESS_FINE_LOCATION]
```

`FUSED_LOCATION`(Pleos)을 줘도 같은 오류다. 그래서 매니페스트에 `ACCESS_COARSE_LOCATION`을 추가하고 `FUSED_LOCATION`과 함께 요청한다(사양의 권한 목록에서 벗어난 점). 위치 값은 계속 Pleos FusedLocation에서만 읽는다. Pleos 앱 심사가 이 표준 권한을 허용하는지는 **확인 필요**. 권한이 빠진 채로 서비스가 시작돼도 앱이 죽지 않게 `startForeground` 실패는 잡아서 서비스만 접는다.

## 4. VIN·오도미터·기어·속도

| 항목 | 결과 |
|---|---|
| VIN (`CarInfo.getVINInfo`) | 성공, 길이 9의 문자열(에뮬레이터 더미로 보임). SHA-256 hex를 차량 ID로 사용. 원문은 로그에 길이만 남김 |
| 오도미터 (`Odometer.getCurrentDistanceDriven`) | 성공, `0.0`(트립 시작·종료 모두). 단위는 km로 가정(에뮬레이터 값이 0이라 단위 확인 못 함) |
| 기어 (`GEAR_SELECTION`) | 4(`VehicleGear.GEAR_PARK`). 차곡과 같은 방식으로 읽힘 |
| 속도 (`PERF_VEHICLE_SPEED`) | `CAR_SPEED` 허용 시 `0.0 m/s` 수신. 거부 시 `getCarPropertyConfig`가 null이라 "미지원 속성 id=291504647"만 기록하고 앱 유지, 샘플 속도는 null |

## 5. 에뮬레이터에서 안 되는 것 (실차 확인 목록)

| 항목 | 상태 |
|---|---|
| 주행 중 `ERROR_DRIVING_RESTRICTED`와 위치 콜백 지속 | ⚠️ 주행 상태를 만들 수 없음 |
| 기어 D·R·N 전환, 속도 변화 | ⚠️ 가상 콘솔 주입이 `emulator_inactive`. debug 주입으로만 대체 |
| 오도미터 단위·증가 | ⚠️ 에뮬레이터 값 0 고정 |
| VIN 실제 형식(17자)과 `CAR_INFO` 승인 여부 | ⚠️ 더미 값만 확인 |
| 위치 `confidence` 단위, `heading` 실제 값, 갱신 주기(실차) | ⚠️ 에뮬레이터는 1초·heading 0·confidence 5 |
| Suspend(IGN OFF) 때 서비스 종료·`onDestroy` 호출 | ⚠️ 에뮬레이터에서 못 일으킴. `onDestroy`에서 트립 종료·flush는 구현 |
| 시동 ON 때 앱·서비스 자동 실행 | ⚠️ 이번 범위 밖. 서비스는 앱을 한 번 열어야 시작됨 |
| 실제 네트워크 단절·셀룰러 | ⚠️ 서버 정지로 업로드 실패·재시도 로그만 확인 |

## 6. 주입 도구 (debug 전용)

`nubi-debug://signal?reset=1&gear=P|R|N|D&speed=<kph>&loc=<lat>,<lon>[,<heading>]&gpx=<파일명>&now=<epoch ms>&flush=1` (`android.permission.DUMP` 호출자만). `loc`·`gpx`를 쓰면 실제 위치 콜백은 무시하고, `reset=1`이 다시 켠다. 기어 `now`는 기어 처리 뒤에 시계를 옮기며(`gear=P&now=+6분`으로 P 5분 종료를 건너뜀) 시계는 상태기계의 시각에만 쓰이고 서버 재시도 간격에는 쓰이지 않는다.
