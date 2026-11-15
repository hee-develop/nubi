package com.nubi.car.screens

import android.util.Log
import com.nubi.car.trip.HttpFailure
import com.nubi.car.trip.LatLon
import java.util.concurrent.Executor

/**
 * 지금 시군구의 지역 소개(`GET /regions/:code/intro`, 관광지·축제 카드). 화면이 정차 중에 [ensure]를 부르면 시군구가 바뀌었을 때만 워커에서 한 번 받고,
 * 실패하면 [retryMs] 동안 다시 묻지 않는다(서버가 출처별 요청 수를 제한한다: 429). 현재 위치가 그 시군구 밖이라 400이면 좌표 없이 한 번 더 묻는다.
 * 위치는 로그에 남기지 않는다.
 */
class IntroTracker(
    private val api: ExtrasApi,
    private val executor: Executor,
    private val elapsedMs: () -> Long,
    private val retryMs: Long = 60_000L,
) {
    @Volatile
    var intro: Intro? = null
        private set

    private var inflightCode: String? = null
    private var failedCode: String? = null
    private var failedAt = 0L

    /** [code] 시군구의 소개가 필요하다. 이미 있거나 받는 중이거나 최근에 실패했으면 아무것도 하지 않는다. 메인 스레드에서 부른다. */
    @Synchronized
    fun ensure(code: String?, loc: LatLon?) {
        if (code == null) return
        if (intro?.code == code || inflightCode == code) return
        if (failedCode == code && elapsedMs() - failedAt < retryMs) return
        inflightCode = code
        try {
            executor.execute { fetch(code, loc) }
        } catch (t: Throwable) {
            inflightCode = null
            Log.w(TAG, "소개 작업 등록 실패: ${t.javaClass.simpleName}")
        }
    }

    private fun fetch(code: String, loc: LatLon?) {
        var result: Intro? = null
        try {
            result = try {
                api.intro(code, loc?.lat, loc?.lon)
            } catch (e: HttpFailure) {
                if (e.status == 400 && loc != null) api.intro(code, null, null) else throw e
            }
        } catch (e: Exception) {
            Log.w(TAG, "지역 소개 조회 실패: ${e.javaClass.simpleName}")
        }
        synchronized(this) {
            inflightCode = null
            if (result != null) {
                intro = result
                failedCode = null
            } else {
                failedCode = code
                failedAt = elapsedMs()
            }
        }
    }

    @Synchronized
    fun clear() {
        intro = null
        failedCode = null
    }

    private companion object {
        const val TAG = "NubiIntro"
    }
}
