package com.nubi.car.map

import com.nubi.car.BuildConfig
import com.nubi.car.FeatureFlags
import com.nubi.car.trip.LatLon

/**
 * 지도 화면의 상태를 묶는 컨트롤러. 화면(Activity)이 1초마다 [update]를 부르고, 지도 뷰 둘(주행·정차)은 같은 저장소·궤적을 공유한다.
 * 위치 궤적·잠정 폴링·따라가기는 여기서 정하고, 그리기는 [NubiMapView]가 한다.
 */
class MapScreen(
    val repository: MapRepository,
    private val live: LivePoller,
    val trail: LocalTrail = LocalTrail(),
) {
    private var driving: NubiMapView? = null
    private var parked: NubiMapView? = null
    private var mode = MapMode.OFF
    private var wasRecording = false
    private var parkedFollow = true
    private var lastDescription: String? = null

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
            it.minRedrawMs = DRIVING_REDRAW_MS
            it.nowMs = nowMs
        }
        parked = parkedView.also {
            it.repository = repository
            it.trail = trail
            it.nowMs = nowMs
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
        if (recording && !wasRecording) {
            // 새 주행: 지난 궤적과 잠정 결과를 비운다
            trail.clear()
            live.clear()
        }
        wasRecording = recording
        val me = loc?.let { LonLat(it.lon, it.lat) }
        if (recording && me != null) trail.add(me)
        if (recording && FeatureFlags.liveColoring) live.start() else live.stop()

        val bearing = trail.bearing
        for (v in listOfNotNull(driving, parked)) {
            v.myLocation = me
            v.myBearing = bearing
        }
        when (newMode) {
            MapMode.DRIVING -> driving?.let { v ->
                if (me != null) followTo(v, me, FOLLOW_ZOOM) else v.requestRedraw()
            }
            MapMode.PARKED -> parked?.let { v ->
                v.interactive = interactive
                if (previous != MapMode.PARKED) parkedFollow = true // 정차로 들어오면 내 위치에서 시작
                if (parkedFollow && me != null) followTo(v, me, if (previous != MapMode.PARKED) FOLLOW_ZOOM else null) else v.requestRedraw()
            }
            MapMode.OFF -> Unit
        }
        if (BuildConfig.DEBUG) describe()
    }

    private fun followTo(v: NubiMapView, me: LonLat, zoom: Double?) {
        val vp = v.viewport
        if (vp.widthPx <= 1) return
        val sameCenter = kotlin.math.abs(vp.centerLon - me.lon) < 1e-6 && kotlin.math.abs(vp.centerLat - me.lat) < 1e-6
        if (sameCenter && (zoom == null || vp.zoom == zoom)) {
            v.requestRedraw()
            return
        }
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

    /** 트립 종료 매칭이 끝났다: 잠정 결과를 치우고 확정된 달린 길·시군구 단계를 다시 받는다. */
    fun onTripSettled() {
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
