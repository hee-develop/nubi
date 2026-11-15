package com.nubi.car.map

/** 화면에서 지도가 어느 모습으로 보이는지. */
enum class MapMode { OFF, DRIVING, PARKED }

/**
 * 지도 모드. 플래그가 꺼져 있으면 기존 03·03b 화면([MapMode.OFF]). 정차(03) 레이아웃이면 정차 지도, 아니면 주행 지도.
 */
fun mapMode(drivingMapFlag: Boolean, parkedLayout: Boolean): MapMode = when {
    !drivingMapFlag -> MapMode.OFF
    parkedLayout -> MapMode.PARKED
    else -> MapMode.DRIVING
}

/** 지도를 만지거나 버튼을 눌러도 되는지: 정차 지도이고 주행 규제(DO)가 없을 때만(fail-closed: DO를 모르면 true로 들어온다). */
fun mapInteractive(mode: MapMode, distractionOptimized: Boolean): Boolean = mode == MapMode.PARKED && !distractionOptimized

/** 주행 중 위 한 줄의 지역 이름 조각: 지금 시군구를 알면 `· 서울 중구`, 모르면 null. 상태 문구와 따로 놓아 두 줄로 나누지 않고 한 줄로 이어 보인다. */
fun drivingRegionText(displayName: String?): String? = displayName?.takeIf { it.isNotBlank() }?.let { "· $it" }

/**
 * 주행 중 지금 시군구 이름. 서버 잠정 매칭이 준 마지막 점의 시군구가 가장 최신이고, 없으면 정차 때 받아 둔 값([fallback])을 쓴다.
 */
fun currentRegionName(live: LiveState, fallback: String?): String? = live.region?.displayName ?: fallback

/** 줌 단계 조정: +/− 버튼은 1단계씩. */
const val ZOOM_STEP = 1.0

/** debug 빌드에서만 지도 뷰 contentDescription에 담는 요약(Maestro 단언용). release에서는 쓰지 않는다. */
fun debugSummary(snapshot: MapSnapshot, trailPoints: Int, roads: Boolean, regions: Boolean, zoom: Double, follow: Boolean): String =
    "지도 way=${snapshot.wayCount} driven=${snapshot.drivenCount} live=${snapshot.live.ways.size} new=${snapshot.live.newCount} " +
        "trail=$trailPoints roads=${if (roads) "on" else "off"} regions=${if (regions) "on" else "off"} " +
        "region=${snapshot.regions.size} load=${snapshot.load.name.lowercase()} z=${"%.1f".format(java.util.Locale.US, zoom)} follow=${if (follow) "on" else "off"}"

/** 정산된 트립이 지금 기록 중인 트립과 다르면(오프라인 백로그 정산) 현재 궤적·잠정 결과를 지우지 않는다. 지금 기록 중인 트립이 없거나 id를 모르면 지운다. */
fun shouldClearOnSettle(settledLocalId: String?, recordingLocalId: String?): Boolean =
    settledLocalId == null || recordingLocalId == null || settledLocalId == recordingLocalId

/**
 * 값이 바뀌어도 [holdMs] 동안은 보이던 값을 유지한다(시군구 경계에서 이름이 깜빡이지 않게, Pleos 가이드의 갱신 최소화).
 * 처음 값은 바로 보이고, 그 뒤 값이 달라지면 마지막으로 바꾼 지 [holdMs]가 지난 뒤에야 바꾼다. null(모름)도 같은 규칙이다.
 */
class HoldLast(private val holdMs: Long = 5_000L) {
    private var shown: String? = null
    private var since = Long.MIN_VALUE

    fun update(candidate: String?, nowMs: Long): String? {
        if (since == Long.MIN_VALUE) {
            shown = candidate
            since = nowMs
        } else if (candidate != shown && nowMs - since >= holdMs) {
            shown = candidate
            since = nowMs
        }
        return shown
    }

    fun reset() {
        shown = null
        since = Long.MIN_VALUE
    }
}

/** 두 방위(도)의 차이(0~180). */
fun bearingDiff(a: Double, b: Double): Double {
    val d = Math.abs(a - b) % 360.0
    return if (d > 180.0) 360.0 - d else d
}

/** 마커 방위를 바꿀 최소 각도 변화(도). 작은 흔들림으로 마커를 계속 돌리지 않는다. */
const val BEARING_STEP_DEG = 15.0

/** 주행 중 내 위치가 이만큼(dp) 움직여야 따라가기로 다시 그린다. 데이터가 바뀌면 이와 무관하게 그린다. */
const val FOLLOW_MIN_MOVE_DP = 8.0

/**
 * 업로드 타이머 간격. 주행 중 지도 플래그와 잠정 색칠 플래그가 켜져 있고 **지도 화면이 실제로 보일 때만** 20초, 아니면(플래그 꺼짐·백그라운드) 60초.
 * 점 100개 기준은 그대로다.
 */
fun uploadIntervalFor(drivingMap: Boolean, liveColoring: Boolean, visible: Boolean, normalMs: Long, mapMs: Long): Long =
    if (drivingMap && liveColoring && visible) mapMs else normalMs
