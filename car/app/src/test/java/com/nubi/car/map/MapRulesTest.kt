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
        assertEquals("지도 way=2 driven=1 live=2 new=1 trail=7 roads=on regions=off region=0 load=ok z=14.0 follow=on", d)
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

    @Test
    fun 지역_이름은_바뀐_뒤_5초_동안_이전_값을_유지한다() {
        val h = HoldLast(5_000)
        assertEquals("서울 종로구", h.update("서울 종로구", 0))
        assertEquals("서울 종로구", h.update("서울 중구", 1_000)) // 경계에서 바로 바꾸지 않는다
        assertEquals("서울 종로구", h.update("서울 중구", 4_999))
        assertEquals("서울 중구", h.update("서울 중구", 5_000))
        assertEquals("서울 중구", h.update("서울 종로구", 6_000)) // 다시 바뀌어도 5초는 유지
        assertEquals("서울 중구", h.update(null, 9_000))
        assertNull(h.update(null, 11_000)) // 모름도 같은 규칙
        h.reset()
        assertEquals("부산 중구", h.update("부산 중구", 20_000))
    }

    @Test
    fun 방위_차이는_0에서_180_사이이고_15도_미만은_마커를_안_돌린다() {
        assertEquals(10.0, bearingDiff(355.0, 5.0), 1e-9)
        assertEquals(180.0, bearingDiff(0.0, 180.0), 1e-9)
        assertEquals(0.0, bearingDiff(90.0, 90.0), 1e-9)
        assertTrue(bearingDiff(100.0, 110.0) < BEARING_STEP_DEG)
        assertTrue(bearingDiff(100.0, 120.0) >= BEARING_STEP_DEG)
    }

    @Test
    fun 업로드_간격은_지도가_켜져_있고_화면이_보일_때만_20초다() {
        assertEquals(20_000L, uploadIntervalFor(true, true, true, 60_000, 20_000))
        assertEquals(60_000L, uploadIntervalFor(true, true, false, 60_000, 20_000)) // 백그라운드
        assertEquals(60_000L, uploadIntervalFor(false, true, true, 60_000, 20_000)) // 03b(지도 끔)
        assertEquals(60_000L, uploadIntervalFor(true, false, true, 60_000, 20_000)) // 잠정 색칠 끔
    }

    @Test
    fun 지도_플래그를_끄면_기존_03b_경로다() {
        val saved = FeatureFlags.drivingMap
        try {
            FeatureFlags.drivingMap = false
            assertEquals(MapMode.OFF, mapMode(FeatureFlags.drivingMap, parkedLayout = false)) // 주행 중: 기존 로고 화면
            assertEquals(MapMode.OFF, mapMode(FeatureFlags.drivingMap, parkedLayout = true)) // 정차: 지도 없는 03
            assertFalse(mapInteractive(mapMode(FeatureFlags.drivingMap, true), distractionOptimized = false))
        } finally {
            FeatureFlags.drivingMap = saved
        }
    }

    @Test
    fun 정산된_트립이_지금_기록_중인_트립과_다르면_궤적을_지우지_않는다() {
        assertTrue(shouldClearOnSettle("a", "a"))
        assertFalse(shouldClearOnSettle("old", "now")) // 오프라인 백로그의 지난 트립
        assertTrue(shouldClearOnSettle("a", null)) // 기록 중인 트립이 없다
        assertTrue(shouldClearOnSettle(null, "now")) // 모름
    }
}
