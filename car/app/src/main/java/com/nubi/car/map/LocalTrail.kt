package com.nubi.car.map

/**
 * 이번 주행의 로컬 원시 궤적. 서버 잠정 결과를 기다리지 않고 지나온 길을 바로 그리려고 위치를 [minStepM]보다 멀어질 때만 쌓는다.
 * 점이 [maxPoints]를 넘으면 오래된 것부터 버린다. 메모리에만 두고 로그·디스크에 남기지 않는다(위치정보).
 */
class LocalTrail(private val minStepM: Double = 8.0, private val maxPoints: Int = 6_000) {
    private val lons = ArrayList<Double>()
    private val lats = ArrayList<Double>()

    /** 마지막으로 정한 진행 방위(도, 북 0). 아직 모르면 null. */
    var bearing: Double? = null
        private set

    val size: Int get() = lons.size

    @Synchronized
    fun add(p: LonLat): Boolean {
        val n = lons.size
        if (n > 0) {
            val last = LonLat(lons[n - 1], lats[n - 1])
            val d = distanceM(last, p)
            if (d < minStepM) return false
            bearing = bearingDeg(last, p)
        }
        lons.add(p.lon)
        lats.add(p.lat)
        if (lons.size > maxPoints) {
            lons.removeAt(0)
            lats.removeAt(0)
        }
        return true
    }

    @Synchronized
    fun clear() {
        lons.clear()
        lats.clear()
        bearing = null
    }

    /** 그릴 때 쓰는 복사본(경도 배열, 위도 배열). */
    @Synchronized
    fun snapshot(): Pair<DoubleArray, DoubleArray> = lons.toDoubleArray() to lats.toDoubleArray()
}
