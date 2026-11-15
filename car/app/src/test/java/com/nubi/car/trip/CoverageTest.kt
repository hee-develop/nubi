package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.Executor

class CoverageTest {
    private val counted = "새 도로 %1\$skm · 전국 %2\$s%% (+%3\$s)"
    private val notCounted = "이번 주행은 집계되지 않았어요"
    private val withReason = "이번 주행은 집계되지 않았어요 (%1\$s)"

    private fun line(l: MatchingLine, debug: Boolean = false) = formatMatchingLine(l, counted, notCounted, withReason, debug)

    private fun done(outcome: String, reason: String? = null, newKm: Double = 0.0, before: Double = 0.0, after: Double = 0.0) =
        MatchingResponse("done", null, outcome, reason, newKm, before, after)

    private fun waiting(status: String, error: String? = null) = MatchingResponse(status, error, null, null, 0.0, 0.0, 0.0)

    /** 호출마다 미리 정한 응답(또는 null=404, 예외)을 순서대로 돌려주는 가짜 서버. */
    private class FakeApi(private val script: List<() -> MatchingResponse?>, private val percent: () -> Double = { 1.0 }) : CoverageApi {
        var calls = 0
        var regionCalls = 0
        override fun getMatching(tripId: String): MatchingResponse? = script[minOf(calls++, script.size - 1)]()
        override fun getNationalPercent(vehicleId: String): Double = percent()
        override fun getRegions(vehicleId: String): RegionsSummary? {
            regionCalls++
            return null
        }
    }

    /** 가짜 시계: sleep이 시계를 그만큼 흘리고, 가짜 서버 호출은 [latencyMs]만큼 걸린다. */
    private class FakeTime(var now: Long = 0L)

    private fun poller(api: CoverageApi, sleeps: MutableList<Long> = mutableListOf(), time: FakeTime = FakeTime()) =
        MatchingPoller(api, { sleeps += it; time.now += it }, 3_000, 60_000, { time.now })

    // 문자열 -------------------------------------------------------------

    @Test
    fun 집계되면_새_도로와_전국_완료율_증가분을_보인다() {
        assertEquals("새 도로 1.4km · 전국 0.0011% (+0.0011)", line(MatchingLine.Counted(1.4, 0.0011, 0.0011)))
        assertEquals("새 도로 12.0km · 전국 1.25% (+0.100)", line(MatchingLine.Counted(12.0, 1.25, 0.1)))
        assertEquals("새 도로 0.0km · 전국 0.250% (+0.0000)", line(MatchingLine.Counted(0.04, 0.25, 0.0)))
    }

    @Test
    fun 집계되지_않으면_사유는_debug에서만_괄호로_보인다() {
        val l = MatchingLine.NotCounted("odometer_mismatch")
        assertEquals("이번 주행은 집계되지 않았어요", line(l, debug = false))
        assertEquals("이번 주행은 집계되지 않았어요 (odometer_mismatch)", line(l, debug = true))
    }

    @Test
    fun 아직_결과가_없으면_줄이_없다() {
        assertNull(line(MatchingLine.None))
        assertNull(line(MatchingLine.None, debug = true))
    }

    @Test
    fun 대기_화면_한_줄은_값이_있을_때만_만든다() {
        assertEquals("전국 0.0123% 달렸어요", formatNationalLine(0.0123, "전국 %1\$s%% 달렸어요"))
        assertEquals("전국 12.50% 달렸어요", formatNationalLine(12.5, "전국 %1\$s%% 달렸어요"))
        assertNull(formatNationalLine(null, "전국 %1\$s%% 달렸어요"))
    }

    // 폴링 상태 전이 -------------------------------------------------------

    @Test
    fun queued_running을_거쳐_done이면_3초_간격으로_기다린_뒤_결과를_돌려준다() {
        val sleeps = mutableListOf<Long>()
        val api = FakeApi(listOf({ waiting("queued") }, { waiting("running") }, { done("counted", newKm = 1.5, before = 0.01, after = 0.02) }))
        val result = poller(api, sleeps).poll("t1")
        assertEquals(MatchingLine.Counted(1.5, 0.02, 0.02 - 0.01), result)
        assertEquals(3, api.calls)
        assertEquals(listOf(3_000L, 3_000L), sleeps)
    }

    @Test
    fun 서버가_아직_트립을_모르면_404_계속_기다린다() {
        val api = FakeApi(listOf({ null }, { null }, { done("counted", newKm = 1.0, after = 0.5) }))
        assertTrue(poller(api).poll("t1") is MatchingLine.Counted)
        assertEquals(3, api.calls)
    }

    @Test
    fun 네트워크_오류는_삼키고_계속_기다린다() {
        val api = FakeApi(listOf({ throw IOException("down") }, { throw HttpFailure(503, "x") }, { done("counted", newKm = 1.0, after = 0.5) }))
        assertTrue(poller(api).poll("t1") is MatchingLine.Counted)
    }

    @Test
    fun skipped_suspect_low_confidence는_집계되지_않음이고_사유를_담는다() {
        for ((outcome, reason) in listOf("skipped" to "too_short", "suspect" to "odometer_mismatch", "low_confidence" to "low_confidence")) {
            val api = FakeApi(listOf({ done(outcome, reason) }))
            assertEquals(MatchingLine.NotCounted(reason), poller(api).poll("t"))
            assertEquals(1, api.calls)
        }
    }

    @Test
    fun 영구_실패는_집계되지_않음_재시도_대기_실패는_계속_기다린다() {
        assertEquals(
            MatchingLine.NotCounted("permanent: valhalla HTTP 400"),
            poller(FakeApi(listOf({ waiting("failed", "permanent: valhalla HTTP 400") }))).poll("t"),
        )
        val api = FakeApi(listOf({ waiting("failed", "retryable: network") }, { done("counted", newKm = 2.0, after = 1.0) }))
        assertTrue(poller(api).poll("t") is MatchingLine.Counted)
        assertEquals(2, api.calls)
    }

    @Test
    fun 제한_60초_동안_끝나지_않으면_20번만_묻고_줄을_보이지_않는다() {
        val sleeps = mutableListOf<Long>()
        val api = FakeApi(listOf({ waiting("running") }))
        assertEquals(MatchingLine.None, poller(api, sleeps).poll("t"))
        assertEquals(20, api.calls)
        assertEquals(19, sleeps.size)
        assertEquals(57_000L, sleeps.sum())
    }

    @Test
    fun 마감은_시도_횟수가_아니라_시작_시각_기준이라_요청이_느려도_60초를_넘기지_않는다() {
        val time = FakeTime()
        // 요청마다 4초가 걸린다: 시도 횟수 기준(20번)이면 140초가 걸리지만 시작 시각 기준이면 60초 안에 끝난다.
        val api = FakeApi(listOf({ time.now += 4_000; waiting("running") }))
        val sleeps = mutableListOf<Long>()
        assertEquals(MatchingLine.None, poller(api, sleeps, time).poll("t"))
        assertEquals(9, api.calls) // 시작 0·7·14·…·56초
        assertTrue("총 ${time.now}ms", time.now <= 60_000L)
    }

    @Test
    fun 마감_직전에_끝난_결과는_받는다() {
        val time = FakeTime()
        var n = 0
        val api = FakeApi(listOf({ time.now += 1_000; if (++n < 14) waiting("running") else done("counted", newKm = 1.0, after = 0.5) }))
        assertTrue(poller(api, time = time).poll("t") is MatchingLine.Counted)
        assertTrue(time.now <= 60_000L)
    }

    @Test
    fun 취소되면_바로_멈춘다() {
        val api = FakeApi(listOf({ waiting("running") }))
        assertEquals(MatchingLine.None, poller(api).poll("t") { true })
        assertEquals(0, api.calls)
    }

    // 상태 보관(트래커) ----------------------------------------------------

    private val direct = Executor { it.run() }

    /** 예약을 모아 두었다가 [runAll]로 한 번에 돌리는 가짜 타이머. */
    private class FakeTimer {
        val delays = mutableListOf<Long>()
        private val pending = mutableListOf<() -> Unit>()
        fun schedule(delay: Long, block: () -> Unit) {
            delays += delay
            pending += block
        }
        fun runAll() {
            val now = pending.toList()
            pending.clear()
            now.forEach { it() }
        }
    }

    @Test
    fun 트래커는_종료_알림을_받으면_결과와_전국_완료율을_갱신한다() {
        val api = FakeApi(listOf({ done("counted", newKm = 1.2, before = 0.0, after = 0.0011) }))
        val t = CoverageTracker(api, direct, { "v" }, poller(api))
        assertEquals(MatchingLine.None, t.matching)
        t.onTripEnded("t1")
        assertEquals(MatchingLine.Counted(1.2, 0.0011, 0.0011), t.matching)
        assertEquals(0.0011, t.nationalPercent!!, 1e-9)
        t.clear()
        assertEquals(MatchingLine.None, t.matching)
    }

    @Test
    fun 전국_완료율은_차량_ID를_기다렸다_1회_받고_실패하면_값이_없다() {
        var id: String? = null
        val timer = FakeTimer()
        val api = FakeApi(listOf({ null }), { 3.5 })
        val t = CoverageTracker(api, direct, { id }, poller(api), timer::schedule)
        t.refreshNational()
        assertEquals("ID가 없으면 예약만 하고 executor를 붙잡지 않는다", listOf(1_000L), timer.delays)
        timer.runAll()
        id = "v"
        timer.runAll()
        assertEquals(3.5, t.nationalPercent!!, 1e-9)

        val failing = object : CoverageApi {
            override fun getMatching(tripId: String): MatchingResponse? = null
            override fun getNationalPercent(vehicleId: String): Double = throw IOException("down")
        }
        val t2 = CoverageTracker(failing, direct, { "v" }, poller(failing))
        t2.refreshNational() // 예외가 밖으로 새면 안 된다
        assertNull(t2.nationalPercent)
    }

    // 전국 완료율 캐시·재시도 -------------------------------------------------

    @Test
    fun 전국_완료율은_성공한_마지막_값을_저장해_다음_실행이나_실패_때도_보인다() {
        val store = MapStore()
        val ok = FakeApi(listOf({ null }), { 0.0123 })
        val first = CoverageTracker(ok, direct, { "v" }, poller(ok), cache = store, schedule = { _, _ -> })
        assertNull(first.nationalPercent)
        first.refreshNational()
        assertEquals(0.0123, first.nationalPercent!!, 1e-9)
        assertEquals("0.0123", store.getString("nationalPercent"))
        // 프로세스를 다시 띄운 것처럼 새 트래커: 서버가 죽어 있어도 저장값이 먼저 보인다
        val down = object : CoverageApi {
            override fun getMatching(tripId: String): MatchingResponse? = null
            override fun getNationalPercent(vehicleId: String): Double = throw IOException("down")
        }
        val second = CoverageTracker(down, direct, { "v" }, poller(down), cache = store, schedule = { _, _ -> })
        assertEquals(0.0123, second.nationalPercent!!, 1e-9)
        second.refreshNational()
        assertEquals("실패해도 저장값 유지", 0.0123, second.nationalPercent!!, 1e-9)
    }

    @Test
    fun 조회가_실패하면_30초_뒤_한_번만_다시_시도한다() {
        val timer = FakeTimer()
        var calls = 0
        val api = object : CoverageApi {
            override fun getMatching(tripId: String): MatchingResponse? = null
            override fun getNationalPercent(vehicleId: String): Double {
                calls++
                if (calls == 1) throw IOException("down")
                return 2.5
            }
        }
        val t = CoverageTracker(api, direct, { "v" }, poller(api), timer::schedule)
        t.refreshNational()
        assertEquals(1, calls)
        assertEquals(listOf(30_000L), timer.delays)
        timer.runAll()
        assertEquals(2, calls)
        assertEquals(2.5, t.nationalPercent!!, 1e-9)

        // 두 번 다 실패하면 더 시도하지 않는다
        calls = 0
        val failing = object : CoverageApi {
            override fun getMatching(tripId: String): MatchingResponse? = null
            override fun getNationalPercent(vehicleId: String): Double {
                calls++
                throw IOException("down")
            }
        }
        val timer2 = FakeTimer()
        val t2 = CoverageTracker(failing, direct, { "v" }, poller(failing), timer2::schedule)
        t2.refreshNational()
        timer2.runAll()
        timer2.runAll()
        assertEquals(2, calls)
        assertNull(t2.nationalPercent)
    }

    @Test
    fun 새_트립이_시작되면_이전_종료_줄을_치우고_진행_중인_폴링은_결과를_반영하지_못한다() {
        var tracker: CoverageTracker? = null
        // 폴링 도중(응답을 받는 순간) 새 트립이 시작된 상황
        val api = FakeApi(listOf({ tracker!!.onTripStarted(); done("counted", newKm = 1.0, after = 0.5) }), { 1.0 })
        tracker = CoverageTracker(api, direct, { "v" }, poller(api), schedule = { _, _ -> })
        tracker.onTripEnded("old")
        assertEquals("이전 트립 결과는 반영되지 않는다", MatchingLine.None, tracker.matching)
    }

    @Test
    fun 종료_줄이_떠_있다가_새_트립이_시작되면_사라진다() {
        val api = FakeApi(listOf({ done("counted", newKm = 1.0, after = 0.5) }), { 1.0 })
        val t = CoverageTracker(api, direct, { "v" }, poller(api), schedule = { _, _ -> })
        t.onTripEnded("t1")
        assertTrue(t.matching is MatchingLine.Counted)
        val before = api.regionCalls
        t.onTripStarted()
        assertEquals(MatchingLine.None, t.matching)
        assertEquals("새 트립 시작 때 시군구 도감도 다시 받는다", before + 1, api.regionCalls)
    }
}
