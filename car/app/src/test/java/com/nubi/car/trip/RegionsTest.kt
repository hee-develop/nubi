package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.Executor

class RegionsTest {
    private val dexFmt = "시군구 {%1\$d/%2\$d}"
    private val depopFmt = "인구감소지역 {%1\$d/%2\$d}"
    private val newFmt = "처음 지난 곳: %1\$s"
    private val visitFmt = "%1\$s 방문"
    private val stayFmt = "%1\$s에서 하룻밤"
    private val direct = Executor { it.run() }

    @Test
    fun 도감은_시군구와_인구감소지역_두_줄이다() {
        assertEquals("시군구 {2/229}", formatRegionsDex(RegionsSummary(2, 229, 0, 92), dexFmt))
        assertEquals("인구감소지역 {0/92}", formatRegionsDepop(RegionsSummary(2, 229, 0, 92), depopFmt))
        assertEquals("시군구 {31/229}", formatRegionsDex(RegionsSummary(31, 229, 12, 92), dexFmt))
        assertEquals("인구감소지역 {12/92}", formatRegionsDepop(RegionsSummary(31, 229, 12, 92), depopFmt))
        assertNull(formatRegionsDex(null, dexFmt))
        assertNull(formatRegionsDepop(null, depopFmt))
    }

    @Test
    fun 처음_지난_곳은_최대_3개() {
        assertEquals("처음 지난 곳: 종로구", formatNewRegions(listOf("종로구"), newFmt))
        assertEquals("처음 지난 곳: 종로구, 중구", formatNewRegions(listOf("종로구", "중구"), newFmt))
        assertEquals("처음 지난 곳: 가, 나, 다", formatNewRegions(listOf("가", "나", "다", "라"), newFmt))
        assertNull(formatNewRegions(emptyList(), newFmt))
    }

    @Test
    fun 마지막_이벤트는_24시간_안일_때만_방문_숙박_문구로_보인다() {
        val at = 1_000_000_000_000L
        val h = 3_600_000L
        assertEquals("중구 방문", formatRegionEvent(RegionEvent("visit", "중구", at), at + h, visitFmt, stayFmt))
        assertEquals("홍천군에서 하룻밤", formatRegionEvent(RegionEvent("stay", "홍천군", at), at + 23 * h, visitFmt, stayFmt))
        assertNull("24시간이 지나면 숨김", formatRegionEvent(RegionEvent("visit", "중구", at), at + 24 * h, visitFmt, stayFmt))
        assertNull(formatRegionEvent(null, at, visitFmt, stayFmt))
        assertNull("모르는 종류는 숨김", formatRegionEvent(RegionEvent("pass", "중구", at), at, visitFmt, stayFmt))
    }

    @Test
    fun 서버_응답을_읽고_캐시_문자열로_왕복한다() {
        val json = """{"total":229,"colored":2,"byLevel":{"1":1,"2":1,"3":0},"depop":{"total":92,"colored":0,"total89":89,"colored89":0},
            "lastEvent":{"kind":"visit","code":"11140","name":"중구","sidoName":"서울특별시","at":"2026-11-09T01:00:00.000Z","tripId":"t"},"attribution":"x"}"""
        val s = RegionsSummary.fromJson(json)
        assertEquals(RegionsSummary(2, 229, 0, 92, RegionEvent("visit", "중구", 1_794_186_000_000L)), s)
        assertEquals(s, RegionsSummary.decode(s.encode()))
        val none = RegionsSummary.fromJson("""{"total":229,"colored":0,"depop":{"total":92,"colored":0},"lastEvent":null}""")
        assertNull(none.lastEvent)
        assertEquals(none, RegionsSummary.decode(none.encode()))
        assertNull(RegionsSummary.decode("broken"))
        assertNull("버전 키가 없는 옛(분모 89) 캐시는 버린다", RegionsSummary.decode("2|229|1|89||"+"|0"))
        assertNull("다른 버전도 버린다", RegionsSummary.decode("v1|2|229|1|92||"+"|0"))
        assertNull(RegionsSummary.decode(null))
    }

    private class Api(var summary: () -> RegionsSummary?, val matching: MatchingResponse? = null) : CoverageApi {
        var regionCalls = 0
        override fun getMatching(tripId: String): MatchingResponse? = matching
        override fun getNationalPercent(vehicleId: String): Double = 1.0
        override fun getRegions(vehicleId: String): RegionsSummary? {
            regionCalls++
            return summary()
        }
    }

    private fun tracker(api: CoverageApi, store: KeyValueStore? = null) =
        CoverageTracker(api, direct, { "v" }, MatchingPoller(api, {}, 3_000, 60_000, { 0L }), schedule = { _, _ -> }, cache = store)

    @Test
    fun 서비스_시작_때_도감을_받아_캐시하고_실패해도_저장값이_남는다() {
        val store = MapStore()
        val api = Api({ RegionsSummary(2, 229, 1, 92) })
        val t = tracker(api, store)
        assertNull(t.regions)
        t.refreshRegions()
        assertEquals(RegionsSummary(2, 229, 1, 92), t.regions)
        // 다시 뜬 프로세스: 서버가 죽어 있어도 저장값이 보인다. 실패하면 30초 뒤 1회만 다시 시도한다(2번 호출).
        val down = Api({ throw IOException("down") })
        val queued = mutableListOf<() -> Unit>()
        val t2 = CoverageTracker(down, direct, { "v" }, MatchingPoller(down, {}, 3_000, 60_000, { 0L }), { _, b -> queued += b }, store)
        assertEquals(RegionsSummary(2, 229, 1, 92), t2.regions)
        t2.refreshRegions()
        assertEquals(1, down.regionCalls)
        queued.toList().also { queued.clear() }.forEach { it() }
        assertEquals(2, down.regionCalls)
        assertEquals(RegionsSummary(2, 229, 1, 92), t2.regions)
    }

    @Test
    fun 종료_결과의_처음_지난_곳은_매칭이_집계하지_않아도_보이고_끝나면_도감을_다시_받는다() {
        val matching = MatchingResponse("done", null, "skipped", "too_short", 0.0, 0.0, 0.0, listOf("종로구", "중구"))
        var n = 0
        val api = Api({ RegionsSummary(++n, 229, 0, 92) }, matching)
        val t = tracker(api)
        t.onTripEnded("t1")
        assertEquals(listOf("종로구", "중구"), t.newRegions)
        assertEquals("매칭 뒤 도감 재조회", 1, api.regionCalls)
        assertEquals(1, t.regions!!.colored)
        t.onTripStarted()
        assertTrue("새 트립이 시작되면 종료 줄을 치운다", t.newRegions.isEmpty())
    }
}
