package com.nubi.car.trip

import com.nubi.car.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** 다시 시도해도 소용없는 실패(예: release에서 TLS 없이 VIN을 보내려는 경우). 재시도 대상이 아니다. */
class PermanentFailure(message: String) : IOException(message)

/** 서버가 2xx가 아닌 응답을 줬다. 어떻게 다룰지는 [Uploader]가 상태 코드로 분류한다. */
class HttpFailure(val status: Int, message: String) : IOException(message)

interface TripApi {
    /** 같은 [QueueEntry.Start.localId]로 다시 부르면 서버는 기존 tripId를 돌려준다(멱등). */
    fun createTrip(e: QueueEntry.Start): String
    fun postPoints(tripId: String, points: List<TripPoint>)
    fun endTrip(tripId: String, e: QueueEntry.End)

    /** UUID 대체 차량 ID를 서버 발급 ID에 잇는다(멱등). */
    fun aliasVehicle(e: QueueEntry.Alias)
}

/** 등록 응답: 서버 발급 차량 ID와 (서버 인증이 켜져 있을 때만 오는) 차량 토큰. */
data class Registration(val vehicleId: String, val token: String?)

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

    override fun aliasVehicle(e: QueueEntry.Alias) {
        post("/vehicles/alias", JSONObject().put("fromVehicleId", e.fromVehicleId).put("toVehicleId", e.toVehicleId))
    }

    private fun post(path: String, body: JSONObject): String = postJson(baseUrl, path, body)
}

/** 서버가 차량 ID를 발급한다. VIN은 이 요청 본문에만 실리고 서버는 저장·로그하지 않는다. */
interface VehicleApi {
    /** VIN을 보내 서버가 발급한 차량 ID(HMAC-SHA256 hex)를 받는다. */
    fun register(vin: String): String

    /** [register]와 같되 차량 토큰도 받는다(서버가 인증을 안 쓰면 null). 기본 구현은 토큰 없이 [register]로 위임한다. */
    fun registerWithToken(vin: String): Registration = Registration(register(vin), null)
}

class HttpVehicleApi(private val baseUrl: String) : VehicleApi {
    override fun register(vin: String): String = registerWithToken(vin).vehicleId

    override fun registerWithToken(vin: String): Registration {
        // VIN은 개인정보에 준하므로 release에서는 TLS(https)가 아니면 보내지 않는다. debug는 에뮬레이터 로컬 서버(평문)를 허용한다.
        if (!BuildConfig.DEBUG && !baseUrl.startsWith("https://")) throw PermanentFailure("TLS 필요")
        val text = postJson(baseUrl, "/vehicles/register", JSONObject().put("vin", vin), authorize = false)
        return try {
            val o = JSONObject(text)
            Registration(o.getString("vehicleId").also { require(it.isNotBlank()) }, o.optString("vehicleToken", "").takeIf { it.isNotBlank() })
        } catch (ex: Exception) {
            throw IOException("응답 형식 오류 /vehicles/register")
        }
    }
}

internal fun postJson(baseUrl: String, path: String, body: JSONObject, authorize: Boolean = true): String =
    sendJson(baseUrl, "POST", path, body, authorize)

internal fun putJson(baseUrl: String, path: String, body: JSONObject): String = sendJson(baseUrl, "PUT", path, body, true)

internal fun deleteRequest(baseUrl: String, path: String): String = sendJson(baseUrl, "DELETE", path, null, true)

/** 본문이 있는 요청(POST·PUT)과 DELETE. 토큰이 있으면 `Authorization: Bearer`를 붙이고 401·403이면 [Auth.onUnauthorized]를 부른다. */
private fun sendJson(baseUrl: String, method: String, path: String, body: JSONObject?, authorize: Boolean): String {
    val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
    try {
        conn.requestMethod = method
        conn.connectTimeout = 5_000
        conn.readTimeout = 10_000
        val token = if (authorize) Auth.token else null
        if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        return finishResponse(code, text, path, token != null)
    } finally {
        conn.disconnect()
    }
}

/** 응답 공통 처리: 2xx면 본문, 아니면 [HttpFailure]. 401·403은 재등록 훅을 부른다. 쿼리스트링(좌표·차량 ID)은 메시지에 남기지 않는다. */
internal fun finishResponse(code: Int, text: String, path: String, hadToken: Boolean): String {
    if (code in 200..299) {
        if (hadToken) Auth.onAuthorized()
        return text
    }
    if (code == 401 || code == 403) {
        try {
            Auth.onUnauthorized()
        } catch (t: Throwable) {
            // 재등록 훅의 예외가 응답 처리를 막지 않는다
        }
    }
    throw HttpFailure(code, "HTTP $code ${path.substringBefore('?')}")
}
