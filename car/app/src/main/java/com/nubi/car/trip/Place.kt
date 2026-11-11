package com.nubi.car.trip

import android.util.Log
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.Executor

/** `GET /regions/at`: 점이 속한 시군구와 이 차량의 단계(0 안 감 ~ 3 숙박). */
data class PlaceAt(val code: String, val displayName: String, val level: Int, val depop92: Boolean)

/** `GET /regions/neighbors` 항목. [lat]·[lon]은 시군구 중심점(길안내 목적지)이다. */
data class Neighbor(val code: String, val displayName: String, val level: Int, val depop92: Boolean, val lat: Double, val lon: Double)

/** 정차 화면이 읽는 '지금 있는 곳'과 '안 가 본 이웃'. 이웃은 [place]에 딸린 값이다. */
data class PlaceInfo(val place: PlaceAt?, val neighbor: Neighbor?, val neighborsAllVisited: Boolean = false)

/** 마지막 성공 조회 값이 새 위치에서 이만큼(m) 이상 떨어지면 '지금 있는 곳'으로 믿지 않고 비운다. */
const val PLACE_STALE_DISTANCE_M = 2_000.0

interface PlaceApi {
    /** 점이 속한 시군구. 못 찾으면(404) null. */
    fun getRegionAt(lat: Double, lon: Double, vehicleId: String): PlaceAt?

    /** [code] 시군구의 이웃. 서버가 정렬한 순서(안 가 본 곳 → 인구감소지역 → 이름) 그대로다. */
    fun getNeighbors(code: String, vehicleId: String): List<Neighbor>
}

class HttpPlaceApi(private val baseUrl: String) : PlaceApi {
    override fun getRegionAt(lat: Double, lon: Double, vehicleId: String): PlaceAt? {
        val path = String.format(Locale.US, "/regions/at?lat=%.6f&lon=%.6f&vehicleId=%s", lat, lon, enc(vehicleId))
        val text = try {
            getText(baseUrl, path)
        } catch (e: HttpFailure) {
            if (e.status == 404) return null
            throw e
        }
        return try {
            val o = JSONObject(text)
            PlaceAt(o.getString("code"), o.getString("displayName"), o.getInt("level"), o.getBoolean("depop92"))
        } catch (e: Exception) {
            throw IOException("응답 형식 오류 regions/at")
        }
    }

    override fun getNeighbors(code: String, vehicleId: String): List<Neighbor> {
        val text = getText(baseUrl, "/regions/neighbors?code=${enc(code)}&vehicleId=${enc(vehicleId)}")
        return try {
            val items = JSONObject(text).getJSONArray("items")
            List(items.length()) { i ->
                val o = items.getJSONObject(i)
                val c = o.getJSONObject("center")
                Neighbor(o.getString("code"), o.getString("displayName"), o.getInt("level"), o.getBoolean("depop92"), c.getDouble("lat"), c.getDouble("lon"))
            }
        } catch (e: Exception) {
            throw IOException("응답 형식 오류 regions/neighbors")
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

/**
 * 정차(P) 진입 때와 트립 종료 뒤에 [refresh]로 현재 시군구와 그 이웃을 한 번 조회한다. 모든 네트워크 호출은 [executor]에서 한다.
 * 조회에 실패하면 마지막 성공 값을 유지한다(크래시 금지). 위치는 [location](마지막 채택 위치)에서 읽고 로그에는 남기지 않는다([LogMask]).
 * 차량 ID가 아직 없으면 [ID_POLL_MS] 간격으로 예약해 최대 [WAIT_ID_MS] 동안 기다린다(executor를 붙잡고 자지 않는다).
 */
class PlaceTracker(
    private val api: PlaceApi,
    private val executor: Executor,
    private val vehicleId: () -> String?,
    private val location: () -> LatLon?,
    /** 지연 예약. 기본은 데몬 스케줄러 스레드 하나. 테스트는 가짜를 꽂는다. */
    private val schedule: (Long, () -> Unit) -> Unit = defaultSchedule,
    private val retryDelayMs: Long = 30_000,
    /** 기록 멈춤 중이면 true: `/regions/at` 호출을 포함해 위치를 서버로 보내지 않는다. */
    private val paused: () -> Boolean = { false },
) {
    @Volatile
    var info: PlaceInfo = PlaceInfo(null, null)
        private set

    private val generation = java.util.concurrent.atomic.AtomicInteger()

    /** [info]를 만든 마지막 성공 조회의 좌표. 새 위치가 여기서 [PLACE_STALE_DISTANCE_M] 이상이면 [refresh]가 옛 값을 비운다. */
    @Volatile
    private var infoAt: LatLon? = null

    /** debug reset 등: 보이던 값을 지우고 진행 중인 조회를 버린다. */
    fun clear() {
        generation.incrementAndGet()
        info = PlaceInfo(null, null)
        infoAt = null
    }

    /**
     * 조회를 시작한다. 새 위치가 마지막 성공 조회 지점에서 [PLACE_STALE_DISTANCE_M] 이상 떨어졌으면 오프라인 등으로 새 값을 못 받더라도
     * 옛 시군구가 '지금'으로 남지 않도록 먼저 비운다(화면은 상태 문구로 돌아간다).
     */
    fun refresh() {
        if (paused()) return
        val at = location()
        val last = infoAt
        if (at != null && last != null && info.place != null && haversineM(last.lat, last.lon, at.lat, at.lon) >= PLACE_STALE_DISTANCE_M) {
            info = PlaceInfo(null, null)
            infoAt = null
        }
        attempt(generation.incrementAndGet(), 0L, false)
    }

    private fun attempt(gen: Int, waited: Long, retried: Boolean) {
        run {
            if (gen != generation.get()) return@run
            if (paused()) return@run
            val id = vehicleId()
            val at = location()
            if (at == null) return@run // 위치를 아직 모르면 아무것도 하지 않는다(다음 정차·트립 종료 때 다시 조회)
            if (id == null) {
                if (waited < WAIT_ID_MS) schedule(ID_POLL_MS) { attempt(gen, waited + ID_POLL_MS, retried) }
                return@run
            }
            // 실패하면 [retryDelayMs] 뒤 한 번만 더 시도한다(그 사이 새 조회가 시작되면 세대가 달라 버린다).
            if (!fetch(gen, at, id) && !retried) schedule(retryDelayMs) { attempt(gen, waited, true) }
        }
    }

    /** 서버와 통신이 됐으면 true(결과가 없음이어도), 실패하면 false. */
    private fun fetch(gen: Int, at: LatLon, id: String): Boolean {
        try {
            val place = api.getRegionAt(at.lat, at.lon, id)
            if (gen != generation.get()) return true
            if (place == null) {
                info = PlaceInfo(null, null) // 한국 밖 등: 확정된 '모름'이라 이전 값을 지운다
                infoAt = null
                return true
            }
            var neighbor: Neighbor? = null
            var allVisited = false
            try {
                val list = api.getNeighbors(place.code, id)
                // '안 가 본 이웃'이므로 level 0인 첫 항목만 쓴다(서버가 안 가 본 곳을 앞에 둔다). 하나도 없으면 모두 가 본 것이다.
                neighbor = list.firstOrNull { it.level == 0 }
                allVisited = neighbor == null && list.isNotEmpty()
            } catch (e: Exception) {
                Log.w(TAG, "이웃 조회 실패: ${e.javaClass.simpleName}")
                // 같은 시군구면 마지막 이웃을 유지하고, 다른 시군구로 옮겼으면 옛 이웃을 버린다
                if (info.place?.code == place.code) {
                    neighbor = info.neighbor
                    allVisited = info.neighborsAllVisited
                }
            }
            if (gen == generation.get()) {
                info = PlaceInfo(place, neighbor, allVisited)
                infoAt = at
            }
            return true
        } catch (e: Exception) {
            Log.w(TAG, "현재 시군구 조회 실패: ${e.javaClass.simpleName}") // 마지막 성공 값 유지
            return false
        }
    }

    private fun run(block: () -> Unit) {
        try {
            executor.execute {
                try {
                    block()
                } catch (t: Throwable) {
                    Log.w(TAG, "시군구 조회 작업 예외: ${t.javaClass.simpleName}")
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "시군구 조회 작업 등록 실패: ${t.javaClass.simpleName}")
        }
    }

    companion object {
        private const val TAG = "NubiPlace"
        const val ID_POLL_MS = 1_000L
        const val WAIT_ID_MS = 15_000L
        private val timer: java.util.concurrent.ScheduledExecutorService by lazy {
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "nubi-place-timer").apply { isDaemon = true } }
        }
        private val defaultSchedule: (Long, () -> Unit) -> Unit = { delay, block -> timer.schedule(block, delay, java.util.concurrent.TimeUnit.MILLISECONDS) }
    }
}
