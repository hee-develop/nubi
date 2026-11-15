package com.nubi.car.map

/** 그릴 때 쓰는 궤적 복사본. [starts]가 true인 점은 새 선분의 시작(앞 점과 잇지 않는다). */
class TrailSnapshot(val lons: DoubleArray, val lats: DoubleArray, val starts: BooleanArray)

/**
 * 이번 주행의 로컬 원시 궤적. 서버 잠정 결과를 기다리지 않고 지나온 길을 바로 그리려고 위치를 [minStepM]보다 멀어질 때만 쌓는다.
 * 엔진의 위치 콜백(서비스가 받는 위치)에서 쌓으므로 화면이 뒤에 있던 동안에도 끊기지 않고, 샘플 사이가 [breakGapMs] 넘게 비었거나
 * [breakDistM] 넘게 튀면 새 선분으로 시작해 빈 구간을 직선으로 잇지 않는다. 점이 [maxPoints]를 넘으면 오래된 것부터 버린다.
 * 메모리에만 두고 로그·디스크에 남기지 않는다(위치정보). 새 트립이 시작되거나 정산될 때 [clear]한다.
 */
class LocalTrail(
    private val minStepM: Double = 8.0,
    private val maxPoints: Int = 6_000,
    private val breakGapMs: Long = 30_000,
    private val breakDistM: Double = 800.0,
) {
    private val lons = ArrayList<Double>()
    private val lats = ArrayList<Double>()
    private val starts = ArrayList<Boolean>()
    private var lastSeenTs = Long.MIN_VALUE

    /** 마지막으로 정한 진행 방위(도, 북 0). 아직 모르면 null. */
    var bearing: Double? = null
        private set

    val size: Int get() = lons.size

    /** 점이 쌓이거나 비워질 때마다 올라간다(그림 캐시 판단용). */
    @Volatile
    var version = 0
        private set

    @Synchronized
    fun add(p: LonLat, tsMs: Long = 0L): Boolean {
        val gap = lastSeenTs != Long.MIN_VALUE && tsMs - lastSeenTs > breakGapMs
        lastSeenTs = tsMs
        val n = lons.size
        var start = n == 0
        if (n > 0) {
            val last = LonLat(lons[n - 1], lats[n - 1])
            val d = distanceM(last, p)
            if (d < minStepM && !gap) return false
            if (gap || d > breakDistM) {
                start = true
                bearing = null
            } else {
                bearing = bearingDeg(last, p)
            }
        }
        lons.add(p.lon)
        lats.add(p.lat)
        starts.add(start)
        if (lons.size > maxPoints) {
            lons.removeAt(0)
            lats.removeAt(0)
            starts.removeAt(0)
            if (starts.isNotEmpty()) starts[0] = true
        }
        version++
        return true
    }

    @Synchronized
    fun clear() {
        lons.clear()
        lats.clear()
        starts.clear()
        lastSeenTs = Long.MIN_VALUE
        bearing = null
        version++
    }

    /** 그릴 때 쓰는 복사본. */
    @Synchronized
    fun snapshot(): TrailSnapshot = TrailSnapshot(lons.toDoubleArray(), lats.toDoubleArray(), starts.toBooleanArray())
}
