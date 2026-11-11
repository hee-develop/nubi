package com.nubi.car.map

import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sinh
import kotlin.math.tan

/** Web Mercator 한 타일의 픽셀 크기. 화면 픽셀 = 정규화 좌표(0~1) × 256 × 2^zoom. */
const val TILE_PX = 256.0
const val MAX_LAT = 85.0511

data class LonLat(val lon: Double, val lat: Double)

data class Bbox(val minLon: Double, val minLat: Double, val maxLon: Double, val maxLat: Double) {
    val width: Double get() = maxLon - minLon
    val height: Double get() = maxLat - minLat

    fun intersects(o: Bbox): Boolean = minLon <= o.maxLon && maxLon >= o.minLon && minLat <= o.maxLat && maxLat >= o.minLat

    fun expand(ratio: Double): Bbox {
        val dx = width * ratio
        val dy = height * ratio
        return Bbox(minLon - dx, minLat - dy, maxLon + dx, maxLat + dy)
    }
}

/** 경도 → 정규화 x(0~1). */
fun mercX(lon: Double): Double = (lon + 180.0) / 360.0

/** 위도 → 정규화 y(0~1, 북쪽이 0). */
fun mercY(lat: Double): Double {
    val clamped = lat.coerceIn(-MAX_LAT, MAX_LAT)
    return 0.5 - ln(tan(PI / 4 + Math.toRadians(clamped) / 2)) / (2 * PI)
}

fun lonOfX(x: Double): Double = x * 360.0 - 180.0

fun latOfY(y: Double): Double = Math.toDegrees(atan(sinh((0.5 - y) * 2 * PI)))

/**
 * 지도 화면 하나의 보기: 중심·확대(실수 zoom)·화면 크기. 북쪽이 항상 위다(회전 없음). 불변이라 스레드 사이에 그대로 넘겨도 된다.
 * 화면 좌표는 왼쪽 위가 (0,0), 단위는 픽셀이다.
 */
class Viewport(val centerLon: Double, val centerLat: Double, val zoom: Double, val widthPx: Int, val heightPx: Int) {
    private val scale = TILE_PX * 2.0.pow(zoom)
    private val cx = mercX(centerLon) * scale
    private val cy = mercY(centerLat) * scale

    fun screenX(lon: Double): Double = mercX(lon) * scale - cx + widthPx / 2.0

    fun screenY(lat: Double): Double = mercY(lat) * scale - cy + heightPx / 2.0

    fun lonAt(sx: Double): Double = lonOfX((sx - widthPx / 2.0 + cx) / scale)

    fun latAt(sy: Double): Double = latOfY((sy - heightPx / 2.0 + cy) / scale)

    /** 화면이 덮는 정규화 Mercator 범위 (x0, y0, x1, y1). y0이 위(북쪽). */
    fun mercBounds(): DoubleArray = doubleArrayOf((cx - widthPx / 2.0) / scale, (cy - heightPx / 2.0) / scale, (cx + widthPx / 2.0) / scale, (cy + heightPx / 2.0) / scale)

    /** 정규화 Mercator x → 화면 x. */
    fun sx(mx: Double): Double = mx * scale - cx + widthPx / 2.0

    /** 정규화 Mercator y → 화면 y. */
    fun sy(my: Double): Double = my * scale - cy + heightPx / 2.0

    fun bbox(): Bbox = Bbox(lonAt(0.0), latAt(heightPx.toDouble()), lonAt(widthPx.toDouble()), latAt(0.0))

    fun withCenter(lon: Double, lat: Double): Viewport = Viewport(lon, lat.coerceIn(-MAX_LAT, MAX_LAT), zoom, widthPx, heightPx)

    fun withZoom(z: Double): Viewport = Viewport(centerLon, centerLat, z.coerceIn(MIN_ZOOM, MAX_ZOOM), widthPx, heightPx)

    fun withSize(w: Int, h: Int): Viewport = Viewport(centerLon, centerLat, zoom, w, h)

    /** 화면을 [dx],[dy] 픽셀 끌었다(손가락이 움직인 방향). 지도는 그 방향으로 따라온다. */
    fun panBy(dx: Double, dy: Double): Viewport = withCenter(lonAt(widthPx / 2.0 - dx), latAt(heightPx / 2.0 - dy))

    /** 확대를 [dZoom]만큼 바꾸되 화면의 ([fx],[fy]) 아래 지점이 그대로 있게 한다. */
    fun zoomBy(dZoom: Double, fx: Double = widthPx / 2.0, fy: Double = heightPx / 2.0): Viewport {
        val newZoom = (zoom + dZoom).coerceIn(MIN_ZOOM, MAX_ZOOM)
        val lon = lonAt(fx)
        val lat = latAt(fy)
        val next = Viewport(centerLon, centerLat, newZoom, widthPx, heightPx)
        // 새 확대에서 (lon,lat)이 (fx,fy)에 오도록 중심을 옮긴다.
        val dx = next.screenX(lon) - fx
        val dy = next.screenY(lat) - fy
        return next.panBy(-dx, -dy)
    }

    companion object {
        const val MIN_ZOOM = 5.0
        const val MAX_ZOOM = 17.5

        /** [box]가 [padPx] 여백을 두고 화면에 다 들어오는 보기. */
        fun fit(box: Bbox, widthPx: Int, heightPx: Int, padPx: Int = 0): Viewport {
            val w = max(1.0, (widthPx - 2.0 * padPx))
            val h = max(1.0, (heightPx - 2.0 * padPx))
            val dx = max(1e-9, mercX(box.maxLon) - mercX(box.minLon))
            val dy = max(1e-9, mercY(box.minLat) - mercY(box.maxLat))
            val z = min(ln(w / (TILE_PX * dx)), ln(h / (TILE_PX * dy))) / ln(2.0)
            return Viewport((box.minLon + box.maxLon) / 2, latOfY((mercY(box.minLat) + mercY(box.maxLat)) / 2), z.coerceIn(MIN_ZOOM, MAX_ZOOM), widthPx, heightPx)
        }
    }
}

/** 전국 보기에 쓰는 경계(제주·울릉·독도 포함). */
val NATIONAL_BBOX = Bbox(124.5, 33.0, 131.9, 38.7)

/** 주행 중 따라가기·정차 기본 확대. */
const val FOLLOW_ZOOM = 14.0

/** 서버 `/map/base`에 보내는 정수 z: 화면 확대를 내림해 5~16으로 맞춘다(그보다 확대돼도 z16 도형을 늘려 그린다). */
fun serverZ(zoom: Double): Int = floor(zoom + 1e-6).toInt().coerceIn(5, 16)

/** 서버 요청 한 칸(고정 격자) 한 변(도). 서버의 z별 bbox 상한(6°·2°·0.5°·0.15°)의 절반 이하다. */
fun cellSizeDeg(z: Int): Double = when {
    z < 9 -> 3.0
    z < 11 -> 1.0
    z < 13 -> 0.25
    else -> 0.075
}

/** 바탕 도로 캐시 칸: 서버 z와 격자 번호. */
data class CellKey(val z: Int, val ix: Int, val iy: Int) {
    fun bbox(): Bbox {
        val s = cellSizeDeg(z)
        return Bbox(ix * s, iy * s, (ix + 1) * s, (iy + 1) * s)
    }
}

/** [box]를 덮는 칸 목록(서쪽→동쪽, 남쪽→북쪽). 화면이 너무 넓어 [maxCells]를 넘으면 중심에 가까운 칸부터 [maxCells]개만 돌려준다. */
fun cellsCovering(box: Bbox, z: Int, maxCells: Int = 60): List<CellKey> {
    val s = cellSizeDeg(z)
    val x0 = floor(box.minLon / s).toInt()
    val x1 = floor(box.maxLon / s).toInt()
    val y0 = floor(box.minLat / s).toInt()
    val y1 = floor(box.maxLat / s).toInt()
    val all = ArrayList<CellKey>()
    for (iy in y0..y1) for (ix in x0..x1) all.add(CellKey(z, ix, iy))
    if (all.size <= maxCells) return all
    val cx = (box.minLon + box.maxLon) / 2 / s
    val cy = (box.minLat + box.maxLat) / 2 / s
    return all.sortedBy { (it.ix + 0.5 - cx).let { d -> d * d } + (it.iy + 0.5 - cy).let { d -> d * d } }.take(maxCells)
}

/**
 * 서버에 요청할 칸 목록. **화면이 덮는 칸([screen]의 [cellsCovering])을 먼저** 넣고(화면 중앙에 가까운 순), 남는 자리([maxCells])에 여유 영역([expanded])의 나머지 칸을 중앙에 가까운 순으로 채운다.
 * 여유 영역만 중심 거리로 자르면 화면 모서리 칸이 빠져 '불러오는 중'이 끝나지 않는다.
 */
fun requestCells(screen: Bbox, expanded: Bbox, z: Int, maxCells: Int = 30): List<CellKey> {
    fun center(b: Bbox) = doubleArrayOf((b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2)
    val c = center(expanded)
    fun dist(k: CellKey) = k.bbox().let { b -> val m = center(b); (m[0] - c[0]).let { d -> d * d } + (m[1] - c[1]).let { d -> d * d } }
    val first = cellsCovering(screen, z, maxCells).sortedBy(::dist)
    if (first.size >= maxCells) return first
    val seen = first.toHashSet()
    val rest = cellsCovering(expanded, z, Int.MAX_VALUE).filter { it !in seen }.sortedBy(::dist)
    return first + rest.take(maxCells - first.size)
}

/** 시군구 칠 요청 칸(서버 z는 [regionZ], 격자는 확대가 낮으면 크게). 응답에는 칸 경계에 걸친 시군구가 통째로 들어와 칸끼리 겹치므로 코드로 합친다. */
fun regionZ(zoom: Double): Int = floor(zoom + 1e-6).toInt().coerceIn(5, 13)

fun regionCellSizeDeg(z: Int): Double = if (z < 8) 16.0 else if (z < 10) 2.0 else 0.5

data class RegionCellKey(val z: Int, val ix: Int, val iy: Int) {
    fun bbox(): Bbox {
        val s = regionCellSizeDeg(z)
        return Bbox(ix * s, iy * s, (ix + 1) * s, (iy + 1) * s)
    }
}

fun regionCellsCovering(box: Bbox, z: Int): List<RegionCellKey> {
    val s = regionCellSizeDeg(z)
    val out = ArrayList<RegionCellKey>()
    for (iy in floor(box.minLat / s).toInt()..floor(box.maxLat / s).toInt()) {
        for (ix in floor(box.minLon / s).toInt()..floor(box.maxLon / s).toInt()) out.add(RegionCellKey(z, ix, iy))
    }
    return out
}

/** 두 점 사이 방위(도, 북 0 시계방향). */
fun bearingDeg(a: LonLat, b: LonLat): Double {
    val dy = Math.toRadians(b.lat - a.lat)
    val dx = Math.toRadians(b.lon - a.lon) * kotlin.math.cos(Math.toRadians((a.lat + b.lat) / 2))
    val deg = Math.toDegrees(kotlin.math.atan2(dx, dy))
    return (deg + 360.0) % 360.0
}

/** 지표면 거리(m, 하버사인). */
fun distanceM(a: LonLat, b: LonLat): Double {
    val r = 6_371_008.8
    val dLat = Math.toRadians(b.lat - a.lat)
    val dLon = Math.toRadians(b.lon - a.lon)
    val h = Math.sin(dLat / 2).pow(2) + Math.cos(Math.toRadians(a.lat)) * Math.cos(Math.toRadians(b.lat)) * Math.sin(dLon / 2).pow(2)
    return 2 * r * Math.asin(min(1.0, kotlin.math.sqrt(h)))
}
