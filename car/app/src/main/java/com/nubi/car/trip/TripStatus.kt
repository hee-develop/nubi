package com.nubi.car.trip

/** 위경도 한 점. 값은 로그에 직접 남기지 않는다([coordForLog]). */
data class LatLon(val lat: Double, val lon: Double)

/** [END_SENT]: 점은 없고 트립 종료(End)만 전송한 drain. 화면에는 '성공: 0점' 대신 '종료 전송 완료'로 보인다. */
enum class UploadKind { NONE, OK, END_SENT, FAILED, HELD }

/** 마지막 업로드 결과. 화면 문구는 화면(strings.xml)이 정한다. */
data class UploadStatus(val kind: UploadKind = UploadKind.NONE, val points: Int = 0)

/** 기록 자체가 돌 수 있는 상태인지. [SERVICE_FAILED]는 재시작 뒤에도 남도록 저장한다. */
enum class RecorderHealth { OK, SERVICE_FAILED, UNSUPPORTED }

/** 화면이 읽는 현재 상태 스냅샷. 엔진이 갱신하고 화면이 1초마다 읽는다. */
data class TripStatus(
    val state: TripState = TripState.IDLE,
    /** 마지막으로 읽은 기어. 못 읽는 차량은 null. */
    val gear: Gear? = null,
    val sampleCount: Int = 0,
    val distanceM: Int = 0,
    val upload: UploadStatus = UploadStatus(),
    val pendingPoints: Int = 0,
    /** 큐를 아직 불러오는 중(워커에서 읽고 복호화한다). */
    val loading: Boolean = true,
    val health: RecorderHealth = RecorderHealth.OK,
    /** 큐 파일 쓰기·인코딩 실패 누적 횟수. */
    val saveFailures: Int = 0,
    /** 복호화·해석 실패로 건너뛴 저장 줄 수. */
    val corruptLines: Int = 0,
    /** 암호화 키를 새로 만들어 읽을 수 없게 돼 폐기한 저장 줄 수. */
    val discardedLines: Int = 0,
    /** 암호화 키를 쓸 수 없어 이번 실행은 디스크에 저장하지 않고 메모리에서만 동작 중('저장 보류(키 오류)'). */
    val storageHeld: Boolean = false,
    /** 마지막으로 받은 원시 위치(기어 무관, 트립에는 안 넣음). 정차 화면의 '지금 있는 곳' 조회에만 쓰고 메모리에만 둔다. 없으면 null. 화면에 그리거나 로그에 남기지 않는다. */
    val lastLocation: LatLon? = null,
) {
    companion object {
        val SERVICE_FAILED = RecorderHealth.SERVICE_FAILED
        val UNSUPPORTED = RecorderHealth.UNSUPPORTED
    }
}

/**
 * 완료율·새 도로·샘플·거리 같은 **숫자**를 화면에 보여도 되는지(사양 02 7장, Pleos '주행 중 게임 요소' 거절 사유 회피).
 * 기어를 읽을 수 있으면 기어가 P일 때만(상태기계 상태와 무관). 기어를 못 읽는(null) 차량은 상태기계가 RECORDING이 아닐 때만 보인다.
 */
fun numbersVisible(gear: Gear?, state: TripState): Boolean = if (gear != null) gear == Gear.P else state != TripState.RECORDING
