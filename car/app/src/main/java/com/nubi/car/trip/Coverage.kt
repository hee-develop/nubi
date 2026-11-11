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
    /** 이번 트립으로 처음 칠한 시군구 이름(사양 03 4장 `regions`). */
    val newRegions: List<String> = emptyList(),
)

interface CoverageApi {
    /** 매칭 결과. 서버가 아직 그 트립을 모르면(404) null. */
    fun getMatching(tripId: String): MatchingResponse?

    /** 전국 완료율(%). */
    fun getNationalPercent(vehicleId: String): Double

    /** 시군구 도감 요약(사양 03 5장). 구현하지 않으면 값 없음. */
    fun getRegions(vehicleId: String): RegionsSummary? = null
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
                newRegions = r?.optJSONObject("regions")?.optJSONArray("newPassedNames")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
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

    override fun getRegions(vehicleId: String): RegionsSummary {
        val text = getText(baseUrl, "/regions/summary?vehicleId=${enc(vehicleId)}")
        return try {
            RegionsSummary.fromJson(text)
        } catch (e: Exception) {
            throw IOException("응답 형식 오류 regions")
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

/** 종료 화면에 보일 줄의 의미. 문구는 [formatRoadLine]·[formatNationalCountedLine]이 strings.xml 형식으로 만든다. */
sealed interface MatchingLine {
    /** 아직 없음(트립 전, 폴링 중, 시간 초과). 화면에 아무것도 보이지 않는다. */
    data object None : MatchingLine

    data class Counted(val newKm: Double, val percentAfter: Double, val delta: Double, val newRegions: List<String> = emptyList()) : MatchingLine

    /** 집계되지 않음. [reason]은 debug 빌드에서만 괄호로 보인다. 시군구는 집계와 별개로 판정되므로 [newRegions]는 있을 수 있다. */
    data class NotCounted(val reason: String, val newRegions: List<String> = emptyList()) : MatchingLine
}

/**
 * 매칭 결과를 3초 간격으로 폴링한다. 마감은 시도 횟수가 아니라 **폴링 시작 시각 기준 [maxMs](60초)** 다(요청이 느려도 60초를 넘기지 않는다).
 * 워커 스레드에서만 부른다(메인 스레드 금지).
 * queued·running·아직 없음(404)·네트워크 오류·재시도 대기(retryable)는 계속 기다리고, 시간이 다 되면 [MatchingLine.None]이다.
 * done이면 결과(집계/미집계), 영구 실패(permanent)면 미집계.
 */
class MatchingPoller(
    private val api: CoverageApi,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    private val intervalMs: Long = 3_000,
    private val maxMs: Long = 60_000,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    fun poll(tripId: String, isCancelled: () -> Boolean = { false }): MatchingLine {
        val start = nowMs()
        while (true) {
            if (isCancelled()) return MatchingLine.None
            val line = try {
                lineOf(api.getMatching(tripId))
            } catch (e: Exception) {
                Log.w(TAG, "매칭 조회 실패: ${e.javaClass.simpleName}")
                null
            }
            if (line != null) return line
            // 다음 시도가 마감(시작 + maxMs) 이후에 시작되면 더 묻지 않는다.
            if (nowMs() - start + intervalMs >= maxMs) return MatchingLine.None
            sleep(intervalMs)
        }
    }

    /** 끝난 상태면 줄, 더 기다려야 하면 null. */
    private fun lineOf(r: MatchingResponse?): MatchingLine? {
        if (r == null) return null
        return when (r.status) {
            "done" -> when (r.outcome) {
                "counted" -> MatchingLine.Counted(r.newKm, r.percentAfter, r.percentAfter - r.percentBefore, r.newRegions)
                else -> MatchingLine.NotCounted(r.reason ?: r.outcome ?: "done", r.newRegions)
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
 * 종료 화면의 '새 도로' 줄. [roadFormat]: `새 도로 {%1$skm}`. 집계되지 않았으면 [notCounted]
 * (사유는 [debug]일 때만 [notCountedWithReason]의 `%1$s`로 보인다). 보일 줄이 없으면 null.
 */
fun formatRoadLine(line: MatchingLine, roadFormat: String, notCounted: String, notCountedWithReason: String, debug: Boolean): String? = when (line) {
    MatchingLine.None -> null
    is MatchingLine.Counted -> String.format(Locale.US, roadFormat, formatKm(line.newKm))
    is MatchingLine.NotCounted -> if (debug) String.format(Locale.US, notCountedWithReason, line.reason) else notCounted
}

/**
 * 전국 줄. 이번 주행이 집계됐으면 `전국 {x%} (+y)`([countedFormat]), 아니면 전국 완료율 [percent]를 `전국 {x%} 달렸어요`([idleFormat])로.
 * 둘 다 없으면 null.
 */
fun formatNationalCountedLine(line: MatchingLine, percent: Double?, countedFormat: String, idleFormat: String): String? =
    if (line is MatchingLine.Counted) {
        String.format(Locale.US, countedFormat, formatPercent(line.percentAfter), formatPercent(line.delta.coerceAtLeast(0.0)))
    } else {
        formatNationalLine(percent, idleFormat)
    }

/** 대기 화면 한 줄: `전국 {percent}% 달렸어요`. 값이 없으면(조회 실패) null이라 생략한다. */
fun formatNationalLine(percent: Double?, format: String): String? = percent?.let { String.format(Locale.US, format, formatPercent(it)) }

/**
 * 화면이 읽는 도로 색칠 결과 상태. 트립이 서버에 끝났다고 알려지면([onTripEnded]) 워커에서 폴링하고,
 * 서비스 시작 때 전국 완료율을 받는다([refreshNational]). 모든 네트워크 호출은 [executor]에서 한다.
 *
 * 전국 완료율은 마지막으로 성공한 값을 [cache](SharedPreferences)에 저장해, 오프라인·조회 실패 때도 그 값을 보인다.
 * 조회가 실패하면 [retryDelayMs](30초) 뒤 한 번만 더 시도한다.
 */
class CoverageTracker(
    private val api: CoverageApi,
    private val executor: Executor,
    private val vehicleId: () -> String?,
    private val poller: MatchingPoller = MatchingPoller(api),
    /** 지연 예약. 기본은 데몬 스케줄러 스레드 하나(콜백은 곧바로 [executor]로 넘어가 짧게 끝난다). 테스트는 가짜를 꽂는다. */
    private val schedule: (Long, () -> Unit) -> Unit = defaultSchedule,
    private val cache: KeyValueStore? = null,
    private val retryDelayMs: Long = 30_000,
) {
    @Volatile
    var matching: MatchingLine = MatchingLine.None
        private set

    @Volatile
    var nationalPercent: Double? = try {
        cache?.getString(KEY_NATIONAL)?.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0.0 }
    } catch (t: Throwable) {
        null
    }
        private set

    /** 시군구 도감 요약. 마지막으로 성공한 값을 캐시해 오프라인에서도 보인다(전국 완료율과 같은 패턴). */
    @Volatile
    var regions: RegionsSummary? = try {
        RegionsSummary.decode(cache?.getString(KEY_REGIONS))
    } catch (t: Throwable) {
        null
    }
        private set

    /** 이번 종료 화면의 `처음 지난 곳`. */
    val newRegions: List<String>
        get() = when (val m = matching) {
            is MatchingLine.Counted -> m.newRegions
            is MatchingLine.NotCounted -> m.newRegions
            MatchingLine.None -> emptyList()
        }

    @Volatile
    private var generation = 0

    /** 트립 종료 뒤 매칭 폴링이 끝났다(결과가 없어도). 정차 화면의 '지금 있는 곳' 단계를 다시 받는 데 쓴다. 워커 스레드에서 불린다. */
    @Volatile
    var onTripSettled: () -> Unit = {}

    /** 서버가 트립 종료를 받았다. 가장 최근 트립의 결과만 반영한다. */
    fun onTripEnded(serverTripId: String) {
        val gen = ++generation
        matching = MatchingLine.None
        run {
            val line = poller.poll(serverTripId) { gen != generation }
            if (gen == generation) {
                matching = line
                if (line is MatchingLine.Counted) setNational(line.percentAfter)
                // 방문·숙박은 이 트립의 Start 때 확정됐을 수 있으니(사양 03 4장) 매칭이 끝난 뒤 도감을 다시 받는다.
                if (line != MatchingLine.None) vehicleId()?.let { fetchRegions(it) }
                try {
                    onTripSettled()
                } catch (t: Throwable) {
                    Log.w("NubiCoverage", "트립 종료 알림 예외: ${t.javaClass.simpleName}")
                }
            }
        }
    }

    /** 새 트립이 시작됐다: 이전 트립의 종료 줄을 치우고 진행 중이던 폴링을 멈춘다. 전국 완료율은 새로 받아 둔다(그 결과가 아직 반영 전일 수 있다). */
    fun onTripStarted() {
        generation++
        matching = MatchingLine.None
        refreshNational()
        refreshRegions() // 사양 03 10장: 서비스 시작·새 트립 시작·매칭 종료 뒤에 도감 조회
    }

    /** 서비스 시작 때 전국 완료율을 받는다. 차량 ID가 아직 없으면 최대 [waitIdMs] 동안 1초 간격으로 **예약**해 다시 본다(executor를 붙잡고 자지 않는다). */
    fun refreshNational(waitIdMs: Long = 15_000) = refreshWhenIdKnown(waitIdMs, 0L, ::fetchNational)

    /** 서비스 시작 때 시군구 도감을 받는다(재시도 규칙은 [refreshNational]과 같다). */
    fun refreshRegions(waitIdMs: Long = 15_000) = refreshWhenIdKnown(waitIdMs, 0L, ::fetchRegions)

    /** 차량 ID가 있으면 [fetch]를 돌리고, 실패하면 [retryDelayMs] 뒤 1회만 다시 예약한다. 대기·재시도 모두 [schedule]로 예약하고 실제 호출만 [executor]에서 한다. */
    private fun refreshWhenIdKnown(waitIdMs: Long, waited: Long, fetch: (String) -> Boolean) {
        run {
            val id = vehicleId()
            if (id == null) {
                if (waited < waitIdMs) schedule(ID_POLL_MS) { refreshWhenIdKnown(waitIdMs, waited + ID_POLL_MS, fetch) }
            } else if (!fetch(id)) {
                schedule(retryDelayMs) { run { fetch(id) } }
            }
        }
    }

    private fun fetchRegions(id: String): Boolean = try {
        val s = api.getRegions(id)
        if (s != null) {
            regions = s
            try {
                cache?.putString(KEY_REGIONS, s.encode())
            } catch (t: Throwable) {
                Log.w("NubiCoverage", "시군구 요약 저장 실패: ${t.javaClass.simpleName}")
            }
        }
        true
    } catch (e: Exception) {
        Log.w("NubiCoverage", "시군구 요약 조회 실패: ${e.javaClass.simpleName}")
        false
    }

    private fun fetchNational(id: String): Boolean = try {
        setNational(api.getNationalPercent(id))
        true
    } catch (e: Exception) {
        Log.w("NubiCoverage", "전국 완료율 조회 실패: ${e.javaClass.simpleName}")
        false
    }

    private fun setNational(percent: Double) {
        nationalPercent = percent
        try {
            cache?.putString(KEY_NATIONAL, percent.toString())
        } catch (t: Throwable) {
            Log.w("NubiCoverage", "전국 완료율 저장 실패: ${t.javaClass.simpleName}")
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

    private companion object {
        const val ID_POLL_MS = 1_000L
        val timer: java.util.concurrent.ScheduledExecutorService by lazy {
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "nubi-coverage-timer").apply { isDaemon = true } }
        }
        val defaultSchedule: (Long, () -> Unit) -> Unit = { delay, block -> timer.schedule(block, delay, java.util.concurrent.TimeUnit.MILLISECONDS) }
        const val KEY_NATIONAL = "nationalPercent"
        const val KEY_REGIONS = "regionsSummary"
    }
}
