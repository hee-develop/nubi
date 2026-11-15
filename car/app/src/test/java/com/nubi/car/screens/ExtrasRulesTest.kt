package com.nubi.car.screens

import com.nubi.car.trip.Gear
import com.nubi.car.trip.TripState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExtrasRulesTest {
    @Test
    fun 메뉴와_QR은_기어_P이고_DO가_없을_때만() {
        assertTrue(menuAllowed(true, Gear.P, TripState.IDLE, false))
        assertTrue(qrAllowed(true, Gear.P, TripState.ENDED, false))
        for (g in listOf(Gear.D, Gear.R, Gear.N)) {
            assertFalse("기어 $g 에서는 메뉴가 없어야 한다", menuAllowed(true, g, TripState.IDLE, false))
            assertFalse("기어 $g 에서는 QR이 없어야 한다", qrAllowed(true, g, TripState.RECORDING, false))
        }
        assertFalse("DO면 P여도 숨긴다", qrAllowed(true, Gear.P, TripState.IDLE, true))
        assertFalse("플래그가 꺼지면 숨긴다", menuAllowed(false, Gear.P, TripState.IDLE, false))
    }

    @Test
    fun 기어를_못_읽는_차량은_기록_중이_아닐_때만_메뉴를_허용하고_QR은_거부한다() {
        assertTrue(menuAllowed(true, null, TripState.IDLE, false))
        assertFalse(menuAllowed(true, null, TripState.RECORDING, false))
        assertFalse("QR은 실제 기어가 P일 때만", qrAllowed(true, null, TripState.IDLE, false))
    }

    @Test
    fun 남은_시간은_5분에서_줄고_0에서_멈춘다() {
        assertEquals(300_000L, remainingMs(1_000, 1_000))
        assertEquals(240_000L, remainingMs(1_000, 61_000))
        assertEquals(0L, remainingMs(1_000, 1_000 + 400_000))
        assertEquals("5:00", formatRemaining(300_000))
        assertEquals("4:59", formatRemaining(299_000))
        assertEquals("4:59", formatRemaining(298_001))
        assertEquals("0:01", formatRemaining(1))
        assertEquals("0:00", formatRemaining(0))
    }

    @Test
    fun QR_행렬은_정사각형이고_주소를_담는다() {
        val m = qrMatrix("http://10.0.2.2:8793/g/123456")
        assertNotNull(m)
        assertEquals(m!!.size, m[0].size)
        assertTrue(m.size >= 21)
        // 같은 입력은 같은 행렬, 다른 입력은 다른 행렬
        assertTrue(m.contentDeepEquals(qrMatrix("http://10.0.2.2:8793/g/123456")))
        assertFalse(m.contentDeepEquals(qrMatrix("http://10.0.2.2:8793/g/654321")))
        // 파인더 패턴: 여백 2칸 뒤 왼쪽 위 7x7 테두리는 모두 어둡다
        for (i in 0 until 7) assertTrue(m[2][2 + i] && m[2 + 6][2 + i] && m[2 + i][2] && m[2 + i][2 + 6])
    }

    @Test
    fun 너무_긴_입력은_null() {
        assertNull(qrMatrix("x".repeat(5000)))
    }
}
