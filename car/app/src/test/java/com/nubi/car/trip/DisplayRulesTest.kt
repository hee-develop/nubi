package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DisplayRulesTest {
    @Test
    fun 제한이_없으면_그대로() {
        assertEquals("새 도로 1.4km", limitText("새 도로 1.4km", false, 5, false))
        assertEquals("새 도로 1.4km", limitText("새 도로 1.4km", true, 0, false))
        assertEquals("abc", limitText("abc", true, 3, false))
    }

    @Test
    fun 제한보다_길면_숫자_줄은_숨기고_상태_문구는_자른다() {
        assertNull(limitText("전국 0.0123% 달렸어요", true, 6, false))
        assertEquals("기록 중입니", limitText("기록 중입니다", true, 6, true))
    }

    @Test
    fun 넘치면_뒤_순위부터_접고_상태는_접지_않는다() {
        // 상태, 집계, 시군구, 이벤트, 전국, 샘플, 거리
        val h = listOf(50, 30, 30, 30, 30, 30, 30)
        assertEquals(List(7) { true }, foldLines(h, 300))
        assertEquals(listOf(true, true, true, true, true, false, false), foldLines(h, 170))
        assertEquals(listOf(true, false, false, false, false, false, false), foldLines(h, 10, pinned = 1))
    }

    @Test
    fun 보이지_않는_줄은_높이_0이라_접을_때도_보이지_않는다() {
        assertEquals(listOf(true, false, true), foldLines(listOf(40, 0, 40), 100))
        assertEquals(listOf(true, false, false), foldLines(listOf(40, 0, 40), 50, pinned = 1))
    }
}
