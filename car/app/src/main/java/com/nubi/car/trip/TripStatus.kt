package com.nubi.car.trip

enum class UploadKind { NONE, OK, FAILED, HELD }

/** 마지막 업로드 결과. 화면 문구는 화면(strings.xml)이 정한다. */
data class UploadStatus(val kind: UploadKind = UploadKind.NONE, val points: Int = 0)

/** 기록 자체가 돌 수 있는 상태인지. [SERVICE_FAILED]는 재시작 뒤에도 남도록 저장한다. */
enum class RecorderHealth { OK, SERVICE_FAILED, UNSUPPORTED }

/** 화면이 읽는 현재 상태 스냅샷. 엔진이 갱신하고 화면이 1초마다 읽는다. */
data class TripStatus(
    val state: TripState = TripState.IDLE,
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
) {
    companion object {
        val SERVICE_FAILED = RecorderHealth.SERVICE_FAILED
        val UNSUPPORTED = RecorderHealth.UNSUPPORTED
    }
}
