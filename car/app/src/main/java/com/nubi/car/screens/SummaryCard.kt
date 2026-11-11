package com.nubi.car.screens

import android.app.Activity
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.nubi.car.R
import com.nubi.car.map.MapRepository
import com.nubi.car.map.NubiMapView
import com.nubi.car.map.Viewport
import com.nubi.car.trip.parseAccent

/**
 * 하차 요약 카드 '이번 주행': 새 도로 km, 처음 지난 시군구, 그 트립의 범위에 맞춘 정적 지도 썸네일(별도 저장소를 쓰는 만지지 못하는 지도 뷰).
 * 화면 왼쪽 아래에 겹쳐 보이고 탭하면 닫힌다(30초 뒤 자동으로 닫히는 것은 [TripSummaryState]가 정한다). 주행 중·DO에서는 호출하는 쪽이 숨긴다.
 */
class SummaryCard(private val activity: Activity, root: FrameLayout, private val thumbRepo: MapRepository, nowMs: () -> Long, private val onTap: () -> Unit) {
    private val density = activity.resources.displayMetrics.density
    private fun dp(v: Float) = (v * density).toInt()

    private val title = text(26f, R.color.muted, bold = true)
    private val km = text(34f, R.color.text, bold = true)
    private val regions = text(24f, R.color.text, bold = false)
    private val hint = text(20f, R.color.muted, bold = false)
    private val thumb = NubiMapView(activity).apply {
        repository = thumbRepo
        this.nowMs = nowMs
        interactive = false
        showRegions = true
        emphasizeNew = true
        contentDescription = null
    }
    private val card = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        tag = "summary_card"
        visibility = View.GONE
        isClickable = true
        setPadding(dp(24f), dp(20f), dp(24f), dp(20f))
        background = GradientDrawable().apply {
            cornerRadius = dp(28f).toFloat()
            setColor(activity.getColor(R.color.panel))
            setStroke(dp(2f), activity.getColor(R.color.accent))
        }
        addView(title)
        addView(km)
        addView(regions)
        addView(thumb, LinearLayout.LayoutParams(dp(460f), dp(240f)).apply { topMargin = dp(12f) })
        addView(hint)
        setOnClickListener { onTap() }
    }

    private var shownId = -1

    init {
        thumbRepo.onChange = { thumb.requestRedraw() } // 썸네일 칸이 도착하면 다시 그린다(주 지도와 저장소가 달라 따로 연결한다)
        title.text = activity.getString(R.string.summary_title)
        hint.text = activity.getString(R.string.summary_close_hint)
        root.addView(card, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
            leftMargin = dp(60f)
            bottomMargin = dp(60f)
        })
    }

    /** 화면이 사라질 때: 썸네일 저장소가 죽은 뷰를 붙들지 않게 리스너를 끊는다. */
    fun release() {
        thumbRepo.onChange = {}
    }

    private fun text(sp: Float, color: Int, bold: Boolean) = TextView(activity).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(activity.getColor(color))
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(0, dp(4f), 0, 0)
    }

    /** 1초마다. [data]가 null이면 숨긴다. 새 내용이면 문구·썸네일 보기를 다시 맞춘다. */
    fun update(data: SummaryData?) {
        if (data == null) {
            card.visibility = View.GONE
            shownId = -1
            return
        }
        card.visibility = View.VISIBLE
        if (data.id == shownId) return
        shownId = data.id
        val kmText = data.newKm?.let { activity.getString(R.string.summary_new_km, "%.1f".format(java.util.Locale.US, it)) }
        km.visibility = if (kmText == null) View.GONE else View.VISIBLE
        kmText?.let {
            val a = parseAccent(it)
            km.text = android.text.SpannableString(a.text).apply {
                setSpan(android.text.style.ForegroundColorSpan(activity.getColor(R.color.accent)), a.accentStart, a.accentEnd, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        regions.visibility = if (data.regions.isEmpty()) View.GONE else View.VISIBLE
        regions.text = activity.getString(R.string.summary_new_regions, data.regions.joinToString(", "))
        val box = data.bbox
        if (box == null || data.trail == null) {
            thumb.visibility = View.GONE
            return
        }
        thumb.visibility = View.VISIBLE
        thumb.trail = data.trail
        // 크기가 정해진 뒤 그 트립의 범위에 맞춘다(정적 렌더: 터치 없음)
        val fit = Runnable {
            if (thumb.width > 0 && thumb.height > 0) thumb.setViewport(Viewport.fit(box, thumb.width, thumb.height, dp(16f)))
        }
        if (thumb.width > 0) thumb.post(fit) else thumb.addOnLayoutChangeListener(object : View.OnLayoutChangeListener {
            override fun onLayoutChange(v: View, l: Int, t: Int, r: Int, b: Int, ol: Int, ot: Int, or: Int, ob: Int) {
                if (r - l > 0 && b - t > 0) {
                    thumb.removeOnLayoutChangeListener(this)
                    thumb.post(fit)
                }
            }
        })
    }
}
