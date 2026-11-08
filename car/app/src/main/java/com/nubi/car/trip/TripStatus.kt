package com.nubi.car.trip

/** 화면이 읽는 현재 상태 스냅샷. 엔진이 갱신하고 화면이 1초마다 읽는다. */
data class TripStatus(
    val state: TripState = TripState.IDLE,
    val sampleCount: Int = 0,
    val distanceM: Int = 0,
    val lastUpload: String = "없음",
    val pendingPoints: Int = 0,
    val vehicleId: String = "",
)
