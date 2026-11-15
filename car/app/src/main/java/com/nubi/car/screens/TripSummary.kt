package com.nubi.car.screens

import com.nubi.car.map.Bbox
import com.nubi.car.map.LocalTrail
import com.nubi.car.map.LonLat
import com.nubi.car.map.TrailSnapshot

/** 하차 요약 카드에 보일 내용. [bbox]·[trail]은 그 트립의 궤적 범위와 복사본(썸네일용)이고 궤적이 없으면 null. */
class SummaryData(val id: Int, val newKm: Double?, val regions: List<String>, val bbox: Bbox?, val trail: LocalTrail?)

/** 카드가 떠 있는 시간(30초). 그 전에 탭하면 닫힌다. */
const val SUMMARY_SHOW_MS = 30_000L

/** 궤적의 범위. 점이 없으면 null. 너무 작은 범위(정차 직전 몇 m)는 [minSpanDeg]까지 넓히고 [padRatio]만큼 여백을 둔다. */
fun tripBbox(snapshot: TrailSnapshot, minSpanDeg: Double = 0.004, padRatio: Double = 0.15): Bbox? {
    if (snapshot.lons.isEmpty()) return null
    var minLon = snapshot.lons.min()
    var maxLon = snapshot.lons.max()
    var minLat = snapshot.lats.min()
    var maxLat = snapshot.lats.max()
    if (maxLon - minLon < minSpanDeg) {
        val c = (minLon + maxLon) / 2
        minLon = c - minSpanDeg / 2
        maxLon = c + minSpanDeg / 2
    }
    if (maxLat - minLat < minSpanDeg) {
        val c = (minLat + maxLat) / 2
        minLat = c - minSpanDeg / 2
        maxLat = c + minSpanDeg / 2
    }
    val dx = (maxLon - minLon) * padRatio
    val dy = (maxLat - minLat) * padRatio
    return Bbox(minLon - dx, minLat - dy, maxLon + dx, maxLat + dy)
}

/** 궤적 복사본(트립이 정산되면 원본이 지워지므로 끝날 때 떠 둔다). 모든 점을 그대로 옮긴다. */
fun copyTrail(snapshot: TrailSnapshot): LocalTrail {
    val t = LocalTrail(minStepM = 0.0, maxPoints = 6_000)
    for (i in snapshot.lons.indices) t.add(LonLat(snapshot.lons[i], snapshot.lats[i]), 0L)
    return t
}

/**
 * 하차 요약 카드의 상태. 트립이 끝나면([onEnded]) 궤적 범위를 떠 두고, 정산이 끝나(결과가 새 도로 또는 새 시군구를 담으면, [onSettled]) 카드를 준비한다.
 * [current]가 null이 아닌 동안 카드를 보인다: 정산 뒤 [SUMMARY_SHOW_MS] 안이고 탭해서 닫지 않은 동안. 새 트립이 시작되면 지운다.
 */
class TripSummaryState(private val showMs: Long = SUMMARY_SHOW_MS) {
    private var endedBbox: Bbox? = null
    private var endedTrail: LocalTrail? = null
    private var data: SummaryData? = null
    private var readyAt = 0L
    private var dismissedId = -1
    private var seq = 0

    @Synchronized
    fun onEnded(bbox: Bbox?, trail: LocalTrail?) {
        endedBbox = bbox
        endedTrail = trail
    }

    /** 정산이 끝났다. 새 도로 거리([newKm], 집계되지 않았으면 null)와 처음 지난 시군구가 모두 없으면 카드를 만들지 않는다. */
    @Synchronized
    fun onSettled(newKm: Double?, regions: List<String>, nowElapsedMs: Long) {
        val hasKm = newKm != null && newKm.isFinite() && newKm >= 0.05
        if (endedBbox == null && endedTrail == null) return // 이번 실행에서 끝난 트립이 아니다(오프라인 백로그 정산 등)
        if (!hasKm && regions.isEmpty()) {
            endedBbox = null
            endedTrail = null
            return
        }
        data = SummaryData(++seq, newKm?.takeIf { hasKm }, regions, endedBbox, endedTrail)
        endedBbox = null
        endedTrail = null
        readyAt = nowElapsedMs
    }

    @Synchronized
    fun onTripStarted() {
        endedBbox = null
        endedTrail = null
        data = null
    }

    @Synchronized
    fun current(nowElapsedMs: Long): SummaryData? {
        val d = data ?: return null
        if (d.id == dismissedId) return null
        if (nowElapsedMs - readyAt >= showMs) return null
        return d
    }

    @Synchronized
    fun dismiss() {
        data?.let { dismissedId = it.id }
    }
}
