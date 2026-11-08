package com.nubi.car.trip

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger

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
            throw HttpFailure(code, "HTTP $code $path")
        } finally {
            conn.disconnect()
        }
    }
}

enum class DrainKind { OK, RETRY, HELD }

/** [HELD]는 서버가 요청 자체를 거절해(Start 4xx 등) 항목을 버리지 않고 보류한 경우다. */
data class DrainResult(val kind: DrainKind, val uploadedPoints: Int, val message: String) {
    val ok: Boolean get() = kind == DrainKind.OK
}

/**
 * 큐를 앞에서부터 서버로 보낸다. 점은 같은 트립 것끼리 [batchSize]개씩 묶는다.
 *
 * - 네트워크 호출은 lock 밖에서 한다. lock 안에서는 head 스냅샷을 뜨고, 성공한 뒤 제거만 한다(그동안에도 [enqueue]가 막히지 않는다).
 * - 어떤 예외든 재시도로 분류한다(크래시 없음). 서버 응답은 상태 코드로 나눈다.
 *   - 408·425·429·5xx·네트워크 오류·형식 오류: 멈추고 백오프(항목 유지)
 *   - 점 배치 400(413·422 포함): 반으로 나눠 재전송, 1점까지 400이면 그 점만 dead-letter로 격리
 *   - 404(트립 없음): 저장해 둔 Start로 같은 localId의 트립을 다시 만든 뒤 재전송(한 번만)
 *   - Start·그 밖의 4xx: 버리지 않고 보류([DrainKind.HELD]). End의 영구 4xx만 dead-letter로 격리
 * - 파일은 append 전용이다. 보낸 항목 제거는 메모리에서 하고 파일은 [compactEvery]개마다·drain이 끝날 때 컴팩션한다.
 *   그 사이에 죽어도 서버가 멱등(localId, (trip, seq), end)이라 재전송은 안전하다.
 * - 점이 [maxPoints]를 넘으면 가장 오래된 종료 트립부터 통째로 지운다.
 */
class Uploader(
    private val queue: TripQueue,
    idsFile: File,
    deadLetterFile: File,
    private val api: TripApi,
    cipher: LineCipher,
    private val batchSize: Int = 100,
    private val maxPoints: Int = 50_000,
    private val compactEvery: Int = 1_000,
) {
    /** 서버에 만든 트립의 서버 id와, 404일 때 다시 만들 Start, 마지막으로 올린 점의 시각. */
    private data class Registration(val serverId: String, val start: QueueEntry.Start, val lastPointTs: Long?)

    private val lock = Any()
    private val ids = EncryptedLines(idsFile, cipher)
    private val deadLetters = EncryptedLines(deadLetterFile, cipher)
    private val entries = ArrayDeque<QueueEntry>(queue.load())
    private val registrations = loadRegistrations()
    private val points = AtomicInteger(entries.count { it is QueueEntry.Point })
    private val total = AtomicInteger(entries.size)

    val pendingPoints: Int get() = points.get()
    val pendingEntries: Int get() = total.get()

    fun enqueue(vararg added: QueueEntry) {
        if (added.isEmpty()) return
        synchronized(lock) {
            entries.addAll(added)
            points.addAndGet(added.count { it is QueueEntry.Point })
            total.addAndGet(added.size)
            queue.append(added.toList())
            enforceCap()
        }
    }

    fun clear() = synchronized(lock) {
        entries.clear()
        registrations.clear()
        points.set(0)
        total.set(0)
        queue.rewrite(emptyList())
        saveRegistrations()
    }

    /** 시작했으나 End를 못 보낸 트립(이전 프로세스가 죽은 경우)에 마지막 샘플 시각으로 End를 큐에 넣는다. 만든 End 수를 돌려준다. */
    fun recoverUnfinished(): Int = synchronized(lock) {
        val ended = entries.filterIsInstance<QueueEntry.End>().map { it.localId }.toSet()
        val started = LinkedHashMap<String, Pair<Long, Long?>>() // localId -> (startedAt, 마지막 점 시각)
        registrations.forEach { (id, r) -> started[id] = r.start.startedAtMillis to r.lastPointTs }
        entries.filterIsInstance<QueueEntry.Start>().forEach { started.putIfAbsent(it.localId, it.startedAtMillis to null) }
        val recovered = ArrayList<QueueEntry>()
        for ((id, info) in started) {
            if (id in ended) continue
            val lastQueued = entries.filterIsInstance<QueueEntry.Point>().filter { it.localId == id }.maxOfOrNull { it.point.sample.tsMillis }
            val endedAt = listOfNotNull(info.first, info.second, lastQueued).max()
            recovered.add(QueueEntry.End(id, endedAt, null))
        }
        if (recovered.isNotEmpty()) {
            Log.i(TAG, "미종료 트립 ${recovered.size}건 복구(End 추가)")
            enqueue(*recovered.toTypedArray())
        }
        recovered.size
    }

    /** dead-letter 파일의 내용(점마다 한 줄: 사유와 원본). 진단·테스트용. */
    fun readDeadLetters(): List<String> = synchronized(lock) { deadLetters.readAll() }

    fun drain(): DrainResult {
        var uploaded = 0
        var ended = 0
        var removed = 0
        var currentBatch = batchSize
        val recreated = HashSet<String>()
        try {
            while (true) {
                val step = synchronized(lock) { snapshot(currentBatch) } ?: return DrainResult(DrainKind.OK, uploaded, summary(uploaded, ended))
                try {
                    when (step) {
                        is Step.Create -> {
                            val serverId = api.createTrip(step.start)
                            synchronized(lock) {
                                if (popHead(step.entry)) {
                                    registrations[step.start.localId] = Registration(serverId, step.start, null)
                                    saveRegistrations()
                                    removed++
                                }
                            }
                        }
                        is Step.Points -> {
                            api.postPoints(step.serverId, step.batch.map { it.point })
                            synchronized(lock) {
                                if (popHead(step.batch.first())) {
                                    repeat(step.batch.size - 1) { popHead(entries.first()) }
                                    removed += step.batch.size
                                    registrations[step.localId]?.let {
                                        registrations[step.localId] = it.copy(lastPointTs = step.batch.last().point.sample.tsMillis)
                                        saveRegistrations()
                                    }
                                }
                            }
                            uploaded += step.batch.size
                        }
                        is Step.Finish -> {
                            api.endTrip(step.serverId, step.end)
                            synchronized(lock) {
                                if (popHead(step.end)) {
                                    registrations.remove(step.end.localId)
                                    saveRegistrations()
                                    removed++
                                }
                            }
                            ended++
                        }
                        is Step.Orphan -> synchronized(lock) {
                            if (step.entry is QueueEntry.Point) deadLetter(step.entry, "트립 정보 없음")
                            Log.w(TAG, "트립 정보 없는 항목 정리: ${step.entry.javaClass.simpleName}")
                            if (popHead(step.entry)) removed++
                        }
                    }
                    if (removed >= compactEvery) {
                        synchronized(lock) { queue.rewrite(entries.toList()) }
                        removed = 0
                    }
                } catch (e: HttpFailure) {
                    val action = classify(step, e, currentBatch, recreated)
                    when (action) {
                        is Action.Stop -> return DrainResult(action.kind, uploaded, action.message)
                        is Action.Retry -> {
                            currentBatch = action.batchSize ?: currentBatch
                        }
                        is Action.Isolate -> {
                            synchronized(lock) {
                                if (popHead(step.firstEntry)) {
                                    deadLetter(step.firstEntry, "HTTP ${e.status}")
                                    removed++
                                }
                            }
                            currentBatch = batchSize
                        }
                    }
                } catch (e: Exception) {
                    // IOException뿐 아니라 JSON 오류 등 모든 예외를 재시도로 본다. 여기서 새면 업로드가 영영 멈춘다.
                    Log.w(TAG, "업로드 예외: ${e.javaClass.simpleName}")
                    return DrainResult(DrainKind.RETRY, uploaded, "RETRY ${e.javaClass.simpleName}")
                }
            }
        } finally {
            synchronized(lock) { if (removed > 0) queue.rewrite(entries.toList()) }
        }
    }

    // 내부 ---------------------------------------------------------------

    private sealed interface Step {
        val firstEntry: QueueEntry

        class Create(val entry: QueueEntry.Start) : Step {
            val start get() = entry
            override val firstEntry get() = entry
        }

        class Points(val localId: String, val serverId: String, val batch: List<QueueEntry.Point>) : Step {
            override val firstEntry get() = batch.first()
        }

        class Finish(val end: QueueEntry.End, val serverId: String) : Step {
            override val firstEntry get() = end
        }

        class Orphan(val entry: QueueEntry) : Step {
            override val firstEntry get() = entry
        }
    }

    private sealed interface Action {
        class Stop(val kind: DrainKind, val message: String) : Action
        class Retry(val batchSize: Int?) : Action
        object Isolate : Action
    }

    private fun snapshot(batch: Int): Step? {
        val head = entries.firstOrNull() ?: return null
        return when (head) {
            is QueueEntry.Start -> Step.Create(head)
            is QueueEntry.Point -> {
                val reg = registrations[head.localId] ?: return Step.Orphan(head)
                val run = ArrayList<QueueEntry.Point>()
                for (e in entries) {
                    if (e !is QueueEntry.Point || e.localId != head.localId || run.size >= batch) break
                    run.add(e)
                }
                Step.Points(head.localId, reg.serverId, run)
            }
            is QueueEntry.End -> {
                val reg = registrations[head.localId] ?: return Step.Orphan(head)
                Step.Finish(head, reg.serverId)
            }
        }
    }

    private fun classify(step: Step, e: HttpFailure, currentBatch: Int, recreated: MutableSet<String>): Action {
        val s = e.status
        val retryable = s == 408 || s == 425 || s == 429 || s >= 500
        if (retryable) return Action.Stop(DrainKind.RETRY, "RETRY HTTP $s")
        return when (step) {
            is Step.Create -> Action.Stop(DrainKind.HELD, "HELD HTTP $s")
            is Step.Points -> when {
                s == 404 -> recreate(step.localId, recreated)
                s == 400 || s == 413 || s == 422 ->
                    if (step.batch.size > 1) Action.Retry(maxOf(1, step.batch.size / 2)) else Action.Isolate
                else -> Action.Stop(DrainKind.HELD, "HELD HTTP $s")
            }
            is Step.Finish -> when {
                s == 404 -> recreate(step.end.localId, recreated)
                s == 400 || s == 413 || s == 422 -> Action.Isolate
                else -> Action.Stop(DrainKind.HELD, "HELD HTTP $s")
            }
            is Step.Orphan -> Action.Stop(DrainKind.RETRY, "RETRY HTTP $s")
        }
    }

    /** 서버에 트립이 없다(404). 저장해 둔 Start로 같은 localId의 트립을 다시 만들고 재전송한다. 이미 한 번 해 봤으면 재시도로 넘긴다. */
    private fun recreate(localId: String, recreated: MutableSet<String>): Action {
        if (!recreated.add(localId)) return Action.Stop(DrainKind.RETRY, "RETRY HTTP 404")
        val reg = synchronized(lock) { registrations[localId] } ?: return Action.Stop(DrainKind.RETRY, "RETRY HTTP 404")
        return try {
            val newId = api.createTrip(reg.start)
            synchronized(lock) {
                registrations[localId]?.let {
                    registrations[localId] = it.copy(serverId = newId)
                    saveRegistrations()
                }
            }
            Action.Retry(null)
        } catch (ex: HttpFailure) {
            val retryable = ex.status == 408 || ex.status == 425 || ex.status == 429 || ex.status >= 500
            Action.Stop(if (retryable) DrainKind.RETRY else DrainKind.HELD, "${if (retryable) "RETRY" else "HELD"} HTTP ${ex.status}")
        }
    }

    /** lock을 잡고 부른다. head가 기대한 항목일 때만 제거한다(그 사이 clear·정리로 사라졌으면 건드리지 않는다). */
    private fun popHead(expected: QueueEntry): Boolean {
        if (entries.firstOrNull() !== expected) return false
        val e = entries.removeFirst()
        total.decrementAndGet()
        if (e is QueueEntry.Point) points.decrementAndGet()
        return true
    }

    private fun summary(uploaded: Int, ended: Int) = "OK $uploaded" + if (ended > 0) " END $ended" else ""

    private fun deadLetter(entry: QueueEntry, reason: String) {
        Log.w(TAG, "dead-letter: $reason")
        deadLetters.append(listOf(JSONObject().put("reason", reason).put("entry", QueueCodec.encode(entry)).toString()))
    }

    /** lock을 잡고 부른다. 점이 상한을 넘으면 가장 오래된 종료 트립부터 통째로 지운다. */
    private fun enforceCap() {
        var dropped = false
        while (points.get() > maxPoints) {
            val ended = entries.filterIsInstance<QueueEntry.End>().map { it.localId }.toSet()
            val victim = entries.firstOrNull { it.localId in ended }?.localId ?: break
            val before = points.get()
            val it = entries.iterator()
            while (it.hasNext()) {
                val e = it.next()
                if (e.localId != victim) continue
                it.remove()
                total.decrementAndGet()
                if (e is QueueEntry.Point) points.decrementAndGet()
            }
            registrations.remove(victim)
            dropped = true
            Log.w(TAG, "큐 상한 $maxPoints 초과: 가장 오래된 종료 트립 제거(점 ${before - points.get()}개)")
        }
        if (dropped) {
            queue.rewrite(entries.toList())
            saveRegistrations()
        }
    }

    private fun loadRegistrations(): MutableMap<String, Registration> {
        val map = LinkedHashMap<String, Registration>()
        for (line in ids.readAll()) {
            try {
                val o = JSONObject(line)
                val id = o.getString("id")
                map[id] = Registration(
                    o.getString("serverId"),
                    QueueEntry.Start(
                        id,
                        o.getString("vehicleId"),
                        o.getString("driverId"),
                        o.getLong("startedAt"),
                        if (o.isNull("odo")) null else o.getDouble("odo"),
                    ),
                    if (o.isNull("lastPointTs")) null else o.getLong("lastPointTs"),
                )
            } catch (e: Exception) {
                Log.w(TAG, "server-ids 줄 무시")
            }
        }
        return map
    }

    private fun saveRegistrations() {
        ids.rewrite(
            registrations.map { (id, r) ->
                JSONObject()
                    .put("id", id)
                    .put("serverId", r.serverId)
                    .put("vehicleId", r.start.vehicleId)
                    .put("driverId", r.start.driverId)
                    .put("startedAt", r.start.startedAtMillis)
                    .put("odo", r.start.odometerStartKm ?: JSONObject.NULL)
                    .put("lastPointTs", r.lastPointTs ?: JSONObject.NULL)
                    .toString()
            },
        )
    }

    private companion object {
        const val TAG = "NubiUpload"
    }
}
