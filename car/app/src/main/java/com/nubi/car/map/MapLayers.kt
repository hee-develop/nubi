package com.nubi.car.map

/** 지도 색(시안 00 브랜드). ARGB. */
object MapColors {
    const val BG = 0xFF0F141B.toInt()
    const val UNDRIVEN = 0xFF2A3544.toInt()
    const val DRIVEN = 0xFFF59E0B.toInt()

    /** 바랜 길·지역: 채도 50%(계약서 05 2장). */
    const val FADED = 0xFFC79A4C.toInt()
    const val LIVE_NEW = 0xFFFBBF24.toInt()
    const val TRAIL = 0xFFFDE68A.toInt()
    const val DEPOP_BASE = 0xFF1C323A.toInt()
    const val REGION_BORDER = 0xCC2A3544.toInt()
    const val MARKER = 0xFFFFFFFF.toInt()
    const val ATTRIBUTION_TEXT = 0xFFA9B6C6.toInt()
}

/** 바램 기준일(계약서 05 3장 `isFaded(lastAt, now, days=365)`). */
const val FADE_DAYS = 365

fun isFaded(lastAtMs: Long, nowMs: Long, days: Int = FADE_DAYS): Boolean = nowMs - lastAtMs > days * 86_400_000L

enum class WayStyle { UNDRIVEN, DRIVEN, FADED, LIVE_NEW }

/** 바탕 way의 색 구분: 인정받은 적 없으면 안 간 길, 마지막 인정이 365일을 넘었으면 바램, 아니면 달린 길. */
fun wayStyle(way: MapWay, nowMs: Long): WayStyle = when {
    !way.driven -> WayStyle.UNDRIVEN
    isFaded(way.drivenAtMs, nowMs) -> WayStyle.FADED
    else -> WayStyle.DRIVEN
}

/** 이번 주행 잠정 way의 색 구분: 처음 달리는 길이면 밝은 앰버(굵게), 이미 달린 길을 다시 달리면 달린 길 색(바랜 길도 살아난다). */
fun liveStyle(isNew: Boolean): WayStyle = if (isNew) WayStyle.LIVE_NEW else WayStyle.DRIVEN

/** 서버 z에서 그리는 가장 낮은 등급 번호까지(계약서 3장: z<9 mw, z<11 +pr, z<13 +sc, 그 위 전부). */
fun maxVisibleCls(z: Int): Int = when {
    z < 9 -> CLS_MW
    z < 11 -> CLS_PR
    z < 13 -> CLS_SC
    else -> CLS_MN
}

/** 낮은 확대(전국·광역 보기)에서 안 간 길의 색. 선이 가늘어 어두운 바탕에서 안 보이므로 조금 밝게 한다. */
const val UNDRIVEN_FAR = 0xFF46566B.toInt()

/** 안 간 길 색을 밝게 바꾸는 확대 경계(이 값 미만에서 [UNDRIVEN_FAR]). */
const val FAR_ZOOM = 11.0

fun colorOf(style: WayStyle, zoom: Double = 14.0): Int = when (style) {
    WayStyle.UNDRIVEN -> if (zoom < FAR_ZOOM) UNDRIVEN_FAR else MapColors.UNDRIVEN
    WayStyle.DRIVEN -> MapColors.DRIVEN
    WayStyle.FADED -> MapColors.FADED
    WayStyle.LIVE_NEW -> MapColors.LIVE_NEW
}

/** 선 굵기(dp). 안 간 길은 가늘게, 달린 길은 조금 굵게, 잠정 새 길은 가장 굵게. 확대가 낮으면 줄인다. */
fun strokeDp(cls: Int, style: WayStyle, zoom: Double): Float {
    val base = when (cls) {
        CLS_MW -> 2.4f
        CLS_PR -> 2.0f
        CLS_SC -> 1.6f
        else -> 1.2f
    }
    val zoomScale = when {
        zoom < 8 -> 0.85f
        zoom < 11 -> 0.9f
        zoom < 14 -> 1.0f
        else -> 1.25f
    }
    return when (style) {
        WayStyle.UNDRIVEN -> base * zoomScale
        WayStyle.DRIVEN, WayStyle.FADED -> (base + 1.4f) * zoomScale
        WayStyle.LIVE_NEW -> 6.0f * zoomScale.coerceAtLeast(0.8f)
    }
}

/**
 * 시군구 칠 색(ARGB). 단계 1~3은 앰버 농도 3단계(통과·방문·숙박), 바랜 곳은 채도를 낮춘 색.
 * 안 간(0) 인구감소지역은 청록 바탕, 안 간 일반 지역은 칠하지 않는다(0).
 */
fun regionFill(level: Int, depop: Boolean, faded: Boolean): Int = when {
    level <= 0 -> if (depop) MapColors.DEPOP_BASE else 0
    else -> {
        val alpha = intArrayOf(0x38, 0x70, 0xA8)[level.coerceIn(1, 3) - 1]
        val rgb = if (faded) MapColors.FADED else MapColors.DRIVEN
        (alpha shl 24) or (rgb and 0xFFFFFF)
    }
}

/**
 * 지금 화면에 쓸 바탕 칸을 고른다. 현재 z의 칸이 [needed]에 다 있으면 그것만, 일부만 도착했으면 직전에 다 도착했던 묶음([previous])을 아래에 깔고 도착한 칸을 위에 둔다
 * (새 칸이 올 때까지 지도가 비지 않게). 반환: (그릴 칸 목록, 이번 묶음이 완전한지).
 */
fun selectCells(needed: List<CellKey>, loaded: Map<CellKey, BaseCell>, previous: List<BaseCell>): Pair<List<BaseCell>, Boolean> {
    val have = needed.mapNotNull { loaded[it] }
    val complete = have.size == needed.size
    return if (complete) have to true else (previous.filter { p -> have.none { it.key == p.key } } + have) to false
}

/** 시군구 칸들을 코드로 합친다(칸 경계에 걸친 시군구는 여러 칸에 들어 있다). 같은 코드는 먼저 나온 것을 쓴다. */
fun mergeRegions(cells: List<RegionCell>): List<RegionShape> {
    val byCode = LinkedHashMap<String, RegionShape>()
    for (c in cells) for (r in c.regions) byCode.putIfAbsent(r.code, r)
    return byCode.values.toList()
}
