package com.nubi.car.voice

import com.nubi.car.trip.Gear
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRulesTest {
    private val min = 60_000L

    @Test
    fun 시군구_문장은_이름만_쓰고_숫자와_질문이_없다() {
        assertEquals("강원 홍천군에 처음 왔어요", firstRegionSentence("강원 홍천군"))
        assertEquals("서울 중구에 처음 왔어요", firstRegionSentence("  서울   중구 "))
        // 상호·숫자·기호가 섞이면 한글·공백만 남긴다
        assertEquals("서울 중구카페에 처음 왔어요", firstRegionSentence("서울 중구(카페123)"))
        assertNull(firstRegionSentence("123"))
        assertNull(firstRegionSentence(""))
        assertFalse(firstRegionSentence("강원 홍천군")!!.any { it.isDigit() || it == '?' })
    }

    @Test
    fun 하차_브리핑_문장() {
        assertEquals("오늘 새 도로 1.2킬로미터를 달렸어요", briefingSentence(1.23))
        assertEquals("오늘 새 도로 0.1킬로미터를 달렸어요", briefingSentence(0.1))
        assertNull(briefingSentence(0.0))
        assertNull(briefingSentence(0.04))
        assertNull(briefingSentence(null))
        assertNull(briefingSentence(Double.NaN))
        assertNull(briefingSentence(5000.0))
    }

    @Test
    fun 문장은_5초_안이다() {
        for (t in listOf(firstRegionSentence("경상남도 창원시 마산합포구")!!, firstRegionSentence("전남광주통합특별시 광산구")!!, briefingSentence(123.4)!!, briefingSentence(0.3)!!)) {
            assertTrue("$t = ${estimateSeconds(t)}초", estimateSeconds(t) <= MAX_SPEECH_SECONDS)
            assertTrue(isValidSentence(t))
        }
        assertFalse(isValidSentence("이 문장은 일부러 아주아주아주 길게 써서 오 초 안에는 도저히 읽을 수 없도록 만든 문장이에요"))
        assertFalse(isValidSentence("여기 처음 왔나요?"))
        assertFalse(isValidSentence("안내를 받으시겠어요?"))
        assertFalse(isValidSentence(""))
    }

    @Test
    fun 같은_종류는_10분에_한_번만() {
        val g = VoiceGate()
        assertTrue(g.tryAcquire(VoiceKind.FIRST_REGION, 0))
        assertFalse(g.tryAcquire(VoiceKind.FIRST_REGION, 9 * min + 59_000))
        assertTrue(g.tryAcquire(VoiceKind.FIRST_REGION, 10 * min))
        assertFalse("방금 허용한 뒤 다시 10분", g.tryAcquire(VoiceKind.FIRST_REGION, 10 * min + 1))
        // 종류가 다르면 서로 막지 않는다
        assertTrue(g.tryAcquire(VoiceKind.ARRIVAL_BRIEFING, 10 * min + 2))
        assertFalse(g.tryAcquire(VoiceKind.ARRIVAL_BRIEFING, 11 * min))
    }

    @Test
    fun 막힌_시도는_시각을_갱신하지_않는다() {
        val g = VoiceGate()
        g.tryAcquire(VoiceKind.FIRST_REGION, 0)
        assertFalse(g.tryAcquire(VoiceKind.FIRST_REGION, 5 * min))
        assertTrue("처음 허용한 시각 기준 10분이 지나면 된다", g.tryAcquire(VoiceKind.FIRST_REGION, 10 * min))
    }

    @Test
    fun 시군구_안내는_주행_중에만_하차_브리핑은_정차에서만() {
        val s = firstRegionSentence("서울 중구")
        for (gear in listOf(Gear.D, Gear.R, Gear.N)) assertTrue(decide(VoiceKind.FIRST_REGION, s, true, gear, VoiceGate(), 0) is Decision.Speak)
        assertTrue(decide(VoiceKind.FIRST_REGION, s, true, Gear.P, VoiceGate(), 0) is Decision.Skip)
        assertTrue(decide(VoiceKind.FIRST_REGION, s, true, null, VoiceGate(), 0) is Decision.Skip)
        val b = briefingSentence(2.0)
        assertTrue(decide(VoiceKind.ARRIVAL_BRIEFING, b, true, Gear.P, VoiceGate(), 0) is Decision.Speak)
        for (gear in listOf(Gear.D, Gear.R, Gear.N, null)) assertTrue(decide(VoiceKind.ARRIVAL_BRIEFING, b, true, gear, VoiceGate(), 0) is Decision.Skip)
    }

    @Test
    fun 주행_중에는_숫자가_든_문장을_말하지_않는다() {
        assertTrue(decide(VoiceKind.FIRST_REGION, "3번째 시군구에 처음 왔어요", true, Gear.D, VoiceGate(), 0) is Decision.Skip)
    }

    @Test
    fun 플래그가_꺼지면_말하지_않고_빈도도_쓰지_않는다() {
        val g = VoiceGate()
        assertTrue(decide(VoiceKind.FIRST_REGION, "서울 중구에 처음 왔어요", false, Gear.D, g, 0) is Decision.Skip)
        assertTrue("꺼진 동안은 시각을 기록하지 않는다", g.canSpeak(VoiceKind.FIRST_REGION, 0))
    }

    @Test
    fun 문장이_없으면_건너뛴다() {
        assertTrue(decide(VoiceKind.ARRIVAL_BRIEFING, null, true, Gear.P, VoiceGate(), 0) is Decision.Skip)
    }

    @Test
    fun 디렉터는_같은_시군구를_한_트립에_한_번만_말하고_실패해도_크래시하지_않는다() {
        val said = ArrayList<Pair<String, VoiceKind>>()
        var gear: Gear? = Gear.D
        var clock = 0L
        val d = VoiceDirector({ t, k -> said.add(t to k); true }, { gear }, { true }, { clock })
        d.onFirstRegion("11110", "서울 종로구")
        d.onFirstRegion("11110", "서울 종로구")
        assertEquals(listOf("서울 종로구에 처음 왔어요" to VoiceKind.FIRST_REGION), said)
        // 10분 안의 다른 시군구는 빈도 제한
        clock = 5 * min
        d.onFirstRegion("11140", "서울 중구")
        assertEquals(1, said.size)
        // 정차 후 하차 브리핑은 따로 센다
        gear = Gear.P
        d.onTripSettled(1.2)
        assertEquals("오늘 새 도로 1.2킬로미터를 달렸어요", said.last().first)
        // 말하기가 던져도 삼킨다
        val boom = VoiceDirector({ _, _ -> throw IllegalStateException("tts") }, { Gear.D }, { true }, { 0 })
        boom.onFirstRegion("1", "서울 중구")
        boom.onTripSettled(1.0)
    }
}
