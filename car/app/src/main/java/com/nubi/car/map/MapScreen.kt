package com.nubi.car.map

import com.nubi.car.BuildConfig
import com.nubi.car.FeatureFlags
import com.nubi.car.trip.LatLon
import kotlin.math.abs

/**
 * 지도 화면의 상태를 묶는 컨트롤러. 화면(Activity)이 1초마다 [update]를 부르고, 지도 뷰 둘(주행·정차)은 같은 저장소·궤적을 공유한다.
 * 로컬 궤적은 화면이 아니라 엔진의 위치 콜백([onLocationSample])에서 쌓고, 잠정 폴링·따라가기는 여기서 정하고, 그리기는 [NubiMapView]가 한다.
 */
class MapScreen(
    val repository: MapRepository,
    private val live: LivePoller,
    val trail: LocalTrail = LocalTrail(),
) {
    private var driving: NubiMapView? = null
    private var parked: NubiMapView? = null
    private var mode = MapMode.OFF
    private var parkedFollow = true
    private var lastDescription: String? = null
    private var shownBearing: Double? = null

    /** 정차 지도 도로·시군구 레이어 토글 상태(화면을 다시 만들어도 유지). */
    var roadsOn = true
        private set
    var regionsOn = true
        private set

    init {
        repository.onChange = { redraw() }
        live.onChange = { redraw() }
    }

    private fun redraw() {
        driving?.requestRedraw()
        parked?.requestRedraw()
    }

    fun bind(drivingView: NubiMapView, parkedView: NubiMapView, nowMs: () -> Long) {
        driving = drivingView.also {
            it.repository = repository
            it.trail = trail
            it.interactive = false
            it.emphasizeNew = false // 주행 중에는 처음 달린 길도 달린 길과 같은 색·굵기(강조는 정차 화면에서만)
            it.minRedrawMs = DRIVING_REDRAW_MS
            it.nowMs = nowMs
        }
        parked = parkedView.also {
            it.repository = repository
            it.trail = trail
            it.nowMs = nowMs
            it.emphasizeNew = true
            it.showRoads = roadsOn
            it.showRegions = regionsOn
            it.onUserMoved = { parkedFollow = false }
        }
    }

    fun unbind() {
        driving = null
        parked = null
        live.stop()
    }

    /** 엔진이 위치 샘플을 처리할 때마다(화면과 무관). 기록 중일 때만 궤적에 쌓는다. */
    fun onLocationSample(lat: Double, lon: Double, tsMillis: Long, recording: Boolean) {
        if (recording) trail.add(LonLat(lon, lat), tsMillis)
    }

    /** 새 트립이 시작됐다: 지난 궤적과 잠정 결과를 비운다. */
    fun onTripStarted() {
        trail.clear()
        live.clear()
    }

    /**
     * 1초마다. [recording]은 트립 기록 중(상태기계 RECORDING)인지, [loc]는 마지막 원시 위치, [interactive]는 정차 지도를 만져도 되는지.
     */
    fun update(newMode: MapMode, recording: Boolean, loc: LatLon?, interactive: Boolean) {
        val previous = mode
        mode = newMode
        if (newMode == MapMode.OFF) {
            live.stop()
            return
        }
        val me = loc?.let { LonLat(it.lon, it.lat) }
        if (recording && FeatureFlags.liveColoring) live.start() else live.stop()

        // 마커 방위는 15° 이상 바뀔 때만 돌린다(작은 흔들림으로 계속 다시 그리지 않는다)
        val bearing = trail.bearing
        if (bearing == null) {
            shownBearing = null
        } else if (shownBearing == null || bearingDiff(shownBearing!!, bearing) >= BEARING_STEP_DEG) {
            shownBearing = bearing
        }
        for (v in listOfNotNull(driving, parked)) {
            v.myLocation = me
            v.myBearing = shownBearing
        }
        when (newMode) {
            MapMode.DRIVING -> driving?.let { v -> if (me != null) followTo(v, me, FOLLOW_ZOOM) }
            MapMode.PARKED -> parked?.let { v ->
                v.interactive = interactive
                if (previous != MapMode.PARKED) parkedFollow = true // 정차로 들어오면 내 위치에서 시작
                if (parkedFollow && me != null) followTo(v, me, if (previous != MapMode.PARKED) FOLLOW_ZOOM else null)
            }
            MapMode.OFF -> Unit
        }
        if (BuildConfig.DEBUG) describe()
    }

    /** 내 위치로 지도를 옮긴다. 화면 중심에서 [FOLLOW_MIN_MOVE_DP]보다 덜 움직였고 확대도 그대로면 다시 그리지 않는다(데이터가 바뀌면 따로 그린다). */
    private fun followTo(v: NubiMapView, me: LonLat, zoom: Double?) {
        val vp = v.viewport
        if (vp.widthPx <= 1) return
        val density = v.resources.displayMetrics.density
        val moved = abs(vp.screenX(me.lon) - vp.widthPx / 2.0) + abs(vp.screenY(me.lat) - vp.heightPx / 2.0)
        val sameZoom = zoom == null || vp.zoom == zoom
        if (sameZoom && moved < FOLLOW_MIN_MOVE_DP * density) return
        v.centerOn(me.lon, me.lat, zoom)
    }

    /** debug 빌드에서만: Maestro가 읽을 요약을 지도 뷰의 contentDescription에 넣는다. */
    private fun describe() {
        val v = (if (mode == MapMode.PARKED) parked else driving) ?: return
        val snap = v.lastSnapshot ?: return
        val text = debugSummary(snap, trail.size, v.showRoads, v.showRegions, v.viewport.zoom, mode == MapMode.DRIVING || parkedFollow)
        if (text != lastDescription) {
            lastDescription = text
            v.contentDescription = text
        }
    }

    // 정차 지도 버튼 --------------------------------------------------------------

    fun zoomIn() = parked?.zoomIn()

    fun zoomOut() = parked?.zoomOut()

    fun showNational() {
        parkedFollow = false
        parked?.showNational()
    }

    fun myLocation(loc: LatLon?) {
        parkedFollow = true
        val v = parked ?: return
        if (loc != null) v.centerOn(loc.lon, loc.lat, FOLLOW_ZOOM)
    }

    fun toggleRoads(): Boolean {
        roadsOn = !roadsOn
        parked?.showRoads = roadsOn
        return roadsOn
    }

    fun toggleRegions(): Boolean {
        regionsOn = !regionsOn
        parked?.showRegions = regionsOn
        return regionsOn
    }

    /** 트립 종료 매칭이 끝났다: 궤적·잠정 결과를 치우고 확정된 달린 길·시군구 단계를 다시 받는다. */
    fun onTripSettled() {
        trail.clear()
        live.clear()
        repository.invalidate()
    }

    /** 방금 시작한 설명 갱신을 강제한다(레이어 토글 뒤 바로 반영). */
    fun refreshDescription() {
        lastDescription = null
        if (BuildConfig.DEBUG) describe()
    }

    private companion object {
        const val DRIVING_REDRAW_MS = 1_000L
    }
}
