package com.nubi.car.trip

enum class UploadKind { NONE, OK, FAILED, HELD }

/** 마지막 업로드 결과. 화면 문구는 화면(strings.xml)이 정한다. */
data class UploadStatus(val kind: UploadKind = UploadKind.NONE, val points: Int = 0)

/** 화면이 읽는 현재 상태 스냅샷. 엔진이 갱신하고 화면이 1초마다 읽는다. */
data class TripStatus(
    val state: TripState = TripState.IDLE,
    val sampleCount: Int = 0,
    val distanceM: Int = 0,
    val upload: UploadStatus = UploadStatus(),
    val pendingPoints: Int = 0,
)
