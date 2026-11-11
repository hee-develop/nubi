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
        val (_, lats) = t.snapshot()
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
}
