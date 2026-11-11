package com.nubi.car.map

import com.nubi.car.trip.Cancellable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executor

/** 시간을 직접 흘리는 지연 예약기. */
private class ManualTimer {
    var now = 0L
    private class Job(val at: Long, val block: () -> Unit) {
        var cancelled = false
    }

    private val jobs = ArrayList<Job>()
    val pending: Int get() = jobs.count { !it.cancelled }

    fun schedule(delay: Long, block: () -> Unit): Cancellable {
        val j = Job(now + delay, block)
        jobs.add(j)
        return Cancellable { j.cancelled = true }
    }

    fun advance(ms: Long) {
        val end = now + ms
        while (true) {
            val next = jobs.filter { !it.cancelled && it.at <= end }.minByOrNull { it.at } ?: break
            now = next.at
            jobs.remove(next)
            next.block()
        }
        now = end
    }
}

private class FakeMapApi : MapApi {
    val baseCalls = ArrayList<CellKey>()
    val regionCalls = ArrayList<RegionCellKey>()
    var liveCalls = 0
    var failBase = false
    var live: LiveState? = LiveState("ready", 1, emptyList(), null, 0L)

    override fun getBase(key: CellKey, vehicleId: String): BaseCell {
        baseCalls.add(key)
        if (failBase) throw java.io.IOException("x")
        return BaseCell(key, listOf(MapWay(key.ix.toLong(), CLS_MW, doubleArrayOf(0.5, 0.6), doubleArrayOf(0.5, 0.5), 0L, 0.0)), false)
    }

    override fun getRegions(key: RegionCellKey, vehicleId: String): RegionCell {
        regionCalls.add(key)
        return RegionCell(key, listOf(RegionShape("c${key.ix}", "n", 1, false, false, listOf(doubleArrayOf(0.5, 0.6, 0.5)), listOf(doubleArrayOf(0.5, 0.5, 0.6)))))
    }

    override fun getLive(tripId: String, nowMs: Long): LiveState? {
        liveCalls++
        return live
    }
}

class MapRepositoryTest {
    private val timer = ManualTimer()
    private val api = FakeMapApi()
    private val direct = Executor { it.run() }
    private var vehicle: String? = "v1"
    private var changes = 0
    private val vp = Viewport(127.0, 37.5, 14.0, 1200, 800)

    private fun repo(maxCells: Int = 80) = MapRepository(api, direct, { vehicle }, timer::schedule, { timer.now }, maxCells = maxCells).also { it.onChange = { changes++ } }

    @Test
    fun 뷰포트_요청은_300ms_디바운스로_한_번만_받는다() {
        val r = repo()
        r.requestViewport(vp, roads = true, regions = false)
        timer.advance(200)
        r.requestViewport(vp, roads = true, regions = false) // 연달아 와서 앞 요청을 취소
        timer.advance(200)
        assertTrue(api.baseCalls.isEmpty()) // 마지막 요청 뒤 300ms가 아직 안 지남
        timer.advance(150)
        assertTrue(api.baseCalls.isNotEmpty())
        val n = api.baseCalls.size
        assertEquals(n, api.baseCalls.toSet().size) // 같은 칸을 두 번 받지 않는다
        assertTrue(changes >= n)
    }

    @Test
    fun 받은_칸은_캐시하고_다시_묻지_않는다() {
        val r = repo()
        r.requestViewport(vp, true, false)
        timer.advance(400)
        val first = api.baseCalls.size
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertEquals(first, api.baseCalls.size)
        assertEquals(first, r.cachedCells)
    }

    @Test
    fun 스냅샷은_네트워크_없이_받아_둔_칸을_돌려준다() {
        val r = repo()
        assertTrue(r.snapshot(vp, true, false).base.isEmpty())
        r.requestViewport(vp, true, false)
        timer.advance(400)
        val calls = api.baseCalls.size
        val s = r.snapshot(vp, true, false)
        assertTrue(s.base.isNotEmpty())
        assertEquals(14, s.z)
        assertEquals(calls, api.baseCalls.size)
        // 도로 레이어를 끄면 바탕이 빈다
        assertTrue(r.snapshot(vp, false, false).base.isEmpty())
    }

    @Test
    fun 차량_ID가_없으면_받지_않고_생기면_다음_요청에서_받는다() {
        vehicle = null
        val r = repo()
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertTrue(api.baseCalls.isEmpty())
        vehicle = "v1"
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertTrue(api.baseCalls.isNotEmpty())
    }

    @Test
    fun 실패한_칸은_15초_동안_다시_묻지_않고_그_뒤에는_다시_받는다() {
        api.failBase = true
        val r = repo()
        r.requestViewport(vp, true, false)
        timer.advance(400)
        val failed = api.baseCalls.size
        assertTrue(failed > 0)
        assertEquals(0, r.cachedCells)
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertEquals(failed, api.baseCalls.size) // 백오프 중
        api.failBase = false
        timer.advance(15_000)
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertTrue(api.baseCalls.size > failed)
        assertTrue(r.cachedCells > 0)
    }

    @Test
    fun 캐시는_최근_사용_순으로_상한을_넘으면_오래된_칸을_버린다() {
        val r = repo(maxCells = 3)
        // 서로 멀리 떨어진 보기 5곳(각 한두 칸)
        for (i in 0 until 5) {
            r.requestViewport(Viewport(120.0 + i * 3, 36.0, 14.0, 300, 300), true, false)
            timer.advance(400)
        }
        assertEquals(3, r.cachedCells)
    }

    @Test
    fun 무효화하면_캐시를_비우고_진행_중_응답은_버리고_변경을_알린다() {
        val r = repo()
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertTrue(r.cachedCells > 0)
        val before = changes
        r.invalidate()
        assertEquals(0, r.cachedCells)
        assertTrue(changes > before)
        assertTrue(r.snapshot(vp, true, false).base.isEmpty()) // 이전 묶음도 비웠다
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertTrue(r.cachedCells > 0) // 다시 받는다
    }

    @Test
    fun 무효화_뒤에_도착한_옛_응답은_캐시에_넣지_않는다() {
        // 응답이 늦게 오는 상황: 실행기가 작업을 쥐고 있다가 나중에 돌린다
        val held = ArrayList<Runnable>()
        val r = MapRepository(api, { held.add(it) }, { vehicle }, timer::schedule, { timer.now })
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertTrue(held.isNotEmpty())
        r.invalidate()
        held.toList().forEach { it.run() }
        assertEquals(0, r.cachedCells)
    }

    @Test
    fun 시군구_칸은_코드로_합쳐_돌려준다() {
        val r = repo()
        r.requestViewport(vp, false, true)
        timer.advance(400)
        assertTrue(api.regionCalls.isNotEmpty())
        val s = r.snapshot(vp, false, true)
        assertTrue(s.regions.isNotEmpty())
        assertEquals(s.regions.size, s.regions.map { it.code }.toSet().size)
        assertTrue(r.snapshot(vp, false, false).regions.isEmpty())
    }

    // 잠정 색칠 폴링 ---------------------------------------------------------------

    private fun poller(r: MapRepository, trip: () -> String?) = LivePoller(api, direct, trip, timer::schedule, r, { timer.now }, intervalMs = 20_000, warmupMs = 5_000)

    @Test
    fun 폴링은_켜면_바로_한_번_묻고_처음에는_5초_간격으로_묻는다() {
        val r = repo()
        val p = poller(r) { "t1" }
        p.start()
        assertEquals(1, api.liveCalls)
        assertEquals("ready", r.live.status)
        timer.advance(5_000)
        assertEquals(2, api.liveCalls)
        p.stop()
    }

    @Test
    fun 길이_잡히면_20초_간격으로_물어본다() {
        val r = repo()
        api.live = LiveState("ready", 3, listOf(LiveWay(1, doubleArrayOf(0.5, 0.6), doubleArrayOf(0.5, 0.5), true)), null, 0L)
        val p = poller(r) { "t1" }
        p.start()
        assertEquals(1, api.liveCalls)
        timer.advance(19_000)
        assertEquals(1, api.liveCalls)
        timer.advance(1_000)
        assertEquals(2, api.liveCalls)
        assertEquals(1, r.live.ways.size)
        p.stop()
    }

    @Test
    fun 폴링은_트립_ID가_없으면_묻지_않고_끄면_멈춘다() {
        val r = repo()
        var trip: String? = null
        val p = poller(r) { trip }
        p.start()
        timer.advance(60_000)
        assertEquals(0, api.liveCalls)
        trip = "t1"
        timer.advance(10_000)
        assertTrue(api.liveCalls > 0)
        val n = api.liveCalls
        p.stop()
        timer.advance(120_000)
        assertEquals(n, api.liveCalls)
        assertEquals(0, timer.pending)
    }

    @Test
    fun 서버가_트립을_모르면_결과를_바꾸지_않고_지우면_비운다() {
        val r = repo()
        api.live = null
        val p = poller(r) { "t1" }
        p.start()
        assertEquals(LiveState.EMPTY, r.live)
        api.live = LiveState("ready", 4, emptyList(), LiveRegion("11140", "서울 중구", 0, true), 0L)
        timer.advance(5_000)
        assertEquals("서울 중구", r.live.region?.displayName)
        p.clear()
        assertNull(r.live.region)
        assertFalse(r.live.ways.isNotEmpty())
        p.stop()
    }
}
