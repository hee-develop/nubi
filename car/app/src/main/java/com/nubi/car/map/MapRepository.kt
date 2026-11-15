package com.nubi.car.map

import android.util.Log
import com.nubi.car.trip.Cancellable
import java.util.concurrent.Executor

/** 한 화면 그리기에 쓰는 데이터. [load]는 지도 위 한 줄 표시(받는 중·못 받음)에 쓴다. */
class MapSnapshot(val base: List<BaseCell>, val regions: List<RegionShape>, val live: LiveState, val z: Int, val load: MapLoad = MapLoad.OK) {
    val wayCount: Int get() = base.sumOf { it.ways.size }
    val drivenCount: Int get() = base.sumOf { c -> c.ways.count { it.driven } }
}

/**
 * 지도 데이터 저장소. 뷰포트 변경을 디바운스([debounceMs])해 필요한 칸만 [executor](워커)에서 받아 두고, 화면은 [snapshot]으로 네트워크 없이 읽는다.
 *
 * - 캐시: 바탕 칸은 최근 사용 순으로 [maxCells]칸·좌표 [maxPoints]개 합 이하(다른 z의 칸부터 내보낸다), 시군구 칸은 [maxRegionCells]칸.
 * - 실패한 칸은 [failBackoffMs] 동안 다시 묻지 않고, 그 시간이 지나면 **마지막 뷰포트로 스스로 다시 요청**한다(화면을 움직여야만 재시도되지 않는다).
 *   차량 ID가 아직 없을 때도 [vehicleRetryMs] 뒤에 다시 본다. [invalidate] 뒤에도 마지막 뷰포트를 다시 받는다.
 * - 모든 상태는 lock으로 지킨다. [onChange]는 워커 스레드에서 불린다(화면은 거기서 다시 그리기만 요청한다).
 */
class MapRepository(
    private val api: MapApi,
    private val executor: Executor,
    private val vehicleId: () -> String?,
    private val schedule: (Long, () -> Unit) -> Cancellable,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val maxCells: Int = 40,
    private val maxPoints: Int = 600_000,
    private val maxRegionCells: Int = 24,
    private val debounceMs: Long = 300,
    private val failBackoffMs: Long = 15_000,
    private val vehicleRetryMs: Long = 2_000,
) {
    @Volatile
    var onChange: () -> Unit = {}

    private class Request(val vp: Viewport, val roads: Boolean, val regions: Boolean)

    private val lock = Any()
    private val baseCells = LinkedHashMap<CellKey, BaseCell>(16, 0.75f, true)
    private val regionCells = object : LinkedHashMap<RegionCellKey, RegionCell>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<RegionCellKey, RegionCell>?) = size > maxRegionCells
    }
    private val inflight = HashSet<Any>()
    private val failedAt = HashMap<Any, Long>()
    private var previousBase: List<BaseCell> = emptyList()
    private var previousRegions: List<RegionShape> = emptyList()
    private var generation = 0
    private var pendingJob: Cancellable? = null
    private var retryJob: Cancellable? = null
    private var lastRequest: Request? = null

    /** 이번 실행에서 서버에 요청한 칸 수(테스트·디버그 요약용). */
    @Volatile
    var requestCount = 0
        private set

    /** 데이터가 바뀔 때마다 올라간다(화면이 스냅샷을 다시 뜰지 정하는 기준). */
    @Volatile
    var version = 0
        private set

    @Volatile
    var live: LiveState = LiveState.EMPTY
        set(value) {
            field = value
            touch()
        }

    fun touch() {
        version++
    }

    /** 뷰포트가 바뀌었다. 마지막 호출 뒤 [debounceMs]가 지나면 화면 주변(25% 여유)의 모자란 칸을 받는다. */
    fun requestViewport(vp: Viewport, roads: Boolean, regions: Boolean) {
        synchronized(lock) {
            lastRequest = Request(vp, roads, regions)
            pendingJob?.cancel()
            pendingJob = schedule(debounceMs) { fetchFor(vp, roads, regions) }
        }
    }

    /** 마지막으로 요청한 뷰포트를 다시 요청한다(무효화·실패 백오프·차량 ID 확보 뒤). */
    private fun retryLast() {
        val r = synchronized(lock) { lastRequest } ?: return
        requestViewport(r.vp, r.roads, r.regions)
    }

    private fun scheduleRetry(delayMs: Long) {
        synchronized(lock) {
            retryJob?.cancel()
            retryJob = schedule(delayMs) { retryLast() }
        }
    }

    private fun fetchFor(vp: Viewport, roads: Boolean, regions: Boolean) {
        val id = vehicleId()
        if (id == null) {
            scheduleRetry(vehicleRetryMs) // 차량 ID가 생길 때까지 화면을 안 움직여도 다시 본다
            return
        }
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
                    synchronized(lock) {
                        if (gen == generation) {
                            baseCells[key] = cell
                            evictLocked(z)
                        }
                    }
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

    /** 칸 수·좌표 수가 상한을 넘으면 오래 안 쓴 칸부터, **현재 z가 아닌 칸을 먼저** 내보낸다. 내보낸 칸을 직전 묶음이 붙잡고 있지 않게 정리한다. lock 안에서 부른다. */
    private fun evictLocked(currentZ: Int) {
        fun over() = baseCells.size > maxCells || baseCells.values.sumOf { it.pointCount } > maxPoints
        var changed = false
        while (over() && baseCells.size > 1) {
            val victim = baseCells.keys.firstOrNull { it.z != currentZ } ?: baseCells.keys.first()
            baseCells.remove(victim)
            changed = true
        }
        if (changed) previousBase = previousBase.filter { baseCells.containsKey(it.key) }
    }

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
                var failed = false
                try {
                    work(gen)
                    synchronized(lock) { failedAt.remove(key) }
                } catch (t: Throwable) {
                    failed = true
                    Log.w(TAG, "지도 칸 조회 실패: ${t.javaClass.simpleName}")
                    synchronized(lock) { failedAt[key] = nowMs() }
                } finally {
                    synchronized(lock) { inflight.remove(key) }
                }
                if (failed) scheduleRetry(failBackoffMs) // 백오프가 끝나면 마지막 뷰포트로 다시 받는다
                touch()
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
        var load = MapLoad.OK
        if (roads) {
            val needed = cellsCovering(box, z, 30)
            val (cells, complete) = selectCells(needed, baseCells, previousBase)
            base = cells
            if (complete) previousBase = cells
            val missing = needed.filter { !baseCells.containsKey(it) }
            if (missing.isNotEmpty()) {
                val now = nowMs()
                load = when {
                    vehicleId() == null -> MapLoad.NO_VEHICLE
                    missing.any { k -> failedAt[k]?.let { now - it < failBackoffMs } == true } && missing.none { it in inflight } -> MapLoad.FAILED
                    else -> MapLoad.LOADING
                }
            }
        }
        var regs = emptyList<RegionShape>()
        if (regions) {
            val rz = regionZ(vp.zoom)
            val have = regionCellsCovering(box, rz).mapNotNull { regionCells[it] }
            regs = if (have.isNotEmpty()) mergeRegions(have).also { previousRegions = it } else previousRegions
        }
        MapSnapshot(base, regs, live, z, load)
    }

    /** 새 주행이 끝났거나 차량 기록이 바뀌었다: 받아 둔 칸을 모두 버리고(달린 길·시군구 단계가 달라졌다) 진행 중이던 응답은 무시하고, 마지막 뷰포트를 다시 받는다. */
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
        touch()
        notifyChange()
        retryLast()
    }

    /** 받아 둔 바탕 칸 수(디버그·테스트). */
    val cachedCells: Int get() = synchronized(lock) { baseCells.size }

    val cachedRegionCells: Int get() = synchronized(lock) { regionCells.size }

    val cachedPoints: Int get() = synchronized(lock) { baseCells.values.sumOf { it.pointCount } }

    private companion object {
        const val TAG = "NubiMap"
    }
}

/**
 * 주행 중 `GET /trips/:id/live` 폴링(계약서: 20초 간격). [tripId]는 지금 올리고 있는 서버 트립 id(없으면 건너뜀).
 * 서버가 `cursor` 이후 새 way만 주므로 여기서 **누적**한다(상한 [maxWays], 넘으면 오래된 것부터 버림). 트립이 바뀌면 누적을 비운다.
 * 점 업로드가 성공하면 [kick]으로 한 번 더 바로 묻는다(업로드와 조회를 한 주기로 묶는다). 시작·정지는 세대 번호로 구분해 정지 직후 시작해도 옛 루프가 되살아나지 않는다.
 */
class LivePoller(
    private val api: MapApi,
    private val executor: Executor,
    private val tripId: () -> String?,
    private val schedule: (Long, () -> Unit) -> Cancellable,
    private val repo: MapRepository,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val intervalMs: Long = 20_000,
    private val kickDelayMs: Long = 2_000,
    private val maxWays: Int = 3_000,
) {
    private val lock = Any()
    private var running = false
    private var gen = 0
    private var job: Cancellable? = null
    private var kickJob: Cancellable? = null
    private var polling = false
    private var lastTrip: String? = null
    private val acc = LinkedHashMap<Long, LiveWay>()
    private var cursor = 0L

    @Volatile
    var onChange: () -> Unit = {}

    /** 폴링을 켠다(이미 켜져 있으면 그대로). 첫 조회는 바로 한다. */
    fun start() {
        val g = synchronized(lock) {
            if (running) return
            running = true
            ++gen
        }
        loop(g)
    }

    fun stop() {
        synchronized(lock) {
            running = false
            gen++
            job?.cancel()
            job = null
            kickJob?.cancel()
            kickJob = null
        }
    }

    /** 점 업로드가 성공했다: 서버가 곧 잠정 매칭을 돌리니 [kickDelayMs] 뒤 한 번 묻는다. 꺼져 있으면 무시. */
    fun kick() {
        synchronized(lock) {
            if (!running) return
            val g = gen
            kickJob?.cancel()
            kickJob = schedule(kickDelayMs) {
                val ok = synchronized(lock) { running && g == gen }
                if (ok) pollOnce()
            }
        }
    }

    /** 결과를 지운다(트립이 끝나 확정 기록으로 넘어갔을 때). */
    fun clear() {
        synchronized(lock) {
            lastTrip = null
            acc.clear()
            cursor = 0L
        }
        repo.live = LiveState.EMPTY
        onChange()
    }

    private fun loop(g: Int) {
        if (synchronized(lock) { !running || g != gen }) return
        pollOnce()
        synchronized(lock) {
            if (!running || g != gen) return
            job = schedule(intervalMs) { loop(g) }
        }
    }

    private fun pollOnce() {
        val id = tripId() ?: return
        val since = synchronized(lock) {
            if (polling) return
            polling = true
            if (lastTrip != id) 0L else cursor
        }
        try {
            executor.execute {
                try {
                    val delta = api.getLive(id, since, nowMs())
                    if (delta != null) merge(id, since, delta)
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

    /** 응답을 누적에 합쳐 저장소에 올린다. 트립이 바뀌었으면 누적을 먼저 비운다. */
    private fun merge(id: String, since: Long, delta: LiveState) {
        val before = repo.live
        val state = synchronized(lock) {
            val newTrip = lastTrip != id
            if (newTrip) {
                acc.clear()
                lastTrip = id
            }
            // since=0으로 받은 응답은 서버의 최신 묶음 전체라 누적을 갈아 끼운다
            if (since == 0L) acc.clear()
            for (w in delta.ways) {
                acc.remove(w.id)
                acc[w.id] = w
            }
            while (acc.size > maxWays) acc.remove(acc.keys.first())
            cursor = delta.cursor
            LiveState(delta.status, delta.upToSeq, acc.values.toList(), delta.region, delta.receivedAtMs, delta.cursor)
        }
        repo.live = state
        if (before.upToSeq != state.upToSeq || before.ways.size != state.ways.size || before.region?.code != state.region?.code) {
            Log.i("NubiMap", "live 반영 ways=${state.ways.size} new=${state.newCount} +${delta.ways.size} upToSeq=${state.upToSeq} wall=${nowMs()}")
            onChange()
        }
    }
}
