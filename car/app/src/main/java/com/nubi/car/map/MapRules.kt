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
        "region=${snapshot.regions.size} z=${"%.1f".format(java.util.Locale.US, zoom)} follow=${if (follow) "on" else "off"}"
