package com.nubi.car.voice

import com.nubi.car.trip.Gear
import java.util.Locale

/** 음성 안내 종류. I01 처음 들어선 시군구(주행 중), I03 하차 브리핑(정차 P에서만, 숫자 허용). */
enum class VoiceKind(val code: String) { FIRST_REGION("I01"), ARRIVAL_BRIEFING("I03") }

/** 안내 한 번의 길이 상한(plan 4-4: 한 문장 5초 이내). */
const val MAX_SPEECH_SECONDS = 5.0

/** 같은 종류의 안내 사이 최소 간격(plan 4-4: 10분에 1회 이하). */
const val MIN_INTERVAL_MS = 10 * 60_000L

/**
 * 빈도 제한. [tryAcquire]가 true면 이 종류가 [now]에 말해도 되는 것이고 시각을 기록한다.
 * 종류마다 따로 센다: 하차 브리핑이 직전 시군구 안내 때문에 막히지 않게 하되, 같은 종류는 10분에 1회를 넘지 않는다. 시계는 단조 시계(ms)를 넘긴다.
 */
class VoiceGate(private val minIntervalMs: Long = MIN_INTERVAL_MS) {
    private val last = HashMap<VoiceKind, Long>()

    /** 말해도 되는지만 본다(기록하지 않는다). */
    @Synchronized
    fun canSpeak(kind: VoiceKind, now: Long): Boolean = last[kind]?.let { now - it >= minIntervalMs } ?: true

    @Synchronized
    fun tryAcquire(kind: VoiceKind, now: Long): Boolean {
        if (!canSpeak(kind, now)) return false
        last[kind] = now
        return true
    }

    @Synchronized
    fun reset() = last.clear()
}

/** 시군구 이름에서 한글·공백만 남긴다(상호·기호·숫자가 섞여 들어오는 것을 막는다). 남는 게 없으면 null. */
fun sanitizeRegionName(name: String): String? =
    name.filter { it == ' ' || it in '가'..'힣' }.trim().replace(Regex(" +"), " ").takeIf { it.isNotEmpty() && it.length <= 20 }

/** I01. 예: `강원 홍천군에 처음 왔어요`. 숫자·질문 없음. 이름이 쓸 수 없으면 null. */
fun firstRegionSentence(displayName: String): String? = sanitizeRegionName(displayName)?.let { "${it}에 처음 왔어요" }

/** I03. 예: `오늘 새 도로 1.2킬로미터를 달렸어요`. 0.1km 미만이거나 값이 이상하면 null(말하지 않는다). */
fun briefingSentence(newKm: Double?): String? {
    if (newKm == null || !newKm.isFinite() || newKm < 0.05 || newKm >= 1000) return null
    val text = String.format(Locale.US, "%.1f", newKm)
    return "오늘 새 도로 ${text}킬로미터를 달렸어요"
}

/**
 * 말하는 데 걸리는 시간 추정(초). 한글 한 글자를 한 음절로, 숫자 한 자리·소수점은 한 음절(일·점)로 세어 초당 [SYLLABLES_PER_SECOND]음절로 나눈다.
 * 실제 TTS보다 느리게 잡은 값이라 이 값이 5초 이내면 실제로도 이내다.
 */
fun estimateSeconds(text: String): Double {
    val syllables = text.count { it in '가'..'힣' || it.isDigit() || it == '.' }
    return syllables / SYLLABLES_PER_SECOND
}

const val SYLLABLES_PER_SECOND = 4.5

/** 문장이 규칙을 지키는지: 5초 이내, 질문 아님, 한 문장. */
fun isValidSentence(text: String): Boolean =
    text.isNotBlank() && !text.contains('?') && !text.contains('？') && estimateSeconds(text) <= MAX_SPEECH_SECONDS && !text.trim().endsWith("까요") && !text.trim().endsWith("나요")

sealed interface Decision {
    data class Speak(val text: String) : Decision
    data class Skip(val reason: String) : Decision
}

/**
 * 말할지 정한다. 순서: 플래그 → 상황(I01은 주행 중에만, I03은 정차 P에서만) → 문장 규칙 → 빈도 제한. 빈도 제한은 마지막에 확인하고 통과하면 기록한다.
 * 주행 중(P가 아닌 기어)에는 I01만 허용하고 숫자가 들어간 문장은 말하지 않는다.
 */
fun decide(kind: VoiceKind, text: String?, flag: Boolean, gear: Gear?, gate: VoiceGate, now: Long): Decision {
    if (!flag) return Decision.Skip("꺼짐")
    val driving = gear != null && gear != Gear.P
    when (kind) {
        VoiceKind.FIRST_REGION -> if (!driving) return Decision.Skip("주행 중 아님")
        VoiceKind.ARRIVAL_BRIEFING -> if (gear != Gear.P) return Decision.Skip("정차 아님")
    }
    if (text == null) return Decision.Skip("문장 없음")
    if (driving && text.any { it.isDigit() }) return Decision.Skip("주행 중 숫자 금지")
    if (!isValidSentence(text)) return Decision.Skip("문장 규칙")
    if (!gate.tryAcquire(kind, now)) return Decision.Skip("빈도 제한")
    return Decision.Speak(text)
}
