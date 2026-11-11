package com.nubi.car.voice

/**
 * 한 번에 한 문장만 말하는 상태. TTS 콜백은 발화 번호를 주지 않으므로 [onStarted]가 온 발화의 [onDone]만 받아들인다
 * (앞 발화를 취소한 뒤 늦게 온 완료·오류 콜백이 새 발화를 끝내지 못하게 한다). 모든 호출은 메인 스레드에서 한다.
 */
class SpeechTurns {
    private var active = false
    private var started = false

    val isActive: Boolean get() = active

    /** 새 발화를 시작한다(이전 발화가 남아 있으면 그 콜백은 무효가 된다). */
    fun begin() {
        active = true
        started = false
    }

    /** TTS가 실제로 소리를 내기 시작했다. 지금 발화의 것이면 true. */
    fun onStarted(): Boolean {
        if (!active) return false
        started = true
        return true
    }

    /** 완료 콜백. **시작한 지금 발화**의 것일 때만 true(끝내야 한다). */
    fun onDone(): Boolean = active && started

    /** 오류 콜백. 소리를 내기 전이어도 지금 발화의 것이면 true. */
    fun onError(): Boolean = active

    /** 발화를 끝낸다(완료·중단·상한). 끝낼 발화가 있었으면 true. */
    fun end(): Boolean {
        val was = active
        active = false
        started = false
        return was
    }
}
