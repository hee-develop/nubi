package com.nubi.car.map

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalTrailTest {
    private fun p(i: Int) = LonLat(127.0, 37.5 + i * 0.0002) // 약 22m 간격

    @Test
    fun 가까운_점은_건너뛰고_멀어질_때만_쌓는다() {
        val t = LocalTrail(minStepM = 8.0)
        assertTrue(t.add(p(0)))
        assertFalse(t.add(LonLat(127.0, 37.5 + 0.00002))) // 2m
        assertTrue(t.add(p(1)))
        assertEquals(2, t.size)
    }

    @Test
    fun 북쪽으로_가면_방위_0이고_점이_하나면_방위를_모른다() {
        val t = LocalTrail()
        t.add(p(0))
        assertNull(t.bearing)
        t.add(p(1))
        assertEquals(0.0, t.bearing!!, 0.5)
        t.add(LonLat(127.001, 37.5002))
        assertTrue(t.bearing!! in 60.0..90.0)
    }

    @Test
    fun 상한을_넘으면_오래된_점부터_버린다() {
        val t = LocalTrail(minStepM = 1.0, maxPoints = 5)
        for (i in 0 until 8) t.add(p(i))
        assertEquals(5, t.size)
        val lats = t.snapshot().lats
        assertEquals(37.5 + 3 * 0.0002, lats.first(), 1e-9)
        assertEquals(37.5 + 7 * 0.0002, lats.last(), 1e-9)
    }

    @Test
    fun 비우면_새_주행이다() {
        val t = LocalTrail()
        t.add(p(0))
        t.add(p(1))
        t.clear()
        assertEquals(0, t.size)
        assertNull(t.bearing)
        assertTrue(t.add(p(5)))
    }

    @Test
    fun 샘플이_오래_비었거나_멀리_튀면_새_선분으로_시작한다() {
        val t = LocalTrail(minStepM = 8.0, breakGapMs = 30_000, breakDistM = 800.0)
        t.add(p(0), 0)
        t.add(p(1), 1_000)
        t.add(p(2), 2_000)
        t.add(p(3), 40_000) // 38초 비었음(앱이 뒤에 있던 구간)
        t.add(p(4), 41_000)
        t.add(LonLat(127.0, 37.6), 42_000) // 11km 튐
        val s = t.snapshot()
        assertEquals(listOf(true, false, false, true, false, true), s.starts.toList())
        assertNull(t.bearing) // 튄 직후에는 방위를 모른다
    }

    @Test
    fun 머물러_있는_동안의_샘플은_끊김으로_치지_않는다() {
        val t = LocalTrail(minStepM = 8.0, breakGapMs = 30_000)
        t.add(p(0), 0)
        for (i in 1..40) t.add(LonLat(127.0, 37.5 + 0.00001), i * 1_000L) // 40초 동안 제자리(샘플은 계속 들어옴)
        t.add(p(1), 41_000)
        assertEquals(listOf(true, false), t.snapshot().starts.toList())
    }

    @Test
    fun 버전은_쌓거나_비울_때_올라간다() {
        val t = LocalTrail()
        val v0 = t.version
        t.add(p(0), 0)
        assertTrue(t.version > v0)
        val v1 = t.version
        t.add(LonLat(127.0, 37.5), 1_000) // 건너뜀
        assertEquals(v1, t.version)
        t.clear()
        assertTrue(t.version > v1)
    }
}
