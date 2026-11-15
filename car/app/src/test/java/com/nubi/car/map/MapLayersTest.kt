package com.nubi.car.map

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class MapLayersTest {
    private val now = Instant.parse("2026-11-11T12:00:00Z").toEpochMilli()
    private val day = 86_400_000L

    private fun way(drivenAt: Long, cls: Int = CLS_SC) = MapWay(1, cls, doubleArrayOf(0.5, 0.6), doubleArrayOf(0.5, 0.6), drivenAt, 1.0)

    @Test
    fun 바램은_마지막_인정이_365일을_넘어야_한다() {
        assertFalse(isFaded(now - 365 * day, now)) // 정확히 365일은 아직
        assertTrue(isFaded(now - 365 * day - 1, now))
        assertFalse(isFaded(now - 30 * day, now))
        assertTrue(isFaded(now - 400 * day, now, days = 365))
        assertTrue(isFaded(now - 11 * day, now, days = 10)) // 기준일은 바꿀 수 있다
    }

    @Test
    fun 바탕_way의_색_구분() {
        assertEquals(WayStyle.UNDRIVEN, wayStyle(way(0), now))
        assertEquals(WayStyle.DRIVEN, wayStyle(way(now - 10 * day), now))
        assertEquals(WayStyle.FADED, wayStyle(way(now - 366 * day), now))
        // 바램은 debug 시계(now)를 따른다: 시계를 2년 뒤로 옮기면 바랜다
        assertEquals(WayStyle.FADED, wayStyle(way(now - 10 * day), now + 2 * 365 * day))
    }

    @Test
    fun 잠정_way는_처음_달린_길만_굵은_밝은_앰버이고_다시_달린_길은_달린_길_색이다() {
        assertEquals(WayStyle.LIVE_NEW, liveStyle(true))
        assertEquals(WayStyle.DRIVEN, liveStyle(false))
        assertEquals(0xFFFBBF24.toInt(), colorOf(WayStyle.LIVE_NEW))
        assertEquals(0xFFF59E0B.toInt(), colorOf(WayStyle.DRIVEN))
        assertEquals(0xFF2A3544.toInt(), colorOf(WayStyle.UNDRIVEN))
        assertEquals(UNDRIVEN_FAR, colorOf(WayStyle.UNDRIVEN, 7.5)) // 전국 보기에서는 안 간 길을 조금 밝게
        assertEquals(0xFF2A3544.toInt(), colorOf(WayStyle.UNDRIVEN, FAR_ZOOM))
        assertEquals(0xFFC79A4C.toInt(), colorOf(WayStyle.FADED))
    }

    @Test
    fun 굵기는_안_간_길이_가장_가늘고_잠정_새_길이_가장_굵다() {
        for (zoom in listOf(7.0, 10.0, 12.0, 14.0)) {
            for (cls in CLS_MW..CLS_MN) {
                val un = strokeDp(cls, WayStyle.UNDRIVEN, zoom)
                val dr = strokeDp(cls, WayStyle.DRIVEN, zoom)
                val nw = strokeDp(cls, WayStyle.LIVE_NEW, zoom)
                assertTrue("z$zoom cls$cls", un < dr && dr < nw)
            }
        }
        assertTrue(strokeDp(CLS_MW, WayStyle.UNDRIVEN, 14.0) > strokeDp(CLS_MN, WayStyle.UNDRIVEN, 14.0))
        assertTrue(strokeDp(CLS_SC, WayStyle.UNDRIVEN, 14.0) > strokeDp(CLS_SC, WayStyle.UNDRIVEN, 7.0))
    }

    @Test
    fun z별로_그리는_등급은_계약서와_같다() {
        assertEquals(CLS_MW, maxVisibleCls(8))
        assertEquals(CLS_PR, maxVisibleCls(9))
        assertEquals(CLS_PR, maxVisibleCls(10))
        assertEquals(CLS_SC, maxVisibleCls(11))
        assertEquals(CLS_SC, maxVisibleCls(12))
        assertEquals(CLS_MN, maxVisibleCls(13))
        assertEquals(CLS_MN, maxVisibleCls(16))
    }

    @Test
    fun 시군구_칠은_단계가_높을수록_진하고_바랜_곳은_채도를_낮춘다() {
        fun alpha(c: Int) = (c ushr 24) and 0xFF
        val l1 = regionFill(1, false, false)
        val l2 = regionFill(2, false, false)
        val l3 = regionFill(3, false, false)
        assertTrue(alpha(l1) < alpha(l2) && alpha(l2) < alpha(l3))
        assertEquals(0xF59E0B, l2 and 0xFFFFFF)
        // 바램: 같은 농도에 채도 낮은 색
        assertEquals(alpha(l2), alpha(regionFill(2, false, true)))
        assertEquals(0xC79A4C, regionFill(2, false, true) and 0xFFFFFF)
        assertNotEquals(l2, regionFill(2, false, true))
        // 안 간 곳: 인구감소지역만 청록 바탕, 일반 지역은 칠하지 않는다
        assertEquals(0xFF1C323A.toInt(), regionFill(0, true, false))
        assertEquals(0, regionFill(0, false, false))
        // 가 본 인구감소지역은 단계 색(청록 바탕이 아니다)
        assertEquals(l1, regionFill(1, true, false))
        // 범위 밖 단계는 3으로 맞춘다
        assertEquals(l3, regionFill(9, false, false))
    }

    private fun cell(ix: Int, n: Int = 1) = BaseCell(CellKey(14, ix, 0), List(n) { way(0) }, false)

    @Test
    fun 칸이_다_도착하면_그_칸만_그리고_일부만_왔으면_이전_묶음을_밑에_깐다() {
        val needed = listOf(CellKey(14, 0, 0), CellKey(14, 1, 0))
        val prev = listOf(cell(5), cell(0))
        val loaded = mapOf(CellKey(14, 0, 0) to cell(0, 2))
        val (partial, complete) = selectCells(needed, loaded, prev)
        assertFalse(complete)
        // 이전 묶음의 칸 5는 남고, 이미 도착한 칸 0은 새 것으로 덮인다(중복 없음)
        assertEquals(listOf(5, 0), partial.map { it.key.ix })
        assertEquals(2, partial.last().ways.size)

        val all = loaded + (CellKey(14, 1, 0) to cell(1))
        val (full, ok) = selectCells(needed, all, prev)
        assertTrue(ok)
        assertEquals(listOf(0, 1), full.map { it.key.ix })

        // 아무것도 안 왔으면 이전 묶음 그대로
        val (stale, none) = selectCells(needed, emptyMap(), prev)
        assertFalse(none)
        assertEquals(prev.map { it.key }, stale.map { it.key })
    }

    @Test
    fun 시군구는_코드로_합치고_먼저_나온_것을_쓴다() {
        fun r(code: String, level: Int) = RegionShape(code, code, level, false, false, listOf(doubleArrayOf(0.5, 0.6, 0.5)), listOf(doubleArrayOf(0.5, 0.5, 0.6)))
        val a = RegionCell(RegionCellKey(6, 0, 0), listOf(r("11110", 1), r("11140", 2)))
        val b = RegionCell(RegionCellKey(6, 1, 0), listOf(r("11140", 3), r("26110", 0)))
        val merged = mergeRegions(listOf(a, b))
        assertEquals(listOf("11110", "11140", "26110"), merged.map { it.code })
        assertEquals(2, merged[1].level)
    }
}
