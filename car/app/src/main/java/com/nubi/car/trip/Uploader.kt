package com.nubi.car.trip

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** 서버가 요청을 영구히 거절했다(4xx). 재시도해도 소용없다. */
class PermanentFailure(val status: Int, message: String) : IOException(message)

interface TripApi {
    fun createTrip(e: QueueEntry.Start): String
    fun postPoints(tripId: String, points: List<TripPoint>)
    fun endTrip(tripId: String, e: QueueEntry.End)
}

class HttpTripApi(private val baseUrl: String) : TripApi {
    override fun createTrip(e: QueueEntry.Start): String {
        val body = JSONObject()
            .put("vehicleId", e.vehicleId)
            .put("driverId", e.driverId)
            .put("startedAt", isoOf(e.startedAtMillis))
            .put("odometerStartKm", e.odometerStartKm ?: JSONObject.NULL)
        return JSONObject(post("/trips", body)).getString("tripId")
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
                    .put("speedKph", s.speedKph?.toDouble() ?: JSONObject.NULL)
                    .put("gear", s.gear?.name ?: JSONObject.NULL),
            )
        }
        post("/trips/$tripId/points", JSONObject().put("points", arr))
    }

    override fun endTrip(tripId: String, e: QueueEntry.End) {
        post("/trips/$tripId/end", JSONObject().put("endedAt", isoOf(e.endedAtMillis)).put("odometerEndKm", e.odometerEndKm ?: JSONObject.NULL))
    }

    private fun post(path: String, body: JSONObject): String {
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
            if (code in 400..499) throw PermanentFailure(code, "HTTP $code $path")
            throw IOException("HTTP $code $path")
        } finally {
            conn.disconnect()
        }
    }
}

data class DrainResult(val ok: Boolean, val uploadedPoints: Int, val message: String)

/**
 * 큐를 앞에서부터 서버로 보낸다. 점은 같은 트립 것끼리 [batchSize]개씩 묶는다.
 * 네트워크 오류(IOException)는 거기서 멈추고 항목을 남긴다. 4xx는 그 항목(404면 그 트립 전체)을 버린다.
 * 모든 메서드는 같은 락으로 직렬화한다.
 */
class Uploader(
    private val queue: TripQueue,
    private val idsFile: File,
    private val api: TripApi,
    private val batchSize: Int = 100,
) {
    private val lock = Any()
    private val entries: MutableList<QueueEntry> = queue.load()
    private val serverIds: MutableMap<String, String> = loadIds()

    val pendingPoints: Int get() = synchronized(lock) { entries.count { it is QueueEntry.Point } }
    val pendingEntries: Int get() = synchronized(lock) { entries.size }

    fun enqueue(vararg added: QueueEntry) = synchronized(lock) {
        entries.addAll(added)
        queue.append(added.toList())
    }

    fun clear() = synchronized(lock) {
        entries.clear()
        serverIds.clear()
        queue.rewrite(emptyList())
        saveIds()
    }

    fun drain(): DrainResult = synchronized(lock) {
        var uploaded = 0
        var ended = 0
        while (entries.isNotEmpty()) {
            val head = entries.first()
            try {
                when (head) {
                    is QueueEntry.Start -> {
                        serverIds[head.localId] = api.createTrip(head)
                        saveIds()
                        entries.removeAt(0)
                    }
                    is QueueEntry.Point -> {
                        val tripId = serverIds[head.localId]
                        val batch = entries.takeWhile { it is QueueEntry.Point && it.localId == head.localId }.take(batchSize).map { (it as QueueEntry.Point).point }
                        if (tripId == null) {
                            repeat(batch.size) { entries.removeAt(0) }
                        } else {
                            api.postPoints(tripId, batch)
                            repeat(batch.size) { entries.removeAt(0) }
                            uploaded += batch.size
                        }
                    }
                    is QueueEntry.End -> {
                        val tripId = serverIds[head.localId]
                        if (tripId != null) api.endTrip(tripId, head)
                        serverIds.remove(head.localId)
                        saveIds()
                        entries.removeAt(0)
                        ended++
                    }
                }
                queue.rewrite(entries)
            } catch (e: PermanentFailure) {
                if (e.status == 404) {
                    entries.removeAll { it.localId == head.localId }
                    serverIds.remove(head.localId)
                } else {
                    entries.removeAt(0)
                }
                queue.rewrite(entries)
                saveIds()
            } catch (e: IOException) {
                return DrainResult(false, uploaded, "실패: ${e.message ?: e.javaClass.simpleName}")
            }
        }
        DrainResult(true, uploaded, "성공: ${uploaded}점" + if (ended > 0) ", 트립 종료 ${ended}건" else "")
    }

    private fun loadIds(): MutableMap<String, String> {
        if (!idsFile.exists()) return mutableMapOf()
        return try {
            val o = JSONObject(idsFile.readText())
            o.keys().asSequence().associateWith { o.getString(it) }.toMutableMap()
        } catch (e: Exception) {
            mutableMapOf()
        }
    }

    private fun saveIds() {
        idsFile.writeText(JSONObject(serverIds as Map<*, *>).toString())
    }
}
