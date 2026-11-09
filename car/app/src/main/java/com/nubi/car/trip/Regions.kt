package com.nubi.car.trip

import org.json.JSONObject
import java.time.Instant
import java.util.Locale

/** 시군구 방문·숙박 이벤트(서버 `lastEvent`). [atMs]는 서버가 기록한 시각(다음 트립 시작)의 epoch ms. */
data class RegionEvent(val kind: String, val name: String, val atMs: Long)

/** `GET /regions/summary`의 필요한 부분(사양 03 6장). 인구감소지역 분모는 서버가 주는 89곳 통계 기준이다. */
data class RegionsSummary(
    val colored: Int,
    val total: Int,
    val colored89: Int,
    val total89: Int,
    val lastEvent: RegionEvent? = null,
) {
    /** 캐시(SharedPreferences) 직렬화. 이름에 쓰지 않는 `|`로 나눈다. */
    fun encode(): String =
        listOf(colored, total, colored89, total89, lastEvent?.kind ?: "", lastEvent?.name?.replace("|", " ") ?: "", lastEvent?.atMs ?: 0L)
            .joinToString("|")

    companion object {
        fun decode(text: String?): RegionsSummary? {
            val p = text?.split("|") ?: return null
            if (p.size != 7) return null
            return try {
                val kind = p[4]
                RegionsSummary(
                    p[0].toInt(), p[1].toInt(), p[2].toInt(), p[3].toInt(),
                    if (kind.isEmpty()) null else RegionEvent(kind, p[5], p[6].toLong()),
                )
            } catch (e: NumberFormatException) {
                null
            }
        }

        fun fromJson(text: String): RegionsSummary {
            val o = JSONObject(text)
            val depop = o.getJSONObject("depop")
            val ev = o.optJSONObject("lastEvent")
            return RegionsSummary(
                colored = o.getInt("colored"),
                total = o.getInt("total"),
                colored89 = depop.getInt("colored89"),
                total89 = depop.getInt("total89"),
                lastEvent = ev?.let { RegionEvent(it.getString("kind"), it.getString("name"), Instant.parse(it.getString("at")).toEpochMilli()) },
            )
        }
    }
}

/** 대기·종료 화면 한 줄: `시군구 {colored}/{total} · 인구감소지역 {colored89}/{total89}`. 값이 없으면(조회 실패) null이라 생략한다. */
fun formatRegionsLine(s: RegionsSummary?, format: String): String? =
    s?.let { String.format(Locale.US, format, it.colored, it.total, it.colored89, it.total89) }

/** 종료 화면 `처음 지난 곳: {name}(, {name})` 최대 3개. 없으면 null. */
fun formatNewRegions(names: List<String>, format: String): String? =
    names.takeIf { it.isNotEmpty() }?.let { String.format(Locale.US, format, it.take(MAX_NEW_REGIONS).joinToString(", ")) }

const val MAX_NEW_REGIONS = 3
const val EVENT_WINDOW_MS = 24 * 3_600_000L

/** 마지막 이벤트 한 줄(`{name} 방문` / `{name}에서 하룻밤`). [nowMs]로부터 24시간 안의 것만 보인다. */
fun formatRegionEvent(e: RegionEvent?, nowMs: Long, visitFormat: String, stayFormat: String): String? {
    if (e == null || nowMs - e.atMs >= EVENT_WINDOW_MS) return null
    return when (e.kind) {
        "visit" -> String.format(Locale.US, visitFormat, e.name)
        "stay" -> String.format(Locale.US, stayFormat, e.name)
        else -> null
    }
}
