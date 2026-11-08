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

class LinesRead(val lines: List<String>, val corrupt: Int)

/**
 * 줄 단위로 암호화한 JSON Lines 파일. 복호화에 실패한 줄(키 변경·손상)은 건너뛰고 [LinesRead.corrupt]로 센다.
 * 동기화는 호출자(Uploader)가 맡는다. 파일은 append 전용이고, 보낸 항목 제거는 호출자가 컴팩션(임시 파일 → fsync → rename)으로 한다.
 * 암호화는 프로세스 안의 AES-GCM이라 IPC가 없지만, 줄이 많을수록 CPU를 쓰므로 호출자는 lock 밖에서 [encryptAll]을 부른다.
 */
class EncryptedLines(private val file: File, private val cipher: LineCipher) {
    fun read(): LinesRead {
        if (!file.exists()) return LinesRead(emptyList(), 0)
        FileIo.terminateLastLine(file)
        var corrupt = 0
        val lines = ArrayList<String>()
        file.forEachLine { raw ->
            if (raw.isBlank()) return@forEachLine
            val plain = cipher.decrypt(raw)
            if (plain == null) corrupt++ else lines.add(plain)
        }
        return LinesRead(lines, corrupt)
    }

    fun readAll(): List<String> = read().lines

    /** 복호화하지 않고 비어 있지 않은 줄 수만 센다. */
    fun countLines(): Int = if (!file.exists()) 0 else file.useLines { it.count { l -> l.isNotBlank() } }

    fun encrypt(line: String): String = cipher.encrypt(line)

    fun encryptAll(lines: List<String>): List<String> = lines.map { cipher.encrypt(it) }

    /** 이미 암호화한 줄을 파일 끝에 덧붙인다. */
    fun appendEncrypted(encrypted: List<String>) {
        if (encrypted.isEmpty()) return
        FileIo.append(file, joined(encrypted))
    }

    fun append(lines: List<String>) = appendEncrypted(encryptAll(lines))

    /** 임시 파일에 쓰고 fsync한 뒤 바꿔치기한다. */
    fun rewrite(lines: List<String>) = rewriteEncrypted(encryptAll(lines))

    fun rewriteEncrypted(encrypted: List<String>) = FileIo.writeAtomically(file, joined(encrypted))

    /** 컴팩션 1단계: 임시 파일에 쓰고 fsync한다(교체는 [commit]). lock 밖에서 부른다. */
    fun writeTmp(encrypted: List<String>): File {
        val tmp = FileIo.tmpOf(file)
        FileIo.writeSynced(tmp, joined(encrypted))
        return tmp
    }

    fun appendTmp(tmp: File, encrypted: List<String>) {
        if (encrypted.isNotEmpty()) FileIo.appendSynced(tmp, joined(encrypted))
    }

    /** 컴팩션 마지막 단계: rename만 한다. */
    fun commit(tmp: File) = FileIo.commit(tmp, file)

    private fun joined(encrypted: List<String>) = encrypted.joinToString("") { it + "\n" }.toByteArray()
}

class QueueLoad(val entries: MutableList<QueueEntry>, val corrupt: Int)

class TripQueue(file: File, cipher: LineCipher) {
    private val lines = EncryptedLines(file, cipher)

    /** 복호화·JSON 해석에 실패한 줄은 건너뛰고 [QueueLoad.corrupt]로 센다. */
    fun load(): QueueLoad {
        val read = lines.read()
        var corrupt = read.corrupt
        val entries = ArrayList<QueueEntry>(read.lines.size)
        for (l in read.lines) {
            val e = QueueCodec.decode(l)
            if (e == null) corrupt++ else entries.add(e)
        }
        return QueueLoad(entries, corrupt)
    }

    /** JSON 인코딩(NaN 등으로 [org.json.JSONException])과 암호화를 한다. lock 밖에서 부른다. */
    fun encode(entry: QueueEntry): String = lines.encrypt(QueueCodec.encode(entry))

    fun appendEncrypted(encrypted: List<String>) = lines.appendEncrypted(encrypted)

    fun append(entries: List<QueueEntry>) = lines.append(entries.map { QueueCodec.encode(it) })

    fun rewrite(entries: List<QueueEntry>) = lines.rewrite(entries.map { QueueCodec.encode(it) })

    fun encryptAll(entries: List<QueueEntry>): List<String> = lines.encryptAll(entries.map { QueueCodec.encode(it) })

    fun writeTmp(encrypted: List<String>) = lines.writeTmp(encrypted)

    fun appendTmp(tmp: File, encrypted: List<String>) = lines.appendTmp(tmp, encrypted)

    fun commit(tmp: File) = lines.commit(tmp)
}

/** 재시도 간격: 2초에서 시작해 두 배씩, 최대 5분. */
fun backoffMillis(failures: Int): Long {
    if (failures <= 0) return 0
    val shift = (failures - 1).coerceAtMost(20)
    return (2_000L shl shift).coerceAtMost(300_000L)
}
