package com.nubi.car.map

import com.nubi.car.trip.HttpFailure
import com.nubi.car.trip.getText
import java.net.URLEncoder
import java.util.Locale

/** 지도 서버 API(계약서 05 3장). 모든 호출은 워커 스레드에서만 부른다. */
interface MapApi {
    /** `GET /map/base`: [key] 칸의 바탕 도로와 차량 인정 정보. */
    fun getBase(key: CellKey, vehicleId: String): BaseCell

    /** `GET /map/regions`: [key] 칸의 시군구 칠. */
    fun getRegions(key: RegionCellKey, vehicleId: String): RegionCell

    /** `GET /trips/:id/live?since=`: [since] 이후 새 잠정 way만(응답의 cursor를 다음 [since]로). 서버가 그 트립을 모르면(404) null. */
    fun getLive(tripId: String, since: Long, nowMs: Long): LiveState?
}

/** [token]은 인증 토큰 공급자(T4가 채운다, 지금은 항상 null이라 헤더를 붙이지 않는다). */
class HttpMapApi(private val baseUrl: String, private val token: () -> String? = { null }) : MapApi {
    private fun bbox(b: Bbox) = String.format(Locale.US, "%.5f,%.5f,%.5f,%.5f", b.minLon, b.minLat, b.maxLon, b.maxLat)

    override fun getBase(key: CellKey, vehicleId: String): BaseCell {
        val text = getText(baseUrl, "/map/base?bbox=${bbox(key.bbox())}&z=${key.z}&vehicleId=${enc(vehicleId)}", token())
        return parseBase(text, key)
    }

    override fun getRegions(key: RegionCellKey, vehicleId: String): RegionCell {
        val text = getText(baseUrl, "/map/regions?bbox=${bbox(key.bbox())}&z=${key.z}&vehicleId=${enc(vehicleId)}", token())
        return parseRegions(text, key)
    }

    override fun getLive(tripId: String, since: Long, nowMs: Long): LiveState? {
        val text = try {
            getText(baseUrl, "/trips/${enc(tripId)}/live?since=$since", token())
        } catch (e: HttpFailure) {
            if (e.status == 404) return null
            throw e
        }
        return parseLive(text, nowMs)
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
