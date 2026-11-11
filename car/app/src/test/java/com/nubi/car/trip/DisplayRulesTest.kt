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

class ParkedRulesTest {
    @Test
    fun 강조_구간은_중괄호로_표시하고_글자에서는_뺀다() {
        val a = parseAccent("새 도로 {12.4km}")
        assertEquals("새 도로 12.4km", a.text)
        assertEquals("12.4km", a.text.substring(a.accentStart, a.accentEnd))
        val b = parseAccent("전국 {0.0009%} (+0.0003)")
        assertEquals("전국 0.0009% (+0.0003)", b.text)
        assertEquals("0.0009%", b.text.substring(b.accentStart, b.accentEnd))
        assertEquals(AccentText("강조 없음"), parseAccent("강조 없음"))
        assertEquals(false, parseAccent("짝 없음 {").hasAccent)
    }

    @Test
    fun 단계_점은_안_감_통과_방문_숙박_순이다() {
        assertEquals("○○○", stageDots(0))
        assertEquals("●○○", stageDots(1))
        assertEquals("●●○", stageDots(2))
        assertEquals("●●●", stageDots(3))
        assertEquals("●●●", stageDots(9))
        assertEquals("○○○", stageDots(-1))
    }

    @Test
    fun 주행_중_화면은_숫자가_안_보일_때_쓰고_눌러야_할_게_있으면_정차_화면을_쓴다() {
        assertEquals(true, usesParkedLayout(showNumbers = true, distractionOptimized = true, needsPermission = false, serviceFailed = false))
        assertEquals(false, usesParkedLayout(false, false, false, false))
        assertEquals(true, usesParkedLayout(false, false, true, false))
        assertEquals(true, usesParkedLayout(false, false, false, true))
        // 주행 규제 중에는 버튼을 숨기므로 주행 중 화면 그대로
        assertEquals(false, usesParkedLayout(false, true, true, true))
    }

    @Test
    fun 부가_요소는_기어_P이고_주행_규제가_없을_때만() {
        assertEquals(true, extrasVisible(true, false))
        assertEquals(false, extrasVisible(true, true))
        assertEquals(false, extrasVisible(false, false))
    }

    @Test
    fun 이웃_카드는_좁은_앱_영역에서_숨긴다() {
        assertEquals(true, neighborCardVisible(true, 1682, 1300))
        assertEquals(false, neighborCardVisible(true, 840, 1300))
        assertEquals(true, neighborCardVisible(true, 0, 1300))
        assertEquals(false, neighborCardVisible(false, 1682, 1300))
    }
}
