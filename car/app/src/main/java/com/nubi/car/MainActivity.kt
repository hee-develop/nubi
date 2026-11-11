package com.nubi.car

import android.app.Activity
import android.car.Car
import android.car.drivingstate.CarUxRestrictions
import android.car.drivingstate.CarUxRestrictionsManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.Log
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import com.nubi.car.map.MapMode
import com.nubi.car.map.MapScreen
import com.nubi.car.map.currentRegionName
import com.nubi.car.map.drivingRegionText
import com.nubi.car.map.mapInteractive
import com.nubi.car.map.mapMode
import com.nubi.car.trip.CoverageTracker
import com.nubi.car.trip.Gear
import com.nubi.car.trip.MatchingLine
import com.nubi.car.trip.Neighbor
import com.nubi.car.trip.PlaceTracker
import com.nubi.car.trip.RecorderHealth
import com.nubi.car.trip.TripEngine
import com.nubi.car.trip.TripEngineProvider
import com.nubi.car.trip.TripState
import com.nubi.car.trip.TripStatus
import com.nubi.car.trip.UploadKind
import com.nubi.car.trip.extrasVisible
import com.nubi.car.trip.foldLines
import com.nubi.car.trip.formatNationalCountedLine
import com.nubi.car.trip.formatNewRegions
import com.nubi.car.trip.formatRegionEvent
import com.nubi.car.trip.formatRegionsDepop
import com.nubi.car.trip.formatRegionsDex
import com.nubi.car.trip.formatRoadLine
import com.nubi.car.trip.limitText
import com.nubi.car.trip.NeighborLayout
import com.nubi.car.trip.narrowAppArea
import com.nubi.car.trip.neighborLayout
import com.nubi.car.trip.neighborLayoutInMap
import com.nubi.car.trip.PANEL_TEXT_SCALE
import com.nubi.car.trip.numbersVisible
import com.nubi.car.trip.parseAccent
import com.nubi.car.trip.stageDots
import com.nubi.car.trip.usesParkedLayout

/**
 * 시안 03(정차 P)·03b(주행 중) 화면. 1초마다 한 번만 갱신한다. 뷰는 res/layout(view_driving·view_parked)에 있다.
 * 숫자와 지역 카드는 기어 P일 때만 보이고(numbersVisible), 주행 규제(DO)가 걸리면 버튼·카드·QR을 숨기고 문자열을 규제 길이로 자른다.
 */
class MainActivity : Activity() {
    private lateinit var engine: TripEngine
    private lateinit var coverage: CoverageTracker
    private lateinit var place: PlaceTracker
    private lateinit var navi: NaviLauncher
    private lateinit var map: MapScreen
    private lateinit var v: Views
    private val handler = Handler(Looper.getMainLooper())

    private var car: Car? = null
    private var uxManager: CarUxRestrictionsManager? = null

    /**
     * DO가 요구되는 동안 true. 이때 권한 카드·버튼은 숨기고 문자열은 [maxStringLength]로 자른다.
     * 규제 서비스에 등록하지 못하면 실제 값을 알 수 없으므로 fail-closed로 true를 유지한다(등록에 성공하면 실제 값으로 갱신).
     */
    private var distractionOptimized = true
    private var maxStringLength = 0

    /** 요청 뒤에도 거부됐고 시스템이 더는 묻지 않는 상태(영구 거부). 이때 '설정 열기'를 보인다. */
    private var permanentlyDenied = false

    /** 길안내 요청 결과 한 줄(팝업·토스트 대신 카드 아래에 보인다). 이웃이 바뀌면 지운다. */
    private var naviMessage: String? = null
    private var naviMessageFor: String? = null

    /** 이번 렌더에서 카드에 보인 이웃(길안내 대상). 카드가 안 보이면 null. */
    private var shownNeighbor: Neighbor? = null

    /** 마지막으로 적용한 앱 영역 모드(좁음 여부)와 정차 지도 사용 여부. 아직 적용 전이면 null. */
    private var appliedNarrow: Boolean? = null
    private var appliedMap: Boolean? = null

    /** 패널 글자 크기를 줄여 둔 상태인지와, 줄이기 전 글자 크기(px)를 기억해 둔 뷰들. */
    private var panelScaled = false
    private val originalTextSizes = HashMap<TextView, Float>()

    private val uxListener = CarUxRestrictionsManager.OnUxRestrictionsChangedListener { restrictions ->
        handler.post {
            applyRestrictions(restrictions)
            render()
        }
    }

    private val refresh = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        engine = TripEngineProvider.get(this)
        coverage = TripEngineProvider.coverage(this)
        place = TripEngineProvider.place(this)
        map = TripEngineProvider.map(this)
        navi = NaviLauncher(this)
        setContentView(R.layout.activity_main)
        v = Views(findViewById(R.id.root))
        v.restartButton.setOnClickListener { startService() }
        v.permissionConfirm.setOnClickListener { requestPermissions() }
        v.permissionSettings.setOnClickListener { openAppSettings() }
        v.naviSight.setOnClickListener { navigate() }
        v.naviFestival.setOnClickListener { navigate() }
        v.naviCompact.setOnClickListener { navigate() }
        // 정차 지도 버튼. 주행 규제(DO)·정차 아님이면 버튼이 안 보이지만 한 번 더 막는다(fail-closed).
        v.mapBtnZoomIn.setOnClickListener { if (mapTouchAllowed()) map.zoomIn() }
        v.mapBtnZoomOut.setOnClickListener { if (mapTouchAllowed()) map.zoomOut() }
        v.mapBtnMe.setOnClickListener { if (mapTouchAllowed()) map.myLocation(engine.status.lastLocation) }
        v.mapBtnNational.setOnClickListener { if (mapTouchAllowed()) map.showNational() }
        v.mapBtnRoads.setOnClickListener {
            if (mapTouchAllowed()) {
                map.toggleRoads()
                map.refreshDescription()
                render()
            }
        }
        v.mapBtnRegions.setOnClickListener {
            if (mapTouchAllowed()) {
                map.toggleRegions()
                map.refreshDescription()
                render()
            }
        }
    }

    /** 지도 터치·버튼을 받아도 되는 상태인지(정차 지도 + DO 아님). */
    private fun mapTouchAllowed(): Boolean = lastMapMode == MapMode.PARKED && mapInteractive(lastMapMode, distractionOptimized)

    private var lastMapMode = MapMode.OFF

    override fun onResume() {
        super.onResume()
        registerUxRestrictions()
        map.bind(v.mapDriving, v.mapParked) { engine.nowMillis() }
        if (hasLocationPermission()) startService()
        render()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        map.unbind()
        unregisterUxRestrictions()
        navi.release()
        super.onPause()
    }

    /** 최상위 화면에서 Back은 앱을 닫지 않고 뒤로 보낸다(포그라운드 서비스는 계속 돈다). */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        moveTaskToBack(true)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CODE) return
        if (hasLocationPermission()) {
            permanentlyDenied = false
            startService()
        } else {
            // 시스템 다이얼로그가 안 뜨고 거부됐고 설명 UI도 안 보여 주는 상태면 영구 거부로 본다.
            permanentlyDenied = REQUIRED.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                .none { shouldShowRequestPermissionRationale(it) }
        }
        render()
    }

    private fun hasLocationPermission() = REQUIRED.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun startService() {
        try {
            TripRecordingService.start(this)
        } catch (e: Exception) {
            Log.w("NubiMain", "서비스 시작 실패: ${e.message}")
        }
    }

    private fun requestPermissions() {
        val wanted = REQUIRED.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        requestPermissions(wanted.toTypedArray(), REQUEST_CODE)
    }

    private fun openAppSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            Log.w("NubiMain", "설정 화면 열기 실패: ${e.message}")
        }
    }

    // 주행 규제 ---------------------------------------------------------------

    private fun registerUxRestrictions() {
        // 등록이 끝나 실제 값을 받을 때까지는 제한된 것으로 본다.
        distractionOptimized = true
        try {
            val c = Car.createCar(this) ?: return failClosed("Car 없음")
            car = c
            val manager = c.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as? CarUxRestrictionsManager ?: return failClosed("규제 서비스 없음")
            uxManager = manager
            manager.registerListener(uxListener)
            val current = manager.currentCarUxRestrictions
            if (current != null) applyRestrictions(current) else failClosed("현재 규제 값 없음")
        } catch (e: Throwable) {
            failClosed("${e.javaClass.simpleName} ${e.message}")
        }
    }

    private fun failClosed(reason: String) {
        distractionOptimized = true
        Log.w("NubiMain", "주행 규제 등록 실패, DO로 간주: $reason")
    }

    private fun unregisterUxRestrictions() {
        try {
            uxManager?.unregisterListener()
            car?.disconnect()
        } catch (e: Throwable) {
            Log.w("NubiMain", "주행 규제 해제 실패: ${e.javaClass.simpleName} ${e.message}")
        }
        uxManager = null
        car = null
    }

    private fun applyRestrictions(r: CarUxRestrictions) {
        distractionOptimized = r.isRequiresDistractionOptimization
        maxStringLength = r.maxRestrictedStringLength
    }

    /** 상태 문구: DO 중 규제 길이를 넘으면 자른다(항상 보여야 한다). */
    private fun limited(text: String): String = limitText(text, distractionOptimized, maxStringLength, statusLine = true)!!

    /** 숫자·이름 줄: 규제 길이를 넘으면 중간에서 자르지 않고 줄을 숨긴다. [marked]는 `{…}` 강조 표시가 든 문구이고 null이어도 숨긴다. */
    private fun setLine(view: TextView, marked: String?) {
        val accent = marked?.let(::parseAccent)
        val t = accent?.let { limitText(it.text, distractionOptimized, maxStringLength, statusLine = false) }
        if (accent == null || t == null) {
            view.visibility = View.GONE
            view.text = ""
            return
        }
        view.visibility = View.VISIBLE
        view.text = if (accent.hasAccent) {
            SpannableString(t).apply {
                setSpan(ForegroundColorSpan(getColor(R.color.accent)), accent.accentStart, accent.accentEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        } else {
            t
        }
    }

    /**
     * 높이가 모자라면(두 앱을 나란히 연 좁은 영역 등) 낮은 순위 줄부터 접는다. 순위: 상태(건강·저장·업로드) > 새 도로 > 시군구 > 인구감소지역 > 처음 지난 곳 > 이벤트 > 전국 > 샘플 > (거리) > 게스트 QR.
     * 이미 보이기로 정한 줄만 대상이다. 화면 크기가 아직 정해지지 않았으면(0) 아무것도 접지 않는다.
     */
    private fun foldToFit() {
        val column = v.leftColumn
        val width = column.width
        val available = column.height
        if (width <= 0 || available <= 0) return
        fun measure(): Int {
            column.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            return column.measuredHeight
        }
        // 샘플·거리는 한 줄에 놓이므로 높이는 샘플 쪽에만 센다.
        val ordered = listOf(v.healthText, v.storageText, v.uploadText, v.roadText, v.regionsText, v.depopText, v.newRegionsText, v.eventText, v.nationalText, v.samplesText, v.distanceText, v.guestCard)
        val total = measure()
        val heights = ordered.map { if (it.visibility == View.VISIBLE && it !== v.distanceText) it.measuredHeight else 0 }
        val fixed = total - heights.sum()
        val show = foldLines(heights, available - fixed, pinned = 3)
        ordered.forEachIndexed { i, view -> if (!show[i] && view !== v.distanceText && view.visibility == View.VISIBLE) view.visibility = View.GONE }
        // 거리는 샘플과 함께 접는다
        if (v.samplesText.visibility != View.VISIBLE) v.distanceText.visibility = View.GONE
    }

    // 그리기 ------------------------------------------------------------------

    private fun render() {
        val needsPermission = !hasLocationPermission()
        val s = engine.status
        // 숫자(완료율·새 도로·샘플·거리)와 지역 카드는 기어가 P일 때만 보인다(사양 02 7장). 기어를 못 읽는 차량은 기록 중이 아닐 때만. 상태 문구와 마지막 업로드 결과는 항상 보인다.
        val showNumbers = numbersVisible(s.gear, s.state)
        val parked = usesParkedLayout(showNumbers, distractionOptimized, needsPermission, s.health == RecorderHealth.SERVICE_FAILED)
        v.drivingView.visibility = if (parked) View.GONE else View.VISIBLE
        v.parkedView.visibility = if (parked) View.VISIBLE else View.GONE
        val mode = mapMode(FeatureFlags.drivingMap, parked)
        lastMapMode = mode
        v.drivingMap.visibility = if (mode == MapMode.DRIVING) View.VISIBLE else View.GONE
        v.drivingLegacy.visibility = if (mode == MapMode.DRIVING) View.GONE else View.VISIBLE

        val state = limited(
            when {
                needsPermission -> getString(R.string.state_permission)
                s.loading -> getString(R.string.state_loading)
                s.state == TripState.IDLE -> getString(R.string.state_idle)
                s.state == TripState.RECORDING -> getString(R.string.state_recording)
                else -> getString(R.string.state_ended)
            },
        )
        val healthMessage = when (s.health) {
            RecorderHealth.SERVICE_FAILED -> getString(R.string.health_service_failed)
            RecorderHealth.UNSUPPORTED -> getString(R.string.health_unsupported)
            RecorderHealth.OK -> null
        }
        val health = healthMessage?.let(::limited)
        val storage = listOfNotNull(
            if (s.storageHeld) getString(R.string.storage_held_key_error) else null,
            if (s.saveFailures > 0) getString(R.string.storage_save_failed, s.saveFailures) else null,
            if (s.corruptLines > 0) getString(R.string.storage_corrupt, s.corruptLines) else null,
            if (s.discardedLines > 0) getString(R.string.storage_discarded, s.discardedLines) else null,
        ).takeIf { it.isNotEmpty() }?.joinToString(" · ")?.let(::limited)
        val upload = when (s.upload.kind) {
            UploadKind.NONE -> getString(R.string.upload_none)
            UploadKind.OK -> getString(R.string.upload_ok, s.upload.points)
            UploadKind.END_SENT -> getString(R.string.upload_end_sent)
            UploadKind.FAILED -> getString(R.string.upload_failed)
            UploadKind.HELD -> getString(R.string.upload_held)
        }
        // 보류는 사용자가 알아야 하므로 '마지막 업로드:' 접두 없이 그대로 보인다.
        val uploadLine = limited(
            when {
                // 서버 주소가 빌드 때 지정되지 않았으면 업로드가 어차피 되지 않으므로 그 사실을 먼저 알린다.
                BuildConfig.SERVER_URL_IS_PLACEHOLDER -> getString(R.string.server_not_configured)
                s.upload.kind == UploadKind.HELD -> upload
                else -> getString(R.string.upload_format, upload)
            },
        )
        val canAct = !distractionOptimized

        // 주행 중(03b): 로고 마크, 상태 문구, 보조 문구. 숫자·카드·버튼·QR 없음
        v.drivingState.text = state
        setStatus(v.drivingHealth, health)
        setStatus(v.drivingStorage, storage)
        v.drivingUpload.text = uploadLine

        // 주행 중 지도: 위 한 줄(기록 중 · 지금 시군구)만. 문제가 있을 때만 상태 이상 문구를 덧붙인다. 숫자·버튼·카드·QR 없음
        if (mode == MapMode.DRIVING) {
            v.drivingMapState.text = state
            val region = drivingRegionText(currentRegionName(map.repository.live, place.info.place?.displayName))
            v.drivingMapRegion.visibility = if (region == null) View.GONE else View.VISIBLE
            v.drivingMapRegion.text = region ?: ""
            setStatus(v.drivingMapHealth, listOfNotNull(health, storage).takeIf { it.isNotEmpty() }?.joinToString(" · "))
        }

        if (parked) renderParked(s, state, health, storage, uploadLine, showNumbers, needsPermission, canAct, mode)
        map.update(mode, s.state == TripState.RECORDING, s.lastLocation, mapInteractive(mode, distractionOptimized))
    }

    private fun setStatus(view: TextView, text: String?) {
        view.visibility = if (text == null) View.GONE else View.VISIBLE
        view.text = text ?: ""
    }

    private fun renderParked(
        s: TripStatus,
        state: String,
        health: String?,
        storage: String?,
        uploadLine: String,
        showNumbers: Boolean,
        needsPermission: Boolean,
        canAct: Boolean,
        mode: MapMode,
    ) {
        v.chip.text = when (s.gear) {
            Gear.P -> getString(R.string.chip_parked_p)
            null -> getString(R.string.chip_parked)
            else -> getString(R.string.chip_driving, s.gear.name)
        }
        val info = if (showNumbers) place.info else null
        val here = info?.place
        val placeName = here?.displayName?.let { limitText(it, distractionOptimized, maxStringLength, statusLine = false) }
        // 현재 시군구를 모르면 제목 자리에 기존 상태 문구(대기·기록 중·종료됨 등)를 보인다.
        v.placeTitle.text = placeName ?: state
        v.nowLabel.visibility = if (placeName != null) View.VISIBLE else View.GONE
        v.stateText.visibility = if (placeName != null) View.VISIBLE else View.GONE
        v.stateText.text = state
        // 단계 배지와 마지막 이벤트(24시간 내 방문·숙박)
        if (placeName != null && here != null) {
            val level = here.level.coerceIn(0, 3)
            v.stageBadge.visibility = View.VISIBLE
            v.stageBadge.text = getString(R.string.stage_format, getString(STAGE_NAMES[level]), stageDots(level))
            v.stageBadge.setBackgroundResource(STAGE_BACKGROUNDS[level])
            v.stageBadge.setTextColor(getColor(if (level == 3) R.color.on_accent else if (level == 0) R.color.muted else R.color.text))
        } else {
            v.stageBadge.visibility = View.GONE
        }
        val event = if (showNumbers) {
            formatRegionEvent(coverage.regions?.lastEvent, engine.nowMillis(), getString(R.string.region_event_visit), getString(R.string.region_event_stay))
        } else {
            null
        }
        setLine(v.eventText, event)
        v.stageRow.visibility = if (v.stageBadge.visibility == View.VISIBLE || v.eventText.visibility == View.VISIBLE) View.VISIBLE else View.GONE

        // 숫자 줄: 도로 색칠 결과(이번 주행은 종료 화면), 전국, 시군구 도감, 샘플·거리
        val matching = coverage.matching
        val road = if (showNumbers && s.state == TripState.ENDED) {
            formatRoadLine(matching, getString(R.string.road_new), getString(R.string.matching_not_counted), getString(R.string.matching_not_counted_reason), BuildConfig.DEBUG)
        } else {
            null
        }
        setLine(v.roadText, road)
        val national = if (showNumbers) {
            formatNationalCountedLine(if (s.state == TripState.ENDED) matching else MatchingLine.None, coverage.nationalPercent, getString(R.string.national_counted), getString(R.string.national_percent))
        } else {
            null
        }
        setLine(v.nationalText, national)
        setLine(v.regionsText, if (showNumbers) formatRegionsDex(coverage.regions, getString(R.string.regions_dex)) else null)
        setLine(v.depopText, if (showNumbers) formatRegionsDepop(coverage.regions, getString(R.string.regions_depop)) else null)
        val newRegions = if (showNumbers && s.state == TripState.ENDED) formatNewRegions(coverage.newRegions, getString(R.string.regions_new)) else null
        setLine(v.newRegionsText, newRegions)
        setLine(v.samplesText, if (showNumbers) getString(R.string.samples_format, s.sampleCount) else null)
        setLine(v.distanceText, if (showNumbers) getString(R.string.distance_format, s.distanceM) else null)
        setStatus(v.healthText, health)
        setStatus(v.storageText, storage)
        v.uploadText.text = uploadLine

        v.restartButton.visibility = if (s.health == RecorderHealth.SERVICE_FAILED && hasLocationPermission() && canAct) View.VISIBLE else View.GONE
        v.permissionCard.visibility = if (needsPermission && canAct) View.VISIBLE else View.GONE
        v.permissionConfirm.visibility = if (permanentlyDenied) View.GONE else View.VISIBLE
        v.permissionSettings.visibility = if (permanentlyDenied) View.VISIBLE else View.GONE

        // 부가 요소(게스트 QR·이웃 카드·길안내 버튼): 기어 P이고 DO가 없을 때만. 앱 영역이 좁으면(두 앱을 나란히 연 경우 등) 이웃 카드는 축약형이다.
        val extras = extrasVisible(showNumbers, distractionOptimized)
        v.guestCard.visibility = if (extras) View.VISIBLE else View.GONE
        val density = resources.displayMetrics.density
        val widthDp = (v.root.width / density).toInt()
        val minWidthDp = resources.getInteger(R.integer.neighbor_card_min_width_dp)
        val narrow = narrowAppArea(widthDp, minWidthDp)
        val mapOn = mode == MapMode.PARKED
        applyAreaMode(narrow, mapOn)
        // 정차 지도: 지도는 컨트롤(DO면 숨김), 패널은 글자를 줄이고 카드는 패널 너비에 맞춘다
        val controls = if (mapOn && mapInteractive(mode, distractionOptimized)) View.VISIBLE else View.GONE
        v.mapControlCol.visibility = controls
        v.mapLayerRow.visibility = controls
        v.mapBtnRoads.setBackgroundResource(if (map.roadsOn) R.drawable.bg_map_btn_on else R.drawable.bg_map_btn)
        v.mapBtnRegions.setBackgroundResource(if (map.regionsOn) R.drawable.bg_map_btn_on else R.drawable.bg_map_btn)
        scalePanel(mapOn)
        val cardLayout = if (mapOn) {
            // 전체형 카드가 들어가는 너비: 03 원형의 기준(neighbor_card_min_width_dp)에서 왼쪽 열·여백을 뺀 값
            val fullCardMinDp = minWidthDp - ((2 * resources.getDimension(R.dimen.page_pad) + resources.getDimension(R.dimen.left_column_width) + resources.getDimension(R.dimen.column_gap)) / density).toInt()
            neighborLayoutInMap(extras, narrow, (v.panel.width / density).toInt(), fullCardMinDp)
        } else {
            neighborLayout(extras, widthDp, minWidthDp)
        }
        v.neighborCard.visibility = if (cardLayout == NeighborLayout.HIDDEN) View.GONE else View.VISIBLE
        shownNeighbor = null
        if (cardLayout != NeighborLayout.HIDDEN) renderNeighbor(info?.neighbor, info?.neighborsAllVisited == true, cardLayout)
        foldToFit()
    }

    /**
     * 본문 배치를 바꾼다(바뀔 때만 레이아웃 속성을 고친다).
     * - 지도 끔(03 원형): 패널이 전체 너비. 넓으면 가로(왼쪽 열 + 이웃 카드), 좁으면 세로(왼쪽 열 + 아래 이웃 카드).
     * - 지도 켬: 넓으면 가로로 지도 60% + 패널 40%(패널 안은 세로), 좁으면 세로로 지도 위 + 패널 아래(지도 위주, 패널은 줄임).
     */
    private fun applyAreaMode(narrow: Boolean, mapOn: Boolean) {
        if (appliedNarrow == narrow && appliedMap == mapOn) return
        appliedNarrow = narrow
        appliedMap = mapOn
        val gap = resources.getDimensionPixelSize(R.dimen.column_gap)
        val match = LinearLayout.LayoutParams.MATCH_PARENT
        val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
        v.body.orientation = if (narrow) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
        v.parkedMapArea.visibility = if (mapOn) View.VISIBLE else View.GONE
        v.parkedMapArea.layoutParams = if (narrow) LinearLayout.LayoutParams(match, 0, 3f) else LinearLayout.LayoutParams(0, match, 3f)
        // 패널: 지도 켬이면 지도 옆(또는 아래)의 40%, 끔이면 본문 전체
        v.panel.layoutParams = when {
            !mapOn -> LinearLayout.LayoutParams(match, match)
            narrow -> LinearLayout.LayoutParams(match, 0, 2f).apply { topMargin = gap / 2 }
            else -> LinearLayout.LayoutParams(0, match, 2f).apply { marginStart = gap }
        }
        val panelHorizontal = !mapOn && !narrow
        v.panel.orientation = if (panelHorizontal) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        v.leftColumn.layoutParams = if (panelHorizontal) {
            LinearLayout.LayoutParams(resources.getDimensionPixelSize(R.dimen.left_column_width), match)
        } else {
            LinearLayout.LayoutParams(match, 0, 1f)
        }
        v.neighborCard.layoutParams = if (panelHorizontal) {
            LinearLayout.LayoutParams(0, match, 1f).apply { marginStart = gap }
        } else {
            LinearLayout.LayoutParams(match, wrap).apply { topMargin = gap / 2 }
        }
    }

    /** 정차 지도 패널의 글자(와 QR)를 줄이거나 되돌린다. 처음 줄일 때 원래 크기를 기억한다. */
    private fun scalePanel(shrink: Boolean) {
        if (panelScaled == shrink) return
        panelScaled = shrink
        val factor = if (shrink) PANEL_TEXT_SCALE else 1f
        fun walk(view: View) {
            if (view is TextView) {
                val orig = originalTextSizes.getOrPut(view) { view.textSize }
                view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, orig * factor)
            }
            if (view is android.view.ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
        }
        walk(v.panel)
        val qr = resources.getDimensionPixelSize(R.dimen.qr_size)
        v.guestQrImage.layoutParams = v.guestQrImage.layoutParams.apply {
            width = (qr * factor).toInt()
            height = (qr * factor).toInt()
        }
    }

    private fun renderNeighbor(n: Neighbor?, allVisited: Boolean, layout: NeighborLayout) {
        v.neighborName.text = n?.displayName ?: getString(if (allVisited) R.string.neighbor_all_visited else R.string.neighbor_unknown)
        v.depopTag.visibility = if (n?.depop92 == true) View.VISIBLE else View.GONE
        // 목적지(이웃 중심점)를 모르거나 안 가 본 이웃이 없으면 항목 카드·길안내 버튼은 숨긴다.
        val hasNeighbor = n != null
        val full = layout == NeighborLayout.FULL
        v.poiRow.visibility = if (hasNeighbor && full) View.VISIBLE else View.GONE
        v.poiSource.visibility = if (hasNeighbor && full) View.VISIBLE else View.GONE
        v.naviCompact.visibility = if (hasNeighbor && !full) View.VISIBLE else View.GONE
        shownNeighbor = n
        if (naviMessageFor != n?.code) naviMessage = null
        v.naviStatus.text = if (hasNeighbor) naviMessage ?: "" else ""
        v.naviStatus.visibility = if (hasNeighbor && naviMessage != null) View.VISIBLE else View.GONE
    }

    /** 길안내 버튼: 화면에 보인 이웃의 시군구 중심점까지 NaviHelper로 경로를 요청한다. 버튼이 안 보이는 상태(DO·기어 P 아님)에서는 한 번 더 막는다. */
    private fun navigate() {
        val s = engine.status
        if (!extrasVisible(numbersVisible(s.gear, s.state), distractionOptimized)) return
        val n = shownNeighbor ?: return
        naviMessageFor = n.code
        navi.request(n.displayName, n.lat, n.lon) { ok ->
            naviMessage = getString(if (ok) R.string.navigate_sent else R.string.navigate_failed)
            naviMessageFor = n.code
            render()
        }
    }

    private companion object {
        const val REQUEST_CODE = 1
        const val FUSED_LOCATION = "pleos.car.permission.FUSED_LOCATION"
        const val COARSE = "android.permission.ACCESS_COARSE_LOCATION"
        val REQUIRED = listOf(FUSED_LOCATION, COARSE)
        val STAGE_NAMES = intArrayOf(R.string.stage_none, R.string.stage_pass, R.string.stage_visit, R.string.stage_stay)
        val STAGE_BACKGROUNDS = intArrayOf(R.drawable.bg_stage0, R.drawable.bg_stage1, R.drawable.bg_stage2, R.drawable.bg_stage3)
    }
}
