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
    val liveSinces = ArrayList<Long>()
    var failBase = false
    var live: LiveState? = LiveState("ready", 1, emptyList(), null, 0L)
    var bigWays = 1

    override fun getBase(key: CellKey, vehicleId: String): BaseCell {
        baseCalls.add(key)
        if (failBase) throw java.io.IOException("x")
        val n = bigWays
        return BaseCell(key, List(n) { MapWay(key.ix * 1000L + it, CLS_MW, doubleArrayOf(0.5, 0.6), doubleArrayOf(0.5, 0.5), 0L, 0.0) }, false)
    }

    override fun getRegions(key: RegionCellKey, vehicleId: String): RegionCell {
        regionCalls.add(key)
        return RegionCell(key, listOf(RegionShape("c${key.ix}", "n", 1, false, false, listOf(doubleArrayOf(0.5, 0.6, 0.5)), listOf(doubleArrayOf(0.5, 0.5, 0.6)))))
    }

    override fun getLive(tripId: String, since: Long, nowMs: Long): LiveState? {
        liveCalls++
        liveSinces.add(since)
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

    private fun repo(maxCells: Int = 80, maxPoints: Int = 600_000) = MapRepository(api, direct, { vehicle }, timer::schedule, { timer.now }, maxCells = maxCells, maxPoints = maxPoints).also { it.onChange = { changes++ } }

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

    // 복구·상태·상한 -----------------------------------------------------------------

    @Test
    fun 무효화_뒤에는_화면을_움직이지_않아도_마지막_뷰포트를_다시_받는다() {
        val r = repo()
        r.requestViewport(vp, true, false)
        timer.advance(400)
        val first = api.baseCalls.size
        r.invalidate()
        timer.advance(400)
        assertTrue(api.baseCalls.size > first)
        assertTrue(r.cachedCells > 0)
        assertTrue(r.snapshot(vp, true, false).base.isNotEmpty())
    }

    @Test
    fun 실패_백오프가_끝나면_화면을_움직이지_않아도_스스로_다시_받는다() {
        api.failBase = true
        val r = repo()
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertEquals(0, r.cachedCells)
        api.failBase = false
        timer.advance(15_500) // 백오프 15초가 지나면 재시도가 걸려 있다
        assertTrue(r.cachedCells > 0)
    }

    @Test
    fun 차량_ID가_나중에_생기면_화면을_움직이지_않아도_받는다() {
        vehicle = null
        val r = repo()
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertTrue(api.baseCalls.isEmpty())
        assertEquals(MapLoad.NO_VEHICLE, r.snapshot(vp, true, false).load)
        vehicle = "v1"
        timer.advance(2_500)
        assertTrue(r.cachedCells > 0)
        assertEquals(MapLoad.OK, r.snapshot(vp, true, false).load)
    }

    @Test
    fun 상태는_받는_중_실패_정상을_구분한다() {
        val held = ArrayList<Runnable>()
        val r = MapRepository(api, { held.add(it) }, { vehicle }, timer::schedule, { timer.now })
        r.requestViewport(vp, true, false)
        timer.advance(400)
        assertEquals(MapLoad.LOADING, r.snapshot(vp, true, false).load) // 요청 중
        api.failBase = true
        held.toList().forEach { it.run() }
        assertEquals(MapLoad.FAILED, r.snapshot(vp, true, false).load) // 모두 실패
        assertEquals(MapLoad.OK, r.snapshot(vp, false, false).load) // 도로 레이어를 끄면 해당 없음
        api.failBase = false
        timer.advance(15_500)
        held.toList().forEach { it.run() }
        assertEquals(MapLoad.OK, r.snapshot(vp, true, false).load)
    }

    @Test
    fun 좌표_수_상한을_넘으면_현재_z가_아닌_칸부터_내보내고_직전_묶음도_비운다() {
        api.bigWays = 3 // 칸마다 좌표 6개
        val r = repo(maxCells = 100, maxPoints = 14)
        val other = Viewport(127.0, 37.5, 12.0, 300, 300) // z12 칸
        r.requestViewport(other, true, false)
        timer.advance(400)
        val z12 = r.cachedCells
        assertTrue(z12 > 0)
        r.snapshot(other, true, false) // 직전 묶음으로 잡힘
        val here = Viewport(127.0, 37.5, 14.0, 300, 300)
        r.requestViewport(here, true, false)
        timer.advance(400)
        assertTrue(r.cachedPoints <= 14 + 6) // 상한 근처(마지막 칸 하나 정도 넘을 수 있음)
        val keys = r.snapshot(here, true, false).base.map { it.key.z }
        assertTrue(keys.all { it == 14 } || keys.isEmpty() || keys.contains(14))
        // 내보낸 z12 칸이 직전 묶음에 남아 메모리를 붙잡지 않는다
        val z12Left = r.snapshot(other, true, false).base.count { it.key.z == 12 }
        assertTrue(z12Left < z12)
    }

    @Test
    fun 시군구_캐시도_상한이_있다() {
        val r = MapRepository(api, direct, { vehicle }, timer::schedule, { timer.now }, maxRegionCells = 2)
        for (i in 0 until 5) {
            r.requestViewport(Viewport(120.0 + i * 3, 36.0, 12.0, 300, 300), false, true)
            timer.advance(400)
        }
        assertEquals(2, r.cachedRegionCells)
    }

    // 잠정 색칠 폴링 ---------------------------------------------------------------

    private fun poller(r: MapRepository, trip: () -> String?) = LivePoller(api, direct, trip, timer::schedule, r, { timer.now }, intervalMs = 20_000, kickDelayMs = 2_000, maxWays = 5)

    @Test
    fun 폴링은_켜면_바로_한_번_묻고_20초_간격으로_묻는다() {
        val r = repo()
        val p = poller(r) { "t1" }
        p.start()
        assertEquals(1, api.liveCalls)
        assertEquals("ready", r.live.status)
        timer.advance(19_000)
        assertEquals(1, api.liveCalls)
        timer.advance(1_000)
        assertEquals(2, api.liveCalls)
        p.stop()
    }

    private fun lw(id: Long, isNew: Boolean = true) = LiveWay(id, doubleArrayOf(0.5, 0.6), doubleArrayOf(0.5, 0.5), isNew)

    @Test
    fun 증분_응답은_누적하고_cursor를_다음_since로_보낸다() {
        val r = repo()
        api.live = LiveState("ready", 3, listOf(lw(1), lw(2)), null, 0L, cursor = 2)
        val p = poller(r) { "t1" }
        p.start()
        assertEquals(listOf(0L), api.liveSinces)
        assertEquals(2, r.live.ways.size)
        api.live = LiveState("ready", 9, listOf(lw(3)), null, 0L, cursor = 3)
        timer.advance(20_000)
        assertEquals(listOf(0L, 2L), api.liveSinces)
        assertEquals(listOf(1L, 2L, 3L), r.live.ways.map { it.id })
        assertEquals(9, r.live.upToSeq)
        assertEquals(3L, r.live.cursor)
        p.stop()
    }

    @Test
    fun 누적은_상한을_넘으면_오래된_way부터_버리고_트립이_바뀌면_비운다() {
        val r = repo()
        var trip = "t1"
        api.live = LiveState("ready", 1, (1L..4L).map { lw(it) }, null, 0L, cursor = 4)
        val p = poller(r) { trip }
        p.start()
        api.live = LiveState("ready", 2, (5L..7L).map { lw(it) }, null, 0L, cursor = 7)
        timer.advance(20_000)
        assertEquals(listOf(3L, 4L, 5L, 6L, 7L), r.live.ways.map { it.id }) // 상한 5, 최신 쪽 유지
        trip = "t2"
        api.live = LiveState("ready", 1, listOf(lw(100)), null, 0L, cursor = 1)
        timer.advance(20_000)
        assertEquals(0L, api.liveSinces.last()) // 새 트립은 처음부터
        assertEquals(listOf(100L), r.live.ways.map { it.id })
        p.stop()
    }

    @Test
    fun 업로드_직후_kick은_2초_뒤_한_번_더_묻고_꺼져_있으면_무시한다() {
        val r = repo()
        val p = poller(r) { "t1" }
        p.kick() // 꺼져 있음
        timer.advance(5_000)
        assertEquals(0, api.liveCalls)
        p.start()
        assertEquals(1, api.liveCalls)
        timer.advance(1_000)
        p.kick()
        timer.advance(1_900)
        assertEquals(1, api.liveCalls)
        timer.advance(200)
        assertEquals(2, api.liveCalls)
        p.stop()
    }

    @Test
    fun 정지_직후_다시_시작해도_옛_루프가_되살아나지_않는다() {
        val r = repo()
        val p = poller(r) { "t1" }
        p.start()
        p.stop()
        p.start()
        assertEquals(2, api.liveCalls)
        timer.advance(20_000)
        assertEquals(3, api.liveCalls) // 루프 하나만 돈다
        timer.advance(20_000)
        assertEquals(4, api.liveCalls)
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
        timer.advance(20_000)
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
        timer.advance(20_000)
        assertEquals("서울 중구", r.live.region?.displayName)
        p.clear()
        assertNull(r.live.region)
        assertFalse(r.live.ways.isNotEmpty())
        p.stop()
    }
}
