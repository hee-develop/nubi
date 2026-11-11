package com.nubi.car.voice

import android.util.Log
import com.nubi.car.trip.Gear

/** 소리를 내는 쪽. 실패·미지원이면 false를 돌려주고 아무 일도 하지 않는다(크래시 금지). */
fun interface Speaker {
    fun speak(text: String, kind: VoiceKind): Boolean
}

/**
 * 음성 안내를 언제 할지 정한다. I01(처음 들어선 시군구)은 잠정 색칠 응답의 `region.firstTime`이 오면 주행 중 한 번(같은 시군구는 한 트립에서 한 번),
 * I03(하차 브리핑)은 트립 정산 뒤 기어가 P일 때만 말한다. 규칙(플래그·기어·문장·빈도)은 [decide]가 정한다.
 */
class VoiceDirector(
    private val speaker: Speaker,
    private val gear: () -> Gear?,
    private val flag: () -> Boolean,
    /** 단조 시계(ms). */
    private val now: () -> Long,
    private val gate: VoiceGate = VoiceGate(),
) {
    private val spokenCodes = HashSet<String>()

    /** 새 트립이 시작됐다: 시군구 안내 중복 기록을 비운다. */
    @Synchronized
    fun onTripStarted() = spokenCodes.clear()

    /** 잠정 응답의 마지막 점 시군구가 이 차량에게 처음인 곳이다. */
    fun onFirstRegion(code: String, displayName: String) {
        val fresh = synchronized(this) { spokenCodes.add(code) }
        if (!fresh) return
        say(VoiceKind.FIRST_REGION, firstRegionSentence(displayName))
    }

    /** 트립 정산이 끝났다. [newKm]은 이번 트립에서 새로 칠한 도로 거리(km), 집계되지 않았으면 null. */
    fun onTripSettled(newKm: Double?) {
        say(VoiceKind.ARRIVAL_BRIEFING, briefingSentence(newKm))
    }

    private fun say(kind: VoiceKind, text: String?) {
        try {
            when (val d = decide(kind, text, flag(), gear(), gate, now())) {
                is Decision.Speak -> if (!speaker.speak(d.text, kind)) Log.i(TAG, "${kind.code} 말하지 못함")
                is Decision.Skip -> Log.i(TAG, "${kind.code} 건너뜀: ${d.reason}")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "음성 안내 예외: ${t.javaClass.simpleName}")
        }
    }

    private companion object {
        const val TAG = "NubiVoice"
    }
}
