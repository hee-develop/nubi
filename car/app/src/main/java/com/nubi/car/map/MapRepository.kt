package com.nubi.car.map

import android.util.Log
import com.nubi.car.trip.Cancellable
import java.util.concurrent.Executor

/** 한 화면 그리기에 쓰는 데이터. */
class MapSnapshot(val base: List<BaseCell>, val regions: List<RegionShape>, val live: LiveState, val z: Int) {
    val wayCount: Int get() = base.sumOf { it.ways.size }
    val drivenCount: Int get() = base.sumOf { c -> c.ways.count { it.driven } }
}

/**
 * 지도 데이터 저장소. 뷰포트 변경을 디바운스([debounceMs])해 필요한 칸만 [executor](워커)에서 받아 두고(칸 캐시, 최근 사용 순 [maxCells]개),
 * 화면은 [snapshot]으로 네트워크 없이 읽는다. 실패한 칸은 [failBackoffMs] 동안 다시 묻지 않는다.
 * [schedule]은 지연 예약(기본은 데몬 스케줄러), 모든 상태는 lock으로 지킨다. [onChange]는 워커 스레드에서 불린다(화면은 거기서 다시 그리기만 요청한다).
 */
class MapRepository(
    private val api: MapApi,
    private val executor: Executor,
    private val vehicleId: () -> String?,
    private val schedule: (Long, () -> Unit) -> Cancellable,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val maxCells: Int = 80,
    private val debounceMs: Long = 300,
    private val failBackoffMs: Long = 15_000,
) {
    @Volatile
    var onChange: () -> Unit = {}

    private val lock = Any()
    private val baseCells = object : LinkedHashMap<CellKey, BaseCell>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<CellKey, BaseCell>?) = size > maxCells
    }
    private val regionCells = LinkedHashMap<RegionCellKey, RegionCell>()
    private val inflight = HashSet<Any>()
    private val failedAt = HashMap<Any, Long>()
    private var previousBase: List<BaseCell> = emptyList()
    private var previousRegions: List<RegionShape> = emptyList()
    private var generation = 0
    private var pendingJob: Cancellable? = null

    /** 이번 실행에서 서버에 요청한 칸 수(테스트·디버그 요약용). */
    @Volatile
    var requestCount = 0
        private set

    @Volatile
    var live: LiveState = LiveState.EMPTY

    /** 뷰포트가 바뀌었다. 마지막 호출 뒤 [debounceMs]가 지나면 화면 주변(25% 여유)의 모자란 칸을 받는다. */
    fun requestViewport(vp: Viewport, roads: Boolean, regions: Boolean) {
        synchronized(lock) {
            pendingJob?.cancel()
            pendingJob = schedule(debounceMs) { fetchFor(vp, roads, regions) }
        }
    }

    private fun fetchFor(vp: Viewport, roads: Boolean, regions: Boolean) {
        val id = vehicleId() ?: return // 차량 ID가 아직 없으면 다음 요청 때 다시 본다
        val box = vp.bbox().expand(0.25)
        if (roads) {
            val z = serverZ(vp.zoom)
            val cx = (box.minLon + box.maxLon) / 2
            val cy = (box.minLat + box.maxLat) / 2
            // 화면 가운데에 가까운 칸부터 받는다
            for (key in cellsCovering(box, z, 30).sortedBy { k -> k.bbox().let { b -> sq((b.minLon + b.maxLon) / 2 - cx) + sq((b.minLat + b.maxLat) / 2 - cy) } }) {
                if (!claim(key) { baseCells.containsKey(key) }) continue
                submit(key) { gen ->
                    val cell = api.getBase(key, id)
                    synchronized(lock) { if (gen == generation) baseCells[key] = cell }
                }
            }
        }
        if (regions) {
            val rz = regionZ(vp.zoom)
            for (key in regionCellsCovering(box, rz)) {
                if (!claim(key) { regionCells.containsKey(key) }) continue
                submit(key) { gen ->
                    val cell = api.getRegions(key, id)
                    synchronized(lock) { if (gen == generation) regionCells[key] = cell }
                }
            }
        }
    }

    private fun sq(d: Double) = d * d

    /** 이 칸을 지금 받아야 하면 true(받는 중으로 표시). 이미 있거나 받는 중이거나 최근 실패했으면 false. */
    private fun claim(key: Any, have: () -> Boolean): Boolean = synchronized(lock) {
        if (have() || key in inflight) return false
        val failed = failedAt[key]
        if (failed != null && nowMs() - failed < failBackoffMs) return false
        inflight.add(key)
        true
    }

    private fun submit(key: Any, work: (Int) -> Unit) {
        val gen = synchronized(lock) { generation }
        requestCount++
        try {
            executor.execute {
                try {
                    work(gen)
                    synchronized(lock) { failedAt.remove(key) }
                } catch (t: Throwable) {
                    Log.w(TAG, "지도 칸 조회 실패: ${t.javaClass.simpleName}")
                    synchronized(lock) { failedAt[key] = nowMs() }
                } finally {
                    synchronized(lock) { inflight.remove(key) }
                }
                notifyChange()
            }
        } catch (t: Throwable) {
            synchronized(lock) { inflight.remove(key) }
            Log.w(TAG, "지도 작업 등록 실패: ${t.javaClass.simpleName}")
        }
    }

    private fun notifyChange() {
        try {
            onChange()
        } catch (t: Throwable) {
            Log.w(TAG, "지도 갱신 알림 예외: ${t.javaClass.simpleName}")
        }
    }

    /** 지금 [vp]를 그릴 데이터. 네트워크를 하지 않는다. */
    fun snapshot(vp: Viewport, roads: Boolean, regions: Boolean): MapSnapshot = synchronized(lock) {
        val z = serverZ(vp.zoom)
        val box = vp.bbox()
        var base = emptyList<BaseCell>()
        if (roads) {
            val (cells, complete) = selectCells(cellsCovering(box, z, 30), baseCells, previousBase)
            base = cells
            if (complete) previousBase = cells
        }
        var regs = emptyList<RegionShape>()
        if (regions) {
            val rz = regionZ(vp.zoom)
            val have = regionCellsCovering(box, rz).mapNotNull { regionCells[it] }
            regs = if (have.isNotEmpty()) mergeRegions(have).also { previousRegions = it } else previousRegions
        }
        MapSnapshot(base, regs, live, z)
    }

    /** 새 주행이 끝났거나 차량 기록이 바뀌었다: 받아 둔 칸을 모두 버리고(달린 길·시군구 단계가 달라졌다) 진행 중이던 응답도 무시한다. */
    fun invalidate() {
        synchronized(lock) {
            generation++
            baseCells.clear()
            regionCells.clear()
            inflight.clear()
            failedAt.clear()
            previousBase = emptyList()
            previousRegions = emptyList()
            pendingJob?.cancel()
            pendingJob = null
        }
        notifyChange()
    }

    /** 받아 둔 바탕 칸 수(디버그·테스트). */
    val cachedCells: Int get() = synchronized(lock) { baseCells.size }

    private companion object {
        const val TAG = "NubiMap"
    }
}

/**
 * 주행 중 `GET /trips/:id/live` 폴링(계약서: 20초 간격). [tripId]는 지금 올리고 있는 서버 트립 id(없으면 건너뜀).
 * [start]하면 [intervalMs]마다 워커에서 한 번씩 조회하고, 트립이 바뀌면 이전 결과를 비운다. 결과가 바뀌면 [onChange].
 */
class LivePoller(
    private val api: MapApi,
    private val executor: Executor,
    private val tripId: () -> String?,
    private val schedule: (Long, () -> Unit) -> Cancellable,
    private val repo: MapRepository,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val intervalMs: Long = 20_000,
    private val warmupMs: Long = 5_000,
) {
    private val lock = Any()
    private var running = false
    private var job: Cancellable? = null
    private var lastTrip: String? = null
    private var polling = false

    /** 이 트립에서 지금까지 한 조회 수. 처음 [WARMUP_POLLS]번은 [warmupMs] 간격으로 물어 첫 색칠이 빨리 보이게 한다. */
    private var pollsForTrip = 0

    @Volatile
    var onChange: () -> Unit = {}

    /** 폴링을 켠다(이미 켜져 있으면 그대로). 첫 조회는 바로 한다. */
    fun start() {
        synchronized(lock) {
            if (running) return
            running = true
        }
        loop()
    }

    fun stop() {
        synchronized(lock) {
            running = false
            job?.cancel()
            job = null
        }
    }

    /** 결과를 지운다(트립이 끝나 확정 기록으로 넘어갔을 때). */
    fun clear() {
        synchronized(lock) { lastTrip = null }
        repo.live = LiveState.EMPTY
        onChange()
    }

    private fun loop() {
        val skip = synchronized(lock) { !running }
        if (skip) return
        pollOnce()
        synchronized(lock) {
            if (!running) return
            job = schedule(if (pollsForTrip < WARMUP_POLLS && repo.live.ways.isEmpty()) warmupMs else intervalMs) { loop() }
        }
    }

    private fun pollOnce() {
        val id = tripId()
        if (id == null) {
            return
        }
        val doIt = synchronized(lock) {
            if (polling) false else true.also { polling = true }
        }
        if (!doIt) return
        try {
            executor.execute {
                try {
                    val state = api.getLive(id, nowMs())
                    val changed = synchronized(lock) {
                        val newTrip = lastTrip != id
                        lastTrip = id
                        pollsForTrip = if (newTrip) 1 else pollsForTrip + 1
                        newTrip
                    }
                    if (state != null) {
                        val before = repo.live
                        repo.live = state
                        if (changed || before.upToSeq != state.upToSeq || before.ways.size != state.ways.size) {
                            Log.i("NubiMap", "live 반영 trip변경=$changed ways=${state.ways.size} new=${state.newCount} upToSeq=${state.upToSeq} wall=${nowMs()}")
                            onChange()
                        }
                    }
                } catch (t: Throwable) {
                    Log.w("NubiMap", "live 조회 실패: ${t.javaClass.simpleName}")
                } finally {
                    synchronized(lock) { polling = false }
                }
            }
        } catch (t: Throwable) {
            synchronized(lock) { polling = false }
        }
    }
}

private const val WARMUP_POLLS = 4
