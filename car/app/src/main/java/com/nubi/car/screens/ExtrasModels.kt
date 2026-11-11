package com.nubi.car.screens

import org.json.JSONObject
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** `GET/PUT /vehicles/:id/settings` 응답. [recordingBlocked]는 서버가 점을 받지 않는 상태(기록 멈춤 또는 위치정보 동의 철회). */
data class ServerSettings(
    val recordingPaused: Boolean,
    val homeRegion: String?,
    val statsOptIn: Boolean,
    val drivingMap: Boolean,
    val consentWithdrawn: Boolean,
) {
    val recordingBlocked: Boolean get() = recordingPaused || consentWithdrawn
}

fun parseSettings(text: String): ServerSettings = try {
    val o = JSONObject(text)
    ServerSettings(
        recordingPaused = o.getBoolean("recordingPaused"),
        homeRegion = if (o.isNull("homeRegion")) null else o.getString("homeRegion"),
        statsOptIn = o.optBoolean("statsOptIn", true),
        drivingMap = o.optBoolean("drivingMap", true),
        consentWithdrawn = !o.isNull("consentWithdrawnAt") && o.optString("consentWithdrawnAt", "").isNotEmpty(),
    )
} catch (e: Exception) {
    throw IOException("응답 형식 오류 settings")
}

/** `/regions/list` 항목(도감 한 칸). */
data class DexItem(
    val code: String,
    val name: String,
    val displayName: String,
    val sidoName: String,
    val level: Int,
    val depop92: Boolean,
    val faded: Boolean,
)

fun parseDex(text: String): List<DexItem> = try {
    val items = JSONObject(text).getJSONArray("items")
    List(items.length()) { i ->
        val o = items.getJSONObject(i)
        DexItem(
            o.getString("code"), o.getString("name"), o.getString("displayName"), o.getString("sidoName"),
            o.getInt("level").coerceIn(0, 3), o.getBoolean("depop92"), o.optBoolean("faded", false),
        )
    }
} catch (e: Exception) {
    throw IOException("응답 형식 오류 regions/list")
}

/** 시도별 묶음. 서버가 시도 코드 → 이름 순으로 주므로 처음 나온 순서를 지킨다. */
data class DexGroup(val sido: String, val items: List<DexItem>) {
    val colored: Int get() = items.count { it.level > 0 }
}

fun groupBySido(items: List<DexItem>): List<DexGroup> {
    val map = LinkedHashMap<String, MutableList<DexItem>>()
    for (it in items) map.getOrPut(it.sidoName) { ArrayList() }.add(it)
    return map.map { (k, v) -> DexGroup(k, v) }
}

/** 도감 요약: 색이 칠린(level ≥ 1) 칸 수 / 전체, 인구감소지역 92곳 중 칠린 수 / 92곳. */
data class DexSummary(val colored: Int, val total: Int, val depopColored: Int, val depopTotal: Int)

fun dexSummary(items: List<DexItem>): DexSummary =
    DexSummary(items.count { it.level > 0 }, items.size, items.count { it.depop92 && it.level > 0 }, items.count { it.depop92 })

/** `/coverage/roads` 항목. */
data class RoadItem(val roadKey: String, val displayName: String, val percent: Double, val drivenM: Int, val totalM: Int, val completed: Boolean)

fun parseRoads(text: String): List<RoadItem> = try {
    val items = JSONObject(text).getJSONArray("items")
    List(items.length()) { i ->
        val o = items.getJSONObject(i)
        RoadItem(o.getString("roadKey"), o.getString("displayName"), o.getDouble("percent"), o.getInt("drivenM"), o.getInt("totalM"), o.optBoolean("completed", false))
    }
} catch (e: Exception) {
    throw IOException("응답 형식 오류 coverage/roads")
}

/** `/reports/daily`·`monthly` 응답(둘의 공통 필드). */
data class Report(
    val tripCount: Int,
    val distanceKm: Double,
    val newKm: Double,
    val revivedKm: Double,
    val newRegions: List<String>,
    val daysDriven: Int,
)

fun parseReport(text: String): Report = try {
    val o = JSONObject(text)
    val regs = o.optJSONArray("newRegions")
    Report(
        o.getInt("tripCount"), o.getDouble("distanceKm"), o.getDouble("newKm"), o.optDouble("revivedKm", 0.0),
        regs?.let { a -> List(a.length()) { a.getJSONObject(it).getString("displayName") } } ?: emptyList(),
        o.optInt("daysDriven", 0),
    )
} catch (e: Exception) {
    throw IOException("응답 형식 오류 reports")
}

/** `POST /guest/code`·`/pair/code` 응답. [expiresAtMs]는 epoch ms. */
data class CodeInfo(val code: String, val url: String, val expiresAtMs: Long)

fun parseCode(text: String): CodeInfo = try {
    val o = JSONObject(text)
    CodeInfo(o.getString("code"), o.getString("url"), parseIsoMillis(o.getString("expiresAt")))
} catch (e: Exception) {
    throw IOException("응답 형식 오류 code")
}

/** `POST /share/cards` 응답 중 QR로 쓸 링크. */
fun parseShareUrl(text: String): String = try {
    JSONObject(text).getString("url")
} catch (e: Exception) {
    throw IOException("응답 형식 오류 share")
}

/** 지역 소개 항목. [lat]·[lon]은 길안내 목적지다. */
data class IntroItem(val kind: String, val title: String, val lat: Double, val lon: Double, val addr: String?)

data class Intro(val code: String, val sample: Boolean, val items: List<IntroItem>) {
    /** 종류별 첫 항목(서버가 가까운 순으로 준다). */
    fun first(kind: String): IntroItem? = items.firstOrNull { it.kind == kind }
}

fun parseIntro(text: String): Intro = try {
    val o = JSONObject(text)
    val a = o.getJSONArray("items")
    Intro(
        o.getString("code"), o.getBoolean("sample"),
        List(a.length()) { i ->
            val it = a.getJSONObject(i)
            IntroItem(it.getString("kind"), it.getString("title"), it.getDouble("lat"), it.getDouble("lon"), it.optString("addr", "").takeIf { s -> s.isNotEmpty() })
        },
    )
} catch (e: Exception) {
    throw IOException("응답 형식 오류 intro")
}

fun parseIsoMillis(iso: String): Long {
    val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    return try {
        f.parse(iso)!!.time
    } catch (e: Exception) {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(iso)!!.time
    }
}

private fun kst(pattern: String, ms: Long): String =
    SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }.format(Date(ms))

/** 서버 리포트가 쓰는 KST 날짜(`YYYY-MM-DD`)와 달(`YYYY-MM`). */
fun kstDate(ms: Long): String = kst("yyyy-MM-dd", ms)

fun kstMonth(ms: Long): String = kst("yyyy-MM", ms)
