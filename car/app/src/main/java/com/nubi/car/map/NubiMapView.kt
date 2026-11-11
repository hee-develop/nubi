package com.nubi.car.map

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.os.SystemClock
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import com.nubi.car.R
import kotlin.math.abs
import kotlin.math.ln

/**
 * 차량 지도 뷰(계약서 05 2장). 바탕 타일 없이 서버가 준 도로·시군구 도형만 Canvas로 그린다(Web Mercator, 북쪽이 위). 새 지도 라이브러리를 쓰지 않는다.
 * 데이터는 [repository]가 워커에서 받아 두고 이 뷰는 [MapRepository.snapshot]만 읽는다(onDraw에서 네트워크 없음).
 *
 * - [interactive]가 false(주행 중·DO)면 터치를 받지 않는다(이벤트를 소비하지 않음).
 * - [minRedrawMs]가 0보다 크면 그 간격보다 자주 다시 그리지 않는다(주행 중 1초 1회 이하).
 * - 그리는 순서: 시군구 칠 → 안 간 길 → 바랜 길 → 달린 길 → 이번 주행 잠정(처음 달린 길은 굵은 밝은 앰버) → 로컬 궤적 → 내 위치 → 출처 표기.
 */
class NubiMapView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    var repository: MapRepository? = null
    var trail: LocalTrail? = null

    var showRoads = true
        set(value) {
            field = value
            viewportChanged()
        }
    var showRegions = true
        set(value) {
            field = value
            viewportChanged()
        }

    /** 이번 주행에서 처음 달린 길을 굵은 밝은 앰버로 강조할지(정차 화면만). 꺼져 있으면 달린 길과 같은 색·굵기다(주행 중 시선을 끌지 않게). */
    var emphasizeNew = true

    /** 터치로 이동·확대를 받을지. */
    var interactive = false

    /** 그리기 간격 하한(ms). 0이면 제한 없음. */
    var minRedrawMs = 0L

    /** 사용자가 직접 지도를 움직였다(따라가기를 멈춘다). */
    var onUserMoved: () -> Unit = {}

    var myLocation: LonLat? = null
    var myBearing: Double? = null

    /** 지금 시계(epoch ms). 바램 판정에 쓴다(debug `now=` 시계를 따르게 컨트롤러가 넣는다). */
    var nowMs: () -> Long = { System.currentTimeMillis() }

    var viewport = Viewport.fit(NATIONAL_BBOX, 1, 1)
        private set

    private val density = resources.displayMetrics.density
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = MapColors.REGION_BORDER
        strokeWidth = 1f * density
    }
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val markerPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = MapColors.ATTRIBUTION_TEXT
        textSize = 20f * resources.displayMetrics.scaledDensity
    }
    private val pillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xCC0F141B.toInt() }
    private val regionPath = Path().apply { fillType = Path.FillType.EVEN_ODD }
    private val roadPaths = Array(3 * 4) { Path() }
    private val extra = Path()

    private val attrAscent = textPaint.fontMetrics.ascent
    private val attrDescent = textPaint.fontMetrics.descent

    // 스냅샷은 데이터·보기·레이어가 바뀔 때만 다시 뜬다(그릴 때마다 목록을 만들지 않는다)
    private var cachedSnap: MapSnapshot? = null
    private var cachedVersion = -1
    private var cachedViewport: Viewport? = null
    private var cachedRoads = true
    private var cachedRegions = true

    private var lastDrawAt = 0L
    private var redrawScheduled = false

    /** 마지막으로 그린 요약(debug contentDescription용). */
    @Volatile
    var lastSnapshot: MapSnapshot? = null
        private set

    private val scaleDetector = ScaleGestureDetector(
        context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(d: ScaleGestureDetector): Boolean {
                if (!interactive) return false
                val dz = ln(d.scaleFactor.toDouble()) / ln(2.0)
                setViewport(viewport.zoomBy(dz, d.focusX.toDouble(), d.focusY.toDouble()), byUser = true)
                return true
            }
        },
    )
    private var lastX = 0f
    private var lastY = 0f
    private var dragging = false

    // 보기 조작 ---------------------------------------------------------------

    /** 보기를 바꾼다. [byUser]면 따라가기를 멈추게 알린다. */
    fun setViewport(vp: Viewport, byUser: Boolean = false) {
        viewport = vp
        if (byUser) onUserMoved()
        viewportChanged()
        requestRedraw()
    }

    /** 중심을 ([lon],[lat])에 두고 확대를 [zoom]으로(null이면 그대로). 따라가기용이라 사용자 조작으로 치지 않는다. */
    fun centerOn(lon: Double, lat: Double, zoom: Double? = null) {
        val base = if (zoom != null) viewport.withZoom(zoom) else viewport
        setViewport(base.withCenter(lon, lat))
    }

    fun zoomIn() = setViewport(viewport.zoomBy(ZOOM_STEP), byUser = true)

    fun zoomOut() = setViewport(viewport.zoomBy(-ZOOM_STEP), byUser = true)

    /** 전국이 다 보이게(여백 포함). */
    fun showNational() = setViewport(Viewport.fit(NATIONAL_BBOX, width.coerceAtLeast(1), height.coerceAtLeast(1), (24 * density).toInt()), byUser = true)

    private fun viewportChanged() {
        repository?.requestViewport(viewport, showRoads, showRegions)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w <= 0 || h <= 0) return
        // 처음 크기가 정해질 때는 전국이 보이게 맞추고, 그 뒤로는 중심·확대를 지킨 채 크기만 바꾼다.
        viewport = if (oldw == 0 || oldh == 0) Viewport.fit(NATIONAL_BBOX, w, h, (24 * density).toInt()) else viewport.withSize(w, h)
        viewportChanged()
    }

    /** 다시 그리기를 요청한다. [minRedrawMs]가 있으면 그 간격을 지킨다. 어느 스레드에서든 부를 수 있다. */
    fun requestRedraw() {
        if (minRedrawMs <= 0) {
            postInvalidateOnAnimation()
            return
        }
        val wait = lastDrawAt + minRedrawMs - SystemClock.uptimeMillis()
        if (wait <= 0) {
            postInvalidate()
        } else if (!redrawScheduled) {
            redrawScheduled = true
            postDelayed({
                redrawScheduled = false
                invalidate()
            }, wait)
        }
    }

    // 터치 ---------------------------------------------------------------------

    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (!interactive) return false
        scaleDetector.onTouchEvent(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastX = e.x
                lastY = e.y
                dragging = true
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_POINTER_UP -> {
                // 손가락 수가 바뀌면 기준점을 다시 잡아 지도가 튀지 않게 한다.
                dragging = false
                val i = if (e.actionMasked == MotionEvent.ACTION_POINTER_UP) (if (e.actionIndex == 0) 1 else 0) else e.actionIndex
                if (i < e.pointerCount) {
                    lastX = e.getX(i)
                    lastY = e.getY(i)
                    dragging = e.actionMasked == MotionEvent.ACTION_POINTER_UP
                }
            }
            MotionEvent.ACTION_MOVE -> if (dragging && !scaleDetector.isInProgress && e.pointerCount == 1) {
                val dx = e.x - lastX
                val dy = e.y - lastY
                if (abs(dx) + abs(dy) >= 1f) {
                    lastX = e.x
                    lastY = e.y
                    setViewport(viewport.panBy(dx.toDouble(), dy.toDouble()), byUser = true)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                dragging = false
                parent?.requestDisallowInterceptTouchEvent(false)
            }
        }
        return true
    }

    // 그리기 ---------------------------------------------------------------------

    override fun onDraw(canvas: Canvas) {
        lastDrawAt = SystemClock.uptimeMillis()
        canvas.drawColor(MapColors.BG)
        val repo = repository ?: return
        val vp = viewport
        var snap = cachedSnap
        if (snap == null || cachedVersion != repo.version || cachedViewport !== vp || cachedRoads != showRoads || cachedRegions != showRegions) {
            snap = repo.snapshot(vp, showRoads, showRegions)
            cachedSnap = snap
            cachedVersion = repo.version
            cachedViewport = vp
            cachedRoads = showRoads
            cachedRegions = showRegions
        }
        lastSnapshot = snap
        val b = vp.mercBounds()

        if (showRegions) drawRegions(canvas, vp, snap, b)
        if (showRoads) drawRoads(canvas, vp, snap, b)
        drawLive(canvas, vp, snap, b)
        drawTrail(canvas, vp)
        drawMarker(canvas, vp)
        drawAttribution(canvas)
        drawLoadStatus(canvas, snap.load)
    }

    private fun drawRegions(canvas: Canvas, vp: Viewport, snap: MapSnapshot, b: DoubleArray) {
        for (r in snap.regions) {
            if (r.maxX < b[0] || r.minX > b[2] || r.maxY < b[1] || r.minY > b[3]) continue
            regionPath.rewind()
            for (i in r.ringsX.indices) addRing(regionPath, r.ringsX[i], r.ringsY[i], vp)
            val fill = regionFill(r.level, r.depop, r.faded)
            if (fill != 0) {
                fillPaint.color = fill
                canvas.drawPath(regionPath, fillPaint)
            }
            canvas.drawPath(regionPath, borderPaint)
        }
    }

    private fun addRing(path: Path, xs: DoubleArray, ys: DoubleArray, vp: Viewport) {
        var lastX = Float.NaN
        var lastY = Float.NaN
        for (i in xs.indices) {
            val x = vp.sx(xs[i]).toFloat()
            val y = vp.sy(ys[i]).toFloat()
            if (i == 0) {
                path.moveTo(x, y)
            } else if (i == xs.lastIndex || abs(x - lastX) + abs(y - lastY) >= 0.8f) {
                path.lineTo(x, y)
            } else {
                continue
            }
            lastX = x
            lastY = y
        }
        path.close()
    }

    private fun drawRoads(canvas: Canvas, vp: Viewport, snap: MapSnapshot, b: DoubleArray) {
        val maxCls = maxVisibleCls(snap.z)
        val now = nowMs()
        for (p in roadPaths) p.rewind()
        val pxPerUnit = vp.sx(1.0) - vp.sx(0.0)
        for (cell in snap.base) {
            for (w in cell.ways) {
                if (w.cls > maxCls) continue
                if (w.maxX < b[0] || w.minX > b[2] || w.maxY < b[1] || w.minY > b[3]) continue
                // 화면에서 1픽셀도 안 되는 way는 건너뛴다
                if ((w.maxX - w.minX + (w.maxY - w.minY)) * pxPerUnit < 1.0) continue
                val style = wayStyle(w, now)
                val idx = when (style) {
                    WayStyle.UNDRIVEN -> 0
                    WayStyle.FADED -> 1
                    else -> 2
                } * 4 + w.cls
                addLine(roadPaths[idx], w.mx, w.my, vp)
            }
        }
        // 안 간 길 → 바랜 길 → 달린 길 순(위로 올라올수록 중요). 같은 색 안에서는 낮은 등급부터.
        val styles = arrayOf(WayStyle.UNDRIVEN, WayStyle.FADED, WayStyle.DRIVEN)
        for (si in 0..2) {
            for (cls in CLS_MN downTo CLS_MW) {
                val path = roadPaths[si * 4 + cls]
                if (path.isEmpty) continue
                linePaint.color = colorOf(styles[si])
                linePaint.strokeWidth = strokeDp(cls, styles[si], vp.zoom) * density
                canvas.drawPath(path, linePaint)
            }
        }
    }

    private fun drawLive(canvas: Canvas, vp: Viewport, snap: MapSnapshot, b: DoubleArray) {
        val live = snap.live
        if (live.ways.isEmpty()) return
        // 이미 달린 길을 다시 달린 것(달린 길 색) → 처음 달린 길(밝은 앰버, 굵게)
        for (pass in 0..1) {
            val wantNew = pass == 1
            extra.rewind()
            for (w in live.ways) {
                if (w.isNew != wantNew) continue
                if (w.maxX < b[0] || w.minX > b[2] || w.maxY < b[1] || w.minY > b[3]) continue
                addLine(extra, w.mx, w.my, vp)
            }
            if (extra.isEmpty) continue
            // 주행 중에는 처음 달린 길도 달린 길과 같은 색·굵기(emphasizeNew=false). 정차 화면에서만 밝은 앰버로 굵게 강조한다.
            val style = if (wantNew && emphasizeNew) liveStyle(true) else liveStyle(false)
            linePaint.color = colorOf(style)
            linePaint.strokeWidth = strokeDp(CLS_SC, style, vp.zoom) * density
            canvas.drawPath(extra, linePaint)
        }
    }

    private fun drawTrail(canvas: Canvas, vp: Viewport) {
        val t = trail ?: return
        if (t.size < 2) return
        val snap = t.snapshot()
        extra.rewind()
        var lastX = Float.NaN
        var lastY = Float.NaN
        for (i in snap.lons.indices) {
            val x = vp.sx(mercX(snap.lons[i])).toFloat()
            val y = vp.sy(mercY(snap.lats[i])).toFloat()
            if (i == 0 || snap.starts[i]) {
                extra.moveTo(x, y) // 샘플이 비었던 구간은 잇지 않고 새 선분으로 시작한다
            } else if (abs(x - lastX) + abs(y - lastY) >= 1.5f) {
                extra.lineTo(x, y)
            } else {
                continue
            }
            lastX = x
            lastY = y
        }
        linePaint.color = MapColors.TRAIL
        linePaint.alpha = 230
        linePaint.strokeWidth = 2.5f * density
        canvas.drawPath(extra, linePaint)
        linePaint.alpha = 255
    }

    private fun drawMarker(canvas: Canvas, vp: Viewport) {
        val me = myLocation ?: return
        val x = vp.sx(mercX(me.lon)).toFloat()
        val y = vp.sy(mercY(me.lat)).toFloat()
        if (x < -50 || y < -50 || x > width + 50 || y > height + 50) return
        val r = 11f * density
        markerPaint.style = Paint.Style.FILL
        markerPaint.color = MapColors.BG
        canvas.drawCircle(x, y, r + 3f * density, markerPaint)
        markerPaint.color = MapColors.MARKER
        val bearing = myBearing
        if (bearing == null) {
            canvas.drawCircle(x, y, r, markerPaint)
        } else {
            // 진행 방향을 가리키는 화살표(지도는 북쪽이 위)
            canvas.save()
            canvas.rotate(bearing.toFloat(), x, y)
            extra.rewind()
            extra.moveTo(x, y - r * 1.5f)
            extra.lineTo(x + r, y + r)
            extra.lineTo(x, y + r * 0.45f)
            extra.lineTo(x - r, y + r)
            extra.close()
            canvas.drawPath(extra, markerPaint)
            canvas.restore()
        }
    }

    private fun drawAttribution(canvas: Canvas) {
        val text = ATTRIBUTION
        val pad = 8f * density
        val w = textPaint.measureText(text)
        val h = attrDescent - attrAscent
        val right = width - 8f * density
        val bottom = height - 8f * density
        canvas.drawRoundRect(right - w - 2 * pad, bottom - h - pad, right, bottom, 6f * density, 6f * density, pillPaint)
        canvas.drawText(text, right - w - pad, bottom - pad / 2 - attrDescent, textPaint)
    }

    /** 지도 왼쪽 아래의 데이터 상태 한 줄: 받는 중·못 받음(오프라인 등)·차량 확인 중. 정상이면 아무것도 그리지 않는다. */
    private fun drawLoadStatus(canvas: Canvas, load: MapLoad) {
        val text = when (load) {
            MapLoad.OK -> return
            MapLoad.LOADING -> context.getString(R.string.map_loading)
            MapLoad.FAILED -> context.getString(R.string.map_failed)
            MapLoad.NO_VEHICLE -> context.getString(R.string.map_waiting_vehicle)
        }
        val pad = 8f * density
        val w = textPaint.measureText(text)
        val h = attrDescent - attrAscent
        val left = 8f * density
        val bottom = height - 8f * density
        canvas.drawRoundRect(left, bottom - h - pad, left + w + 2 * pad, bottom, 6f * density, 6f * density, pillPaint)
        canvas.drawText(text, left + pad, bottom - pad / 2 - attrDescent, textPaint)
    }

    private fun addLine(path: Path, xs: DoubleArray, ys: DoubleArray, vp: Viewport) {
        var lastX = Float.NaN
        var lastY = Float.NaN
        for (i in xs.indices) {
            val x = vp.sx(xs[i]).toFloat()
            val y = vp.sy(ys[i]).toFloat()
            if (i == 0) {
                path.moveTo(x, y)
            } else if (i == xs.lastIndex || abs(x - lastX) + abs(y - lastY) >= 0.8f) {
                path.lineTo(x, y)
            } else {
                continue
            }
            lastX = x
            lastY = y
        }
    }

    companion object {
        const val ATTRIBUTION = "© OpenStreetMap contributors"
    }
}
