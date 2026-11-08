package com.nubi.car.trip

import com.nubi.car.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** 서버가 2xx가 아닌 응답을 줬다. 어떻게 다룰지는 [Uploader]가 상태 코드로 분류한다. */
class HttpFailure(val status: Int, message: String) : IOException(message)

interface TripApi {
    /** 같은 [QueueEntry.Start.localId]로 다시 부르면 서버는 기존 tripId를 돌려준다(멱등). */
    fun createTrip(e: QueueEntry.Start): String
    fun postPoints(tripId: String, points: List<TripPoint>)
    fun endTrip(tripId: String, e: QueueEntry.End)
}

class HttpTripApi(private val baseUrl: String) : TripApi {
    override fun createTrip(e: QueueEntry.Start): String {
        val body = JSONObject()
            .put("localId", e.localId)
            .put("vehicleId", e.vehicleId)
            .put("driverId", e.driverId)
            .put("startedAt", isoOf(e.startedAtMillis))
            .put("odometerStartKm", e.odometerStartKm ?: JSONObject.NULL)
        val text = post("/trips", body)
        // 2xx인데 JSON이 아닌 응답(프록시·캡티브 포털 등)은 성공으로 치지 않는다.
        return try {
            JSONObject(text).getString("tripId")
        } catch (ex: Exception) {
            throw IOException("응답 형식 오류 /trips")
        }
    }

    override fun postPoints(tripId: String, points: List<TripPoint>) {
        val arr = JSONArray()
        points.forEach { p ->
            val s = p.sample
            arr.put(
                JSONObject()
                    .put("seq", p.seq)
                    .put("ts", isoOf(s.tsMillis))
                    .put("lat", s.lat)
                    .put("lon", s.lon)
                    .put("headingDeg", s.headingDeg?.toDouble() ?: JSONObject.NULL)
                    .put("confidence", s.confidence?.toDouble() ?: JSONObject.NULL)
                    .put("gear", s.gear?.name ?: JSONObject.NULL),
            )
        }
        post("/trips/$tripId/points", JSONObject().put("points", arr))
    }

    override fun endTrip(tripId: String, e: QueueEntry.End) {
        post("/trips/$tripId/end", JSONObject().put("endedAt", isoOf(e.endedAtMillis)).put("odometerEndKm", e.odometerEndKm ?: JSONObject.NULL))
    }

    private fun post(path: String, body: JSONObject): String = postJson(baseUrl, path, body)
}

/** 서버가 차량 ID를 발급한다. VIN은 이 요청 본문에만 실리고 서버는 저장·로그하지 않는다. */
interface VehicleApi {
    /** VIN을 보내 서버가 발급한 차량 ID(HMAC-SHA256 hex)를 받는다. */
    fun register(vin: String): String
}

class HttpVehicleApi(private val baseUrl: String) : VehicleApi {
    override fun register(vin: String): String {
        // VIN은 개인정보에 준하므로 release에서는 TLS(https)가 아니면 보내지 않는다. debug는 에뮬레이터 로컬 서버(평문)를 허용한다.
        if (!BuildConfig.DEBUG && !baseUrl.startsWith("https://")) throw IOException("TLS 필요")
        val text = postJson(baseUrl, "/vehicles/register", JSONObject().put("vin", vin))
        return try {
            JSONObject(text).getString("vehicleId").also { require(it.isNotBlank()) }
        } catch (ex: Exception) {
            throw IOException("응답 형식 오류 /vehicles/register")
        }
    }
}

internal fun postJson(baseUrl: String, path: String, body: JSONObject): String {
    val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
    try {
        conn.requestMethod = "POST"
        conn.connectTimeout = 5_000
        conn.readTimeout = 10_000
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code in 200..299) return text
        throw HttpFailure(code, "HTTP $code $path")
    } finally {
        conn.disconnect()
    }
}
