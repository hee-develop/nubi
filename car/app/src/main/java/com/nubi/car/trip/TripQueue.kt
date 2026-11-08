package com.nubi.car.trip

import org.json.JSONObject
import java.io.File
import java.time.Instant

/** 로컬 큐 항목. 파일에는 한 줄에 하나씩 JSON(JSON Lines)으로 저장한다. */
sealed interface QueueEntry {
    val localId: String

    data class Start(
        override val localId: String,
        val vehicleId: String,
        val driverId: String,
        val startedAtMillis: Long,
        val odometerStartKm: Double?,
    ) : QueueEntry

    data class Point(override val localId: String, val point: TripPoint) : QueueEntry

    data class End(override val localId: String, val endedAtMillis: Long, val odometerEndKm: Double?) : QueueEntry
}

object QueueCodec {
    fun encode(e: QueueEntry): String {
        val o = JSONObject()
        o.put("id", e.localId)
        when (e) {
            is QueueEntry.Start -> {
                o.put("t", "start")
                o.put("vehicleId", e.vehicleId)
                o.put("driverId", e.driverId)
                o.put("startedAt", e.startedAtMillis)
                o.put("odo", e.odometerStartKm ?: JSONObject.NULL)
            }
            is QueueEntry.Point -> {
                val s = e.point.sample
                o.put("t", "point")
                o.put("seq", e.point.seq)
                o.put("ts", s.tsMillis)
                o.put("lat", s.lat)
                o.put("lon", s.lon)
                o.put("heading", s.headingDeg?.toDouble() ?: JSONObject.NULL)
                o.put("conf", s.confidence?.toDouble() ?: JSONObject.NULL)
                o.put("speed", s.speedKph?.toDouble() ?: JSONObject.NULL)
                o.put("gear", s.gear?.name ?: JSONObject.NULL)
            }
            is QueueEntry.End -> {
                o.put("t", "end")
                o.put("endedAt", e.endedAtMillis)
                o.put("odo", e.odometerEndKm ?: JSONObject.NULL)
            }
        }
        return o.toString()
    }

    /** 깨진 줄은 null. */
    fun decode(line: String): QueueEntry? = try {
        val o = JSONObject(line)
        val id = o.getString("id")
        when (o.getString("t")) {
            "start" -> QueueEntry.Start(id, o.getString("vehicleId"), o.getString("driverId"), o.getLong("startedAt"), o.optDoubleOrNull("odo"))
            "point" -> QueueEntry.Point(
                id,
                TripPoint(
                    o.getInt("seq"),
                    Sample(
                        o.getLong("ts"),
                        o.getDouble("lat"),
                        o.getDouble("lon"),
                        o.optDoubleOrNull("heading")?.toFloat(),
                        o.optDoubleOrNull("conf")?.toFloat(),
                        o.optDoubleOrNull("speed")?.toFloat(),
                        if (o.isNull("gear")) null else Gear.valueOf(o.getString("gear")),
                    ),
                ),
            )
            "end" -> QueueEntry.End(id, o.getLong("endedAt"), o.optDoubleOrNull("odo"))
            else -> null
        }
    } catch (e: Exception) {
        null
    }

    private fun JSONObject.optDoubleOrNull(key: String): Double? = if (isNull(key)) null else getDouble(key)
}

fun isoOf(millis: Long): String = Instant.ofEpochMilli(millis).toString()

/** 앱 내부 저장소의 JSON Lines 파일. 동기화는 호출자(Uploader)가 맡는다. */
class TripQueue(private val file: File) {
    fun load(): MutableList<QueueEntry> {
        if (!file.exists()) return mutableListOf()
        return file.readLines().mapNotNull { if (it.isBlank()) null else QueueCodec.decode(it) }.toMutableList()
    }

    fun append(entries: List<QueueEntry>) {
        if (entries.isEmpty()) return
        file.appendText(entries.joinToString("") { QueueCodec.encode(it) + "\n" })
    }

    fun rewrite(entries: List<QueueEntry>) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(entries.joinToString("") { QueueCodec.encode(it) + "\n" })
        if (!tmp.renameTo(file)) {
            file.writeText(tmp.readText())
            tmp.delete()
        }
    }
}

/** 재시도 간격: 2초에서 시작해 두 배씩, 최대 5분. */
fun backoffMillis(failures: Int): Long {
    if (failures <= 0) return 0
    val shift = (failures - 1).coerceAtMost(20)
    return (2_000L shl shift).coerceAtMost(300_000L)
}
