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

    /** `GET /trips/:id/live`. 서버가 그 트립을 모르면(404) null. */
    fun getLive(tripId: String, nowMs: Long): LiveState?
}

class HttpMapApi(private val baseUrl: String) : MapApi {
    private fun bbox(b: Bbox) = String.format(Locale.US, "%.5f,%.5f,%.5f,%.5f", b.minLon, b.minLat, b.maxLon, b.maxLat)

    override fun getBase(key: CellKey, vehicleId: String): BaseCell {
        val text = getText(baseUrl, "/map/base?bbox=${bbox(key.bbox())}&z=${key.z}&vehicleId=${enc(vehicleId)}")
        return parseBase(text, key)
    }

    override fun getRegions(key: RegionCellKey, vehicleId: String): RegionCell {
        val text = getText(baseUrl, "/map/regions?bbox=${bbox(key.bbox())}&z=${key.z}&vehicleId=${enc(vehicleId)}")
        return parseRegions(text, key)
    }

    override fun getLive(tripId: String, nowMs: Long): LiveState? {
        val text = try {
            getText(baseUrl, "/trips/${enc(tripId)}/live")
        } catch (e: HttpFailure) {
            if (e.status == 404) return null
            throw e
        }
        return parseLive(text, nowMs)
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
