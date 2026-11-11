package com.nubi.car.voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechTurnsTest {
    @Test
    fun 시작한_발화의_완료만_끝낸다() {
        val t = SpeechTurns()
        t.begin()
        assertFalse("소리가 시작되기 전의 완료 콜백은 무시한다", t.onDone())
        assertTrue(t.onStarted())
        assertTrue(t.onDone())
        assertTrue(t.end())
        assertFalse("끝난 뒤 늦게 온 완료 콜백은 무시한다", t.onDone())
    }

    @Test
    fun 취소한_발화의_늦은_콜백이_새_발화를_끝내지_못한다() {
        val t = SpeechTurns()
        t.begin()
        t.onStarted()
        assertTrue("상황이 바뀌어 취소", t.end())
        t.begin() // 새 발화
        assertFalse("앞 발화의 늦은 onDone은 새 발화(아직 시작 전)를 끝내지 못한다", t.onDone())
        assertTrue(t.onStarted())
        assertTrue(t.onDone())
    }

    @Test
    fun 오류는_소리_전에도_지금_발화를_끝낸다_발화가_없으면_무시() {
        val t = SpeechTurns()
        assertFalse(t.onError())
        assertFalse(t.onStarted())
        t.begin()
        assertTrue(t.onError())
        assertTrue(t.end())
        assertFalse(t.end())
        assertFalse(t.isActive)
    }
}
