package com.nubi.car.screens

import com.nubi.car.map.LocalTrail
import com.nubi.car.map.LonLat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TripSummaryTest {
    private fun trail(vararg p: Pair<Double, Double>) = LocalTrail().also { t -> p.forEachIndexed { i, (lon, lat) -> t.add(LonLat(lon, lat), i * 1000L) } }

    @Test
    fun 궤적_범위는_여백을_두고_너무_작으면_넓힌다() {
        val s = trail(127.0 to 37.5, 127.02 to 37.52).snapshot()
        val b = tripBbox(s)!!
        assertTrue(b.minLon < 127.0 && b.maxLon > 127.02 && b.minLat < 37.5 && b.maxLat > 37.52)
        // 점 하나(정차 직전)도 최소 범위를 가진다
        val one = tripBbox(trail(127.0 to 37.5).snapshot())!!
        assertTrue(one.maxLon - one.minLon >= 0.004 && one.maxLat - one.minLat >= 0.004)
        assertNull(tripBbox(LocalTrail().snapshot()))
    }

    @Test
    fun 궤적_복사본은_원본이_지워져도_남는다() {
        val t = trail(127.0 to 37.5, 127.001 to 37.501, 127.002 to 37.502)
        val copy = copyTrail(t.snapshot())
        t.clear()
        assertEquals(3, copy.size)
    }

    @Test
    fun 정산_뒤_30초_동안만_보이고_탭하면_닫힌다() {
        val s = TripSummaryState()
        s.onEnded(tripBbox(trail(127.0 to 37.5).snapshot()), trail(127.0 to 37.5))
        assertNull("정산 전에는 없다", s.current(0))
        s.onSettled(1.2, listOf("서울 중구"), 1_000)
        val d = s.current(2_000)!!
        assertEquals(1.2, d.newKm!!, 0.0)
        assertEquals(listOf("서울 중구"), d.regions)
        assertNotNull(s.current(30_999))
        assertNull(s.current(31_000))
        // 탭해서 닫으면 시간이 남아도 사라진다
        s.dismiss()
        assertNull(s.current(5_000))
    }

    @Test
    fun 새_도로도_새_시군구도_없으면_카드를_만들지_않는다() {
        val s = TripSummaryState()
        s.onEnded(null, trail(127.0 to 37.5))
        s.onSettled(null, emptyList(), 0)
        assertNull(s.current(1))
        s.onEnded(null, trail(127.0 to 37.5))
        s.onSettled(0.01, emptyList(), 0)
        assertNull("0.05km 미만은 숫자로 치지 않는다", s.current(1))
    }

    @Test
    fun 시군구만_있어도_카드를_만든다() {
        val s = TripSummaryState()
        s.onEnded(null, trail(127.0 to 37.5))
        s.onSettled(null, listOf("강원 홍천군"), 0)
        val d = s.current(1)!!
        assertNull(d.newKm)
    }

    @Test
    fun 이번_실행에서_끝난_트립이_아니면_정산이_와도_카드를_만들지_않는다() {
        val s = TripSummaryState()
        s.onSettled(2.0, listOf("서울 중구"), 0) // 오프라인 백로그 정산
        assertNull(s.current(1))
    }

    @Test
    fun 새_트립이_시작되면_지운다() {
        val s = TripSummaryState()
        s.onEnded(null, trail(127.0 to 37.5))
        s.onSettled(1.0, emptyList(), 0)
        s.onTripStarted()
        assertNull(s.current(1))
    }

    @Test
    fun 새_카드는_이전에_닫은_것과_별개다() {
        val s = TripSummaryState()
        s.onEnded(null, trail(127.0 to 37.5)); s.onSettled(1.0, emptyList(), 0)
        s.dismiss()
        s.onEnded(null, trail(127.0 to 37.5)); s.onSettled(2.0, emptyList(), 100)
        assertEquals(2.0, s.current(200)!!.newKm!!, 0.0)
    }
}
