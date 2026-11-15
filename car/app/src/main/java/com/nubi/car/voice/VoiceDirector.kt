package com.nubi.car.voice

import android.util.Log
import com.nubi.car.trip.Gear

/**
 * 소리를 내는 쪽. 실패·미지원이면 false를 돌려주고 아무 일도 하지 않는다(크래시 금지).
 * [stillAllowed]는 **재생 직전과 재생 중**에 상황(기어·플래그)을 다시 확인하는 콜백이고 false가 되면 즉시 멈춰야 한다.
 * [onStarted]는 실제로 말하기 시작했을 때 한 번 부른다(빈도 제한은 이때 기록한다).
 */
fun interface Speaker {
    fun speak(text: String, kind: VoiceKind, stillAllowed: () -> Boolean, onStarted: () -> Unit): Boolean
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
        if (synchronized(this) { code in spokenCodes }) return
        // 말하기 시작했을 때만 '말한 시군구'로 센다(말하지 못했으면 다음 응답에서 다시 시도한다)
        val d = say(VoiceKind.FIRST_REGION, firstRegionSentence(displayName)) { synchronized(this) { spokenCodes.add(code) } }
        // 규칙(빈도·상황·문장)으로 건너뛴 시군구는 지나간 일이라 다시 말하지 않는다(10분 뒤 '처음 왔어요'가 엉뚱하게 나오지 않게)
        if (d is Decision.Skip) synchronized(this) { spokenCodes.add(code) }
    }

    /** 트립 정산이 끝났다. [newKm]은 이번 트립에서 새로 칠한 도로 거리(km), 집계되지 않았으면 null. */
    fun onTripSettled(newKm: Double?) {
        say(VoiceKind.ARRIVAL_BRIEFING, briefingSentence(newKm))
    }

    private fun say(kind: VoiceKind, text: String?, started: () -> Unit = {}): Decision? {
        return try {
            val d = decide(kind, text, flag(), gear(), gate, now())
            when (d) {
                is Decision.Speak -> {
                    val ok = speaker.speak(d.text, kind, { situationAllowed(kind, flag(), gear()) }) {
                        gate.record(kind, now())
                        started()
                    }
                    if (!ok) Log.i(TAG, "${kind.code} 말하지 못함")
                }
                is Decision.Skip -> Log.i(TAG, "${kind.code} 건너뜀: ${d.reason}")
            }
            d
        } catch (t: Throwable) {
            Log.w(TAG, "음성 안내 예외: ${t.javaClass.simpleName}")
            null
        }
    }

    private companion object {
        const val TAG = "NubiVoice"
    }
}
