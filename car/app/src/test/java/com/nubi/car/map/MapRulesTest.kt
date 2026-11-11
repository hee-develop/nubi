package com.nubi.car.map

import com.nubi.car.FeatureFlags
import com.nubi.car.trip.NeighborLayout
import com.nubi.car.trip.neighborLayoutInMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MapRulesTest {
    @Test
    fun 플래그가_꺼지면_기존_화면이다() {
        assertEquals(MapMode.OFF, mapMode(false, parkedLayout = true))
        assertEquals(MapMode.OFF, mapMode(false, parkedLayout = false))
        assertEquals(MapMode.PARKED, mapMode(true, parkedLayout = true))
        assertEquals(MapMode.DRIVING, mapMode(true, parkedLayout = false))
    }

    @Test
    fun 지도는_정차이고_DO가_아닐_때만_만진다() {
        assertTrue(mapInteractive(MapMode.PARKED, distractionOptimized = false))
        assertFalse(mapInteractive(MapMode.PARKED, distractionOptimized = true)) // fail-closed
        assertFalse(mapInteractive(MapMode.DRIVING, distractionOptimized = false)) // 주행 중 터치 무시
        assertFalse(mapInteractive(MapMode.OFF, distractionOptimized = false))
    }

    @Test
    fun 주행_중_지역_문구는_시군구를_알_때만_있다() {
        assertEquals("· 서울 중구", drivingRegionText("서울 중구"))
        assertNull(drivingRegionText(null))
        assertNull(drivingRegionText("  "))
    }

    @Test
    fun 지금_시군구는_잠정_매칭의_마지막_점을_먼저_쓴다() {
        val live = LiveState("ready", 3, emptyList(), LiveRegion("11140", "서울 중구", 0, true), 1L)
        assertEquals("서울 중구", currentRegionName(live, "서울 종로구"))
        assertEquals("서울 종로구", currentRegionName(LiveState.EMPTY, "서울 종로구"))
        assertNull(currentRegionName(LiveState.EMPTY, null))
    }

    @Test
    fun 정차_지도의_이웃_카드는_패널_너비로_정한다() {
        assertEquals(NeighborLayout.HIDDEN, neighborLayoutInMap(false, false, 1000, 500))
        assertEquals(NeighborLayout.COMPACT, neighborLayoutInMap(true, true, 2000, 500)) // 좁은 앱 영역은 패널을 줄인다
        assertEquals(NeighborLayout.COMPACT, neighborLayoutInMap(true, false, 400, 500))
        assertEquals(NeighborLayout.FULL, neighborLayoutInMap(true, false, 900, 500))
        assertEquals(NeighborLayout.FULL, neighborLayoutInMap(true, false, 0, 500)) // 너비를 모르면 전체
    }

    @Test
    fun 디버그_요약에_Maestro가_쓰는_값이_다_있다() {
        val way = MapWay(1, CLS_MW, doubleArrayOf(0.5, 0.6), doubleArrayOf(0.5, 0.5), 1L, 1.0)
        val snap = MapSnapshot(
            listOf(BaseCell(CellKey(14, 0, 0), listOf(way, MapWay(2, CLS_MW, doubleArrayOf(0.5, 0.6), doubleArrayOf(0.5, 0.5), 0L, 0.0)), false)),
            emptyList(),
            LiveState("ready", 9, listOf(LiveWay(5, doubleArrayOf(0.5, 0.6), doubleArrayOf(0.5, 0.5), true), LiveWay(6, doubleArrayOf(0.5, 0.6), doubleArrayOf(0.5, 0.5), false)), null, 0L),
            14,
        )
        val d = debugSummary(snap, trailPoints = 7, roads = true, regions = false, zoom = 14.0, follow = true)
        assertEquals("지도 way=2 driven=1 live=2 new=1 trail=7 roads=on regions=off region=0 z=14.0 follow=on", d)
    }

    @Test
    fun 기능_플래그_기본값은_계약서_4장과_같다() {
        assertTrue(FeatureFlags.drivingMap)
        assertTrue(FeatureFlags.liveColoring)
        assertTrue(FeatureFlags.voice)
        assertTrue(FeatureFlags.parkedMenu)
        assertTrue(FeatureFlags.guest)
        assertTrue(FeatureFlags.share)
        assertTrue(FeatureFlags.intro)
    }
}
