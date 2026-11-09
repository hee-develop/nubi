package com.nubi.car.trip

import android.util.Log
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.Executor

/** `GET /trips/:id/matching`의 필요한 부분. 서버 상태 문자열은 그대로 담고 해석은 [MatchingPoller]가 한다. */
data class MatchingResponse(
    val status: String,
    val error: String?,
    /** `counted`·`skipped`·`suspect`·`low_confidence`. done이 아니면 null. */
    val outcome: String?,
    val reason: String?,
    val newKm: Double,
    val percentBefore: Double,
    val percentAfter: Double,
)

interface CoverageApi {
    /** 매칭 결과. 서버가 아직 그 트립을 모르면(404) null. */
    fun getMatching(tripId: String): MatchingResponse?

    /** 전국 완료율(%). */
    fun getNationalPercent(vehicleId: String): Double
}

class HttpCoverageApi(private val baseUrl: String) : CoverageApi {
    override fun getMatching(tripId: String): MatchingResponse? {
        val text = try {
            getText(baseUrl, "/trips/${enc(tripId)}/matching")
        } catch (e: HttpFailure) {
            if (e.status == 404) return null
            throw e
        }
        return try {
            val o = JSONObject(text)
            val r = o.optJSONObject("result")
            MatchingResponse(
                status = o.getString("status"),
                error = o.optString("error").takeIf { it.isNotEmpty() },
                outcome = r?.optString("outcome")?.takeIf { it.isNotEmpty() },
                reason = r?.optString("reason")?.takeIf { it.isNotEmpty() },
                newKm = r?.optDouble("newKm", 0.0) ?: 0.0,
                percentBefore = r?.optDouble("nationalPercentBefore", 0.0) ?: 0.0,
                percentAfter = r?.optDouble("nationalPercentAfter", 0.0) ?: 0.0,
            )
        } catch (e: Exception) {
            throw IOException("응답 형식 오류 matching")
        }
    }

    override fun getNationalPercent(vehicleId: String): Double {
        val text = getText(baseUrl, "/coverage/summary?vehicleId=${enc(vehicleId)}")
        return try {
            JSONObject(text).getDouble("nationalPercent")
        } catch (e: Exception) {
            throw IOException("응답 형식 오류 summary")
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

internal fun getText(baseUrl: String, path: String): String {
    val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
    try {
        conn.requestMethod = "GET"
        conn.connectTimeout = 5_000
        conn.readTimeout = 10_000
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code in 200..299) return text
        throw HttpFailure(code, "HTTP $code $path")
    } finally {
        conn.disconnect()
    }
}

/** 종료 화면에 보일 한 줄의 의미. 문구는 [formatMatchingLine]이 strings.xml 형식으로 만든다. */
sealed interface MatchingLine {
    /** 아직 없음(트립 전, 폴링 중, 시간 초과). 화면에 아무것도 보이지 않는다. */
    data object None : MatchingLine

    data class Counted(val newKm: Double, val percentAfter: Double, val delta: Double) : MatchingLine

    /** 집계되지 않음. [reason]은 debug 빌드에서만 괄호로 보인다. */
    data class NotCounted(val reason: String) : MatchingLine
}

/**
 * 매칭 결과를 3초 간격 최대 60초 폴링한다. 워커 스레드에서만 부른다(메인 스레드 금지).
 * queued·running·아직 없음(404)·네트워크 오류·재시도 대기(retryable)는 계속 기다리고, 시간이 다 되면 [MatchingLine.None]이다.
 * done이면 결과(집계/미집계), 영구 실패(permanent)면 미집계.
 */
class MatchingPoller(
    private val api: CoverageApi,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    private val intervalMs: Long = 3_000,
    private val maxMs: Long = 60_000,
) {
    fun poll(tripId: String, isCancelled: () -> Boolean = { false }): MatchingLine {
        val attempts = (maxMs / intervalMs).toInt().coerceAtLeast(1)
        for (i in 1..attempts) {
            if (isCancelled()) return MatchingLine.None
            val line = try {
                lineOf(api.getMatching(tripId))
            } catch (e: Exception) {
                Log.w(TAG, "매칭 조회 실패: ${e.javaClass.simpleName}")
                null
            }
            if (line != null) return line
            if (i < attempts) sleep(intervalMs)
        }
        return MatchingLine.None
    }

    /** 끝난 상태면 줄, 더 기다려야 하면 null. */
    private fun lineOf(r: MatchingResponse?): MatchingLine? {
        if (r == null) return null
        return when (r.status) {
            "done" -> when (r.outcome) {
                "counted" -> MatchingLine.Counted(r.newKm, r.percentAfter, r.percentAfter - r.percentBefore)
                else -> MatchingLine.NotCounted(r.reason ?: r.outcome ?: "done")
            }
            "failed" -> if (r.error?.startsWith("permanent") == true) MatchingLine.NotCounted(r.error) else null
            else -> null
        }
    }

    private companion object {
        const val TAG = "NubiCoverage"
    }
}

/** 완료율 표시. 전국 분모가 커서 한 번의 주행은 0.00x% 단위이므로 작은 값은 자릿수를 늘린다(가안). */
fun formatPercent(v: Double): String {
    val digits = when {
        v >= 1.0 -> 2
        v >= 0.1 -> 3
        else -> 4
    }
    return String.format(Locale.US, "%.${digits}f", v)
}

fun formatKm(km: Double): String = String.format(Locale.US, "%.1f", km)

/**
 * 종료 화면 한 줄. 형식 문자열은 strings.xml에서 받는다.
 * [countedFormat]: `새 도로 %1$skm · 전국 %2$s%% (+%3$s)`, [notCounted]·[notCountedWithReason]: `이번 주행은 집계되지 않았어요`·그 뒤에 ` (%1$s)`를 붙인 형식.
 * 사유는 [debug]일 때만 보인다. 보일 줄이 없으면 null.
 */
fun formatMatchingLine(line: MatchingLine, countedFormat: String, notCounted: String, notCountedWithReason: String, debug: Boolean): String? = when (line) {
    MatchingLine.None -> null
    is MatchingLine.Counted ->
        String.format(Locale.US, countedFormat, formatKm(line.newKm), formatPercent(line.percentAfter), formatPercent(line.delta.coerceAtLeast(0.0)))
    is MatchingLine.NotCounted -> if (debug) String.format(Locale.US, notCountedWithReason, line.reason) else notCounted
}

/** 대기 화면 한 줄: `전국 {percent}% 달렸어요`. 값이 없으면(조회 실패) null이라 생략한다. */
fun formatNationalLine(percent: Double?, format: String): String? = percent?.let { String.format(Locale.US, format, formatPercent(it)) }

/**
 * 화면이 읽는 도로 색칠 결과 상태. 트립이 서버에 끝났다고 알려지면([onTripEnded]) 워커에서 폴링하고,
 * 서비스 시작 때 전국 완료율을 1회 받는다([refreshNational], 실패하면 값이 없는 채로 둔다). 모든 네트워크 호출은 [executor]에서 한다.
 */
class CoverageTracker(
    private val api: CoverageApi,
    private val executor: Executor,
    private val vehicleId: () -> String?,
    private val poller: MatchingPoller = MatchingPoller(api),
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) {
    @Volatile
    var matching: MatchingLine = MatchingLine.None
        private set

    @Volatile
    var nationalPercent: Double? = null
        private set

    @Volatile
    private var generation = 0

    /** 서버가 트립 종료를 받았다. 가장 최근 트립의 결과만 반영한다. */
    fun onTripEnded(serverTripId: String) {
        val gen = ++generation
        matching = MatchingLine.None
        run {
            val line = poller.poll(serverTripId) { gen != generation }
            if (gen == generation) {
                matching = line
                if (line is MatchingLine.Counted) nationalPercent = line.percentAfter
            }
        }
    }

    /** 서비스 시작 때 1회. 차량 ID가 아직 없으면 최대 [waitIdMs] 기다린다. 실패하면 생략(크래시 금지). */
    fun refreshNational(waitIdMs: Long = 15_000) {
        run {
            var waited = 0L
            var id = vehicleId()
            while (id == null && waited < waitIdMs) {
                sleep(1_000)
                waited += 1_000
                id = vehicleId()
            }
            if (id != null) {
                nationalPercent = try {
                    api.getNationalPercent(id)
                } catch (e: Exception) {
                    Log.w("NubiCoverage", "전국 완료율 조회 실패: ${e.javaClass.simpleName}")
                    nationalPercent
                }
            }
        }
    }

    /** debug reset 등: 보이던 줄을 지운다. */
    fun clear() {
        generation++
        matching = MatchingLine.None
    }

    private fun run(block: () -> Unit) {
        try {
            executor.execute {
                try {
                    block()
                } catch (t: Throwable) {
                    Log.w("NubiCoverage", "도로 색칠 작업 예외: ${t.javaClass.simpleName}")
                }
            }
        } catch (t: Throwable) {
            Log.w("NubiCoverage", "도로 색칠 작업 등록 실패: ${t.javaClass.simpleName}")
        }
    }
}
