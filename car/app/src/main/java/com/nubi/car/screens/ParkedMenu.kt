package com.nubi.car.screens

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.nubi.car.FeatureFlags
import com.nubi.car.R
import com.nubi.car.trip.parseAccent

/** QR 요청 오류의 문구. */
fun codeErrorRes(e: CodeError): Int = when (e) {
    CodeError.NOT_PARKED -> R.string.code_error_not_parked
    CodeError.GUEST_LIMIT -> R.string.code_error_guest_limit
    CodeError.ALREADY_PAIRED -> R.string.code_error_already_paired
    CodeError.UNAVAILABLE -> R.string.code_error_unavailable
    CodeError.FAILED -> R.string.code_error_failed
    CodeError.NO_VEHICLE -> R.string.code_error_no_vehicle
    CodeError.RATE_LIMITED -> R.string.code_error_rate_limited
    CodeError.FORBIDDEN -> R.string.code_error_forbidden
    CodeError.LOCAL_ONLY -> R.string.code_error_local_only
    CodeError.AUTH -> R.string.code_error_auth
}

/** 정차 메뉴 탭. 지도는 기존 정차 지도+패널 화면(본문)이다. */
enum class MenuTab(val labelRes: Int, val tag: String) {
    MAP(R.string.tab_map, "tab_map"),
    DEX(R.string.tab_dex, "tab_dex"),
    ROADS(R.string.tab_roads, "tab_roads"),
    TODAY(R.string.tab_today, "tab_today"),
    SETTINGS(R.string.tab_settings, "tab_settings"),
}

/**
 * 정차(P) 화면의 메뉴: 헤더에 탭 `지도 · 도감 · 도로 · 오늘 · 설정`을 넣고, 지도가 아닌 탭은 본문 자리에 그 탭의 내용을 보인다(메뉴 깊이 2 이내:
 * 탭 → 목록·확인 단계). 주행 중(D·R·N)이거나 DO면 탭과 내용을 모두 숨기고 지도 탭으로 되돌린다([update]의 allowed=false).
 * 내용은 프로그램으로 만든 뷰이고 데이터가 바뀔 때만 다시 만든다(1초마다 깜빡이지 않게).
 */
class ParkedMenu(
    private val activity: Activity,
    private val parkedView: LinearLayout,
    private val header: LinearLayout,
    private val body: View,
    private val extras: ExtrasController,
    /** 지금 시각(엔진 시계). 오늘 리포트 날짜에 쓴다. */
    private val nowMs: () -> Long,
    /** 지금 메뉴를 써도 되는 상태인지(기어 P·DO·설정 금지·플래그). 눌림마다 한 번 더 확인한다(fail-closed). */
    private val allowedNow: () -> Boolean,
    private val voiceOn: () -> Boolean,
    private val onVoiceToggle: (Boolean) -> Unit,
    private val onChange: () -> Unit,
) {
    private val dm = activity.resources.displayMetrics
    private fun dp(v: Float) = (v * dm.density).toInt()
    private fun color(id: Int) = activity.getColor(id)

    var selected = MenuTab.MAP
        private set

    private val tabViews = HashMap<MenuTab, TextView>()
    private val tabStrip = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        visibility = View.GONE
    }
    private val scroll = ScrollView(activity).apply {
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        setPadding(dp(44f), dp(12f), dp(44f), dp(24f))
        clipToPadding = false
        visibility = View.GONE
    }
    private var content: LinearLayout = newContent()
    private var shownSignature: Int? = null
    private var homePicking = false

    init {
        val stateIndex = (0 until header.childCount).first { header.getChildAt(it).id == R.id.state_text }
        for (tab in MenuTab.values()) {
            val tv = TextView(activity).apply {
                text = activity.getString(tab.labelRes)
                tag = tab.tag
                contentDescription = null
                setTextSize(TypedValue.COMPLEX_UNIT_SP, TOUCH_TEXT_SP)
                gravity = Gravity.CENTER
                minHeight = dp(MIN_TOUCH_DP)
                setPadding(dp(16f), dp(6f), dp(16f), dp(6f))
                isClickable = true
                isFocusable = true
                setOnClickListener { if (allowedNow()) select(tab) }
            }
            tabViews[tab] = tv
            tabStrip.addView(tv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(8f) })
        }
        header.addView(tabStrip, stateIndex, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(24f) })
        scroll.addView(content)
        parkedView.addView(scroll, parkedView.indexOfChild(body) + 1)
        styleTabs()
    }

    private fun newContent() = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT)
    }

    /** 탭을 고른다. 지도가 아닌 탭은 열 때마다 서버에서 다시 받는다. */
    fun select(tab: MenuTab) {
        if (selected == tab) return
        selected = tab
        homePicking = false
        shownSignature = null
        styleTabs()
        load(tab)
        onChange()
    }

    private fun load(tab: MenuTab) {
        when (tab) {
            MenuTab.DEX -> extras.loadDex()
            MenuTab.ROADS -> extras.loadRoads()
            MenuTab.TODAY -> extras.loadToday(nowMs())
            MenuTab.SETTINGS -> {
                extras.refreshSettings()
                if (extras.dex.status == Slot.Status.EMPTY) extras.loadDex() // 내 지역 이름 표시와 목록용
            }
            MenuTab.MAP -> Unit
        }
    }

    /**
     * Back 키: 하위 상태에서는 한 단계만 되돌린다(내 지역 목록 → 설정, 데이터 지우기 확인 → 설정, QR → 닫기, 다른 탭 → 지도). 처리했으면 true,
     * 최상위(지도 탭)에서는 false를 돌려줘 호출한 쪽이 `moveTaskToBack`을 한다.
     */
    fun handleBack(): Boolean {
        if (scroll.visibility != View.VISIBLE && selected == MenuTab.MAP) return false
        if (homePicking) {
            homePicking = false
        } else if (extras.deleteStep == DeleteStep.CONFIRM_1 || extras.deleteStep == DeleteStep.CONFIRM_2) {
            extras.cancelDelete()
        } else if (extras.pair != null) {
            extras.closeCode(CodeKind.PAIR)
        } else if (extras.share != null) {
            extras.closeCode(CodeKind.SHARE)
        } else if (extras.guest != null && selected == MenuTab.SETTINGS) {
            extras.closeCode(CodeKind.GUEST)
        } else if (selected != MenuTab.MAP) {
            select(MenuTab.MAP)
            return true
        } else {
            return false
        }
        shownSignature = null
        onChange()
        return true
    }

    private fun styleTabs() {
        for ((tab, tv) in tabViews) {
            val on = tab == selected
            tv.setTextColor(color(if (on) R.color.on_accent else R.color.text))
            tv.background = GradientDrawable().apply {
                cornerRadius = dp(999f).toFloat()
                setColor(if (on) color(R.color.accent) else color(R.color.panel2))
                setStroke(dp(1f), color(R.color.line))
            }
        }
    }

    /**
     * 1초마다. [allowed]가 false(주행 중·DO·플래그 꺼짐)면 탭과 내용을 지우고 지도 탭으로 돌아간다. 지도 탭이면 본문(정차 지도+패널)을 보인다.
     */
    fun update(allowed: Boolean) {
        val show = allowed && FeatureFlags.parkedMenu
        if (!show) {
            if (selected != MenuTab.MAP) {
                selected = MenuTab.MAP
                styleTabs()
            }
            homePicking = false
            shownSignature = null
            tabStrip.visibility = View.GONE
            scroll.visibility = View.GONE
            body.visibility = View.VISIBLE
            return
        }
        tabStrip.visibility = View.VISIBLE
        val onMap = selected == MenuTab.MAP
        body.visibility = if (onMap) View.VISIBLE else View.GONE
        scroll.visibility = if (onMap) View.GONE else View.VISIBLE
        if (onMap) return
        val sig = signature()
        if (sig != shownSignature) {
            shownSignature = sig
            val y = scroll.scrollY
            rebuild()
            scroll.post { scroll.scrollTo(0, y) }
        }
        if (selected == MenuTab.SETTINGS) updateCountdown()
    }

    private fun signature(): Int {
        var h = selected.ordinal
        fun add(x: Any?) {
            h = h * 31 + (x?.hashCode() ?: 0)
        }
        when (selected) {
            MenuTab.DEX -> { add(extras.dex.status); add(System.identityHashCode(extras.dex.value)) }
            MenuTab.ROADS -> {
                add(extras.almostRoads.status); add(System.identityHashCode(extras.almostRoads.value))
                add(extras.allRoads.status); add(System.identityHashCode(extras.allRoads.value))
            }
            MenuTab.TODAY -> {
                add(extras.daily.status); add(System.identityHashCode(extras.daily.value))
                add(extras.monthly.status); add(System.identityHashCode(extras.monthly.value))
                add(System.identityHashCode(extras.share)); add(extras.codeError)
            }
            MenuTab.SETTINGS -> {
                add(extras.settings); add(extras.settingsError); add(extras.deleteStep); add(homePicking); add(voiceOn())
                add(System.identityHashCode(extras.pair)); add(System.identityHashCode(extras.guest)); add(extras.guestCount); add(extras.codeError)
                add(extras.dex.status)
            }
            MenuTab.MAP -> Unit
        }
        return h
    }

    // 그리기 ------------------------------------------------------------------

    private fun rebuild() {
        content.removeAllViews()
        countdownView = null
        when (selected) {
            MenuTab.DEX -> buildDex()
            MenuTab.ROADS -> buildRoads()
            MenuTab.TODAY -> buildToday()
            MenuTab.SETTINGS -> if (homePicking) buildHomePicker() else buildSettings()
            MenuTab.MAP -> Unit
        }
    }

    private fun text(s: String, sp: Float = 26f, colorId: Int = R.color.text, bold: Boolean = false, top: Float = 8f): TextView {
        val accent = parseAccent(s)
        val tv = TextView(activity)
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        tv.setTextColor(color(colorId))
        if (bold) tv.setTypeface(tv.typeface, android.graphics.Typeface.BOLD)
        if (accent.hasAccent) {
            tv.text = android.text.SpannableString(accent.text).apply {
                setSpan(android.text.style.ForegroundColorSpan(color(R.color.accent)), accent.accentStart, accent.accentEnd, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        } else {
            tv.text = s
        }
        content.addView(tv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) })
        return tv
    }

    private fun button(label: String, tag: String, filled: Boolean = false, parent: LinearLayout = content, onClick: () -> Unit): TextView {
        val tv = TextView(activity).apply {
            text = label
            this.tag = tag
            setTextSize(TypedValue.COMPLEX_UNIT_SP, TOUCH_TEXT_SP)
            setTextColor(color(if (filled) R.color.on_accent else R.color.text))
            gravity = Gravity.CENTER_VERTICAL
            minHeight = dp(MIN_TOUCH_DP)
            setPadding(dp(28f), dp(12f), dp(28f), dp(12f))
            isClickable = true
            isFocusable = true
            background = GradientDrawable().apply {
                cornerRadius = dp(28f).toFloat()
                setColor(color(if (filled) R.color.accent else R.color.panel2))
                setStroke(dp(1.5f), color(if (filled) R.color.accent else R.color.line))
            }
            setOnClickListener { if (allowedNow()) onClick() }
        }
        parent.addView(tv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(10f)
            marginEnd = dp(12f)
        })
        return tv
    }

    private fun row(): LinearLayout = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        content.addView(this, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }

    private fun status(slot: Slot<*>): Boolean = when (slot.status) {
        Slot.Status.OK -> true
        Slot.Status.FAILED -> { text(activity.getString(R.string.load_failed), colorId = R.color.muted); false }
        else -> { text(activity.getString(R.string.loading), colorId = R.color.muted); false }
    }

    private fun chip(label: String, level: Int, depop: Boolean, faded: Boolean): TextView = TextView(activity).apply {
        text = label
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
        setPadding(dp(14f), dp(6f), dp(14f), dp(6f))
        val fill = when {
            level <= 0 -> color(R.color.stage0)
            faded -> Color.argb(if (level == 1) 0x47 else if (level == 2) 0x99 else 0xDD, 0xC7, 0x9A, 0x4C)
            else -> when (level) { 1 -> color(R.color.stage1); 2 -> color(R.color.stage2); else -> color(R.color.stage3) }
        }
        setTextColor(if (level == 3) color(R.color.on_accent) else if (level == 0) color(R.color.muted) else color(R.color.text))
        background = GradientDrawable().apply {
            cornerRadius = dp(10f).toFloat()
            setColor(fill)
            setStroke(dp(if (depop) 2f else 1f), if (depop) color(R.color.depop) else color(R.color.line))
        }
    }

    private fun buildDex() {
        if (!status(extras.dex)) return
        val items = extras.dex.value ?: return
        val s = dexSummary(items)
        text(activity.getString(R.string.dex_summary, s.colored, s.total, s.depopColored, s.depopTotal), 30f, bold = true, top = 0f).tag = "dex_summary"
        text(activity.getString(R.string.dex_legend), 20f, R.color.muted, top = 4f)
        for (g in groupBySido(items)) {
            text(activity.getString(R.string.dex_group, g.sido, g.colored, g.items.size), 24f, R.color.accent, bold = true, top = 18f)
            val flow = FlowLayout(activity, dp(8f))
            for (item in g.items) flow.addView(chip(item.name, item.level, item.depop92, item.faded))
            content.addView(flow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
        }
    }

    private fun buildRoads() {
        text(activity.getString(R.string.roads_almost), 28f, R.color.accent, bold = true, top = 0f)
        roadRows(extras.almostRoads)
        text(activity.getString(R.string.roads_all), 28f, R.color.accent, bold = true, top = 24f)
        roadRows(extras.allRoads)
    }

    private fun roadRows(slot: Slot<List<RoadItem>>) {
        if (!status(slot)) return
        val items = slot.value.orEmpty()
        if (items.isEmpty()) {
            text(activity.getString(R.string.roads_empty), colorId = R.color.muted)
            return
        }
        for (r in items) {
            val line = activity.getString(R.string.road_row, "%.1f".format(java.util.Locale.US, r.percent), "%.1f".format(java.util.Locale.US, r.drivenM / 1000.0), "%.1f".format(java.util.Locale.US, r.totalM / 1000.0))
            text(r.displayName, 26f, bold = true, top = 10f)
            text(line, 22f, R.color.muted, top = 0f)
        }
    }

    private fun buildToday() {
        text(activity.getString(R.string.today_title), 30f, bold = true, top = 0f)
        if (status(extras.daily)) {
            val d = extras.daily.value!!
            text(activity.getString(R.string.today_new_km, "%.1f".format(java.util.Locale.US, d.newKm)), 28f, top = 8f).tag = "today_new_km"
            text(if (d.newRegions.isEmpty()) activity.getString(R.string.today_new_regions_none) else activity.getString(R.string.today_new_regions, d.newRegions.joinToString(", ")))
            text(activity.getString(R.string.today_trips, d.tripCount, "%.1f".format(java.util.Locale.US, d.distanceKm)))
            text(activity.getString(R.string.today_revived, "%.1f".format(java.util.Locale.US, d.revivedKm)))
        }
        text(activity.getString(R.string.month_title), 30f, bold = true, top = 28f)
        if (status(extras.monthly)) {
            val m = extras.monthly.value!!
            text(activity.getString(R.string.today_new_km, "%.1f".format(java.util.Locale.US, m.newKm)), 28f, top = 8f)
            text(activity.getString(R.string.today_trips, m.tripCount, "%.1f".format(java.util.Locale.US, m.distanceKm)))
            text(activity.getString(R.string.month_days, m.daysDriven))
            text(activity.getString(R.string.today_revived, "%.1f".format(java.util.Locale.US, m.revivedKm)))
            if (m.newRegions.isNotEmpty()) text(activity.getString(R.string.today_new_regions, m.newRegions.joinToString(", ")))
        }
        if (FeatureFlags.share) {
            val share = extras.share
            if (share == null) {
                button(activity.getString(R.string.share_button), "share_button", top = true) { extras.requestShare(); onChange() }
                codeErrorText(CodeKind.SHARE)
            } else {
                qrBlock(share, activity.getString(R.string.share_hint), "share_qr") { extras.closeCode(CodeKind.SHARE); onChange() }
            }
        }
    }

    private fun button(label: String, tag: String, top: Boolean, onClick: () -> Unit): TextView {
        val r = row()
        return button(label, tag, filled = true, parent = r, onClick = onClick).also { (it.layoutParams as LinearLayout.LayoutParams).topMargin = dp(if (top) 24f else 10f) }
    }

    private fun codeErrorText(kind: CodeKind) {
        val e = extras.codeError ?: return
        if (e.first != kind) return
        val res = codeErrorRes(e.second)
        text(activity.getString(res), 22f, R.color.muted)
    }

    private var countdownView: TextView? = null
    private var countdownPrefix: String? = null
    private var countdownState: CodeState? = null

    /** QR + 설명(코드가 있으면 6자리 코드와 남은 시간) + 닫기. 남은 시간은 [updateCountdown]이 숫자만 1초마다 바꾼다. */
    private fun qrBlock(state: CodeState, hint: String, tag: String, onClose: () -> Unit) {
        val r = row()
        r.gravity = Gravity.CENTER_VERTICAL
        val img = ImageView(activity).apply {
            this.tag = tag
            state.matrix?.let { setImageBitmap(qrBitmap(it)) }
            scaleType = ImageView.ScaleType.FIT_XY
        }
        r.addView(img, LinearLayout.LayoutParams(dp(220f), dp(220f)).apply { topMargin = dp(16f) })
        val col = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        r.addView(col, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(24f) })
        val saved = content
        content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }.also { col.addView(it) }
        if (state.code != null) {
            val t = text(hint.replace("%1\$s", state.code), 24f)
            countdownView = t
            countdownPrefix = hint
            countdownState = state
            t.tag = "code_hint"
        } else {
            text(hint, 24f)
        }
        button(activity.getString(R.string.qr_close), "qr_close") { onClose() }
        content = saved
        qrCodeFor = state
    }

    private var qrCodeFor: CodeState? = null

    /** 코드가 있는 QR(차주 연결)의 남은 시간 문구를 갱신한다. */
    private fun updateCountdown() {
        val st = countdownState ?: return
        val view = countdownView ?: return
        val hint = countdownPrefix ?: return
        view.text = formatHint(hint, st)
    }

    private fun formatHint(hint: String, st: CodeState): String =
        hint.replace("%1\$s", st.code ?: "").replace("%2\$s", formatRemaining(remainingMs(st.receivedElapsedMs, android.os.SystemClock.elapsedRealtime())))

    private companion object {
        const val MIN_TOUCH_DP = 80f
        const val TOUCH_TEXT_SP = 32f
    }

    private fun onOff(b: Boolean) = activity.getString(if (b) R.string.on else R.string.off)

    private fun buildSettings() {
        val s = extras.settings
        text(activity.getString(R.string.tab_settings), 30f, bold = true, top = 0f)
        if (s == null) {
            status(Slot<Unit>().also { if (extras.settingsError) it.failed() else it.loading() })
            return
        }
        if (extras.settingsError) text(activity.getString(R.string.settings_error), 22f, R.color.muted)
        val paused = s.recordingPaused
        button(activity.getString(R.string.settings_pause, onOff(paused)), "set_pause", filled = paused, parent = row()) { extras.setPaused(!paused); onChange() }
        button(activity.getString(R.string.settings_driving_map, onOff(s.drivingMap)), "set_map", parent = row()) { extras.setDrivingMap(!s.drivingMap); onChange() }
        val v = voiceOn()
        button(activity.getString(R.string.settings_voice, onOff(v)), "set_voice", parent = row()) { onVoiceToggle(!v); shownSignature = null; onChange() }
        val homeName = s.homeRegion?.let { code -> extras.dex.value?.firstOrNull { it.code == code }?.displayName } ?: s.homeRegion
        button(activity.getString(R.string.settings_home, homeName ?: activity.getString(R.string.settings_home_none)), "set_home", parent = row()) { homePicking = true; shownSignature = null; onChange() }
        if (FeatureFlags.guest) buildGuest()
        if (FeatureFlags.guest || FeatureFlags.share) {
            val pair = extras.pair
            if (pair == null) {
                button(activity.getString(R.string.pair_button), "pair_button", parent = row()) { extras.requestPairCode(); onChange() }
                codeErrorText(CodeKind.PAIR)
            } else {
                qrBlock(pair, activity.getString(R.string.pair_hint, "%1\$s", "%2\$s"), "pair_qr") { extras.closeCode(CodeKind.PAIR); onChange() }
            }
        }
        buildDelete()
    }

    /** 같이 탄 사람: 정차 지도 패널의 게스트 카드와 같은 상태(QR·6자리 코드·남은 시간·인원·모두 내리기)를 설정 탭에서도 쓴다. */
    private fun buildGuest() {
        val g = extras.guest
        val n = extras.guestCount ?: 0
        if (g == null) {
            val r = row()
            button(activity.getString(R.string.guest_add), "guest_add_tab", parent = r) { extras.requestGuestCode(); extras.refreshGuestCount(); onChange() }
            if (n > 0) button(activity.getString(R.string.guest_end_all), "guest_end_all_tab", parent = r) { extras.endAllGuests(); onChange() }
            codeErrorText(CodeKind.GUEST)
        } else {
            qrBlock(g, activity.getString(R.string.guest_code_inline, "%1\$s", "%2\$s"), "guest_qr_tab") { extras.closeCode(CodeKind.GUEST); onChange() }
        }
        if (n > 0) text(activity.getString(R.string.guest_count, n), 22f, R.color.muted)
    }

    private fun buildDelete() {
        text("", 8f)
        when (extras.deleteStep) {
            DeleteStep.NONE, DeleteStep.DONE, DeleteStep.FAILED -> {
                button(activity.getString(R.string.delete_button), "delete_button", parent = row()) { extras.startDelete(); shownSignature = null; onChange() }
                if (extras.deleteStep == DeleteStep.DONE) text(activity.getString(R.string.delete_done), 22f, R.color.muted)
                if (extras.deleteStep == DeleteStep.FAILED) text(activity.getString(R.string.delete_failed), 22f, R.color.muted)
            }
            DeleteStep.CONFIRM_1 -> {
                text(activity.getString(R.string.delete_confirm1), 24f, top = 12f).tag = "delete_confirm1"
                val r = row()
                button(activity.getString(R.string.delete_next), "delete_next", filled = true, parent = r) { extras.confirmDeleteFirst(); shownSignature = null; onChange() }
                button(activity.getString(R.string.delete_cancel), "delete_cancel", parent = r) { extras.cancelDelete(); shownSignature = null; onChange() }
            }
            DeleteStep.CONFIRM_2 -> {
                text(activity.getString(R.string.delete_confirm2), 24f, top = 12f).tag = "delete_confirm2"
                val r = row()
                button(activity.getString(R.string.delete_final), "delete_final", filled = true, parent = r) { extras.confirmDeleteFinal(); shownSignature = null; onChange() }
                button(activity.getString(R.string.delete_cancel), "delete_cancel2", parent = r) { extras.cancelDelete(); shownSignature = null; onChange() }
            }
            DeleteStep.WORKING -> text(activity.getString(R.string.delete_working), colorId = R.color.muted)
        }
    }

    /** 내 지역 고르기: 시군구 이름 목록(시도별). 하나를 누르면 저장하고 설정으로 돌아간다. */
    private fun buildHomePicker() {
        text(activity.getString(R.string.settings_home_pick), 28f, bold = true, top = 0f)
        val r = row()
        button(activity.getString(R.string.settings_home_clear), "home_clear", parent = r) { extras.setHomeRegion(null); homePicking = false; shownSignature = null; onChange() }
        button(activity.getString(R.string.settings_home_back), "home_back", parent = r) { homePicking = false; shownSignature = null; onChange() }
        if (!status(extras.dex)) return
        val current = extras.settings?.homeRegion
        for (g in groupBySido(extras.dex.value.orEmpty())) {
            text(g.sido, 24f, R.color.accent, bold = true, top = 16f)
            val flow = FlowLayout(activity, dp(8f))
            for (item in g.items) {
                val c = chip(item.name, if (item.code == current) 3 else 0, false, false).apply {
                    tag = "home_" + item.code
                    isClickable = true
                    minHeight = dp(MIN_TOUCH_DP)
                    gravity = Gravity.CENTER
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
                    setOnClickListener { if (allowedNow()) { extras.setHomeRegion(item.code); homePicking = false; shownSignature = null; onChange() } }
                }
                flow.addView(c)
            }
            content.addView(flow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
        }
    }
}
