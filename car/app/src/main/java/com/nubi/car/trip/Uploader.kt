package com.nubi.car.trip

import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

enum class DrainKind { OK, RETRY, HELD }

/** [HELD]는 서버가 요청 자체를 거절해(Start 4xx 등) 항목을 버리지 않고 보류한 트립이 남은 경우다. */
data class DrainResult(val kind: DrainKind, val uploadedPoints: Int, val message: String, val endedTrips: Int = 0) {
    val ok: Boolean get() = kind == DrainKind.OK
}

/**
 * 큐를 서버로 보낸다. 점은 같은 트립 것끼리 [batchSize]개씩 묶는다.
 *
 * 스레드·lock 규칙
 * - 파일을 읽고 복호화하는 [load]는 워커 스레드에서 부른다(생성자는 아무것도 읽지 않는다). 로드 전 [enqueue]는 메모리에만 쌓고 로드가 끝날 때 파일에 잇는다.
 * - lock 안에서는 메모리 목록 조작과 파일 append(한 번의 write)만 한다. JSON 인코딩·암호화는 lock 밖에서 하고,
 *   컴팩션(전체 재기록)은 lock 안에서 목록 스냅샷만 뜨고 암호화·임시 파일 쓰기·fsync는 lock 밖에서 한 뒤 rename 순간만 lock을 잡는다.
 *   컴팩션 중 들어온 항목은 이미 암호화된 줄로 꼬리(tail)에 모았다가 임시 파일에 이어 붙인다.
 * - 네트워크 호출도 lock 밖이다.
 *
 * 서버 응답 분류
 * - 408·425·429·5xx·네트워크 오류·형식 오류: 멈추고 백오프(항목 유지)
 * - 점 배치 400(413·422 포함): 반으로 나눠 재전송, 1점까지 400이면 그 점만 dead-letter로 격리. 성공하면 배치 크기를 원래대로 되돌린다
 * - 404(트립 없음): 저장해 둔 Start로 같은 localId의 트립을 다시 만든 뒤 재전송(한 번만)
 * - Start·그 밖의 4xx: 버리지 않고 **그 트립만 보류**한다(보류 트립 id 집합). drain은 보류 트립의 항목을 건너뛰고 다른 트립을 계속 올리며,
 *   보류 트립은 백오프 뒤 다시 시도한다. End의 영구 4xx(400·413·422)만 dead-letter로 격리하고 그 트립의 등록(registration)도 지워 복구 루프를 막는다
 * - 점이 [maxPoints]를 넘으면 가장 오래된 종료 트립부터 통째로 지운다(메모리에서 바로, 파일은 다음 컴팩션에서)
 */
class Uploader(
    private val queueFile: File,
    private val idsFile: File,
    private val deadLetterFile: File,
    private val api: TripApi,
    private val cipherSetup: () -> CipherSetup,
    private val batchSize: Int = 100,
    private val maxPoints: Int = 50_000,
    private val compactEvery: Int = 1_000,
    private val deadLetterMax: Int = 5_000,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    /** 서버에 만든 트립의 서버 id와, 404일 때 다시 만들 Start, 마지막으로 올린 점의 시각. */
    private data class Registration(val serverId: String, val start: QueueEntry.Start, val lastPointTs: Long?)

    private class Held(val retryAtMs: Long, val failures: Int)

    private class Compaction {
        /** 컴팩션 중 append된, 이미 암호화된 줄. */
        val tail = ArrayList<String>()
    }

    private val lock = Any()
    private val loadLock = Any()
    private val idsLock = Any()
    private val deadLock = Any()

    private val entries = ArrayDeque<QueueEntry>()
    private val early = ArrayList<QueueEntry>()
    private val registrations = LinkedHashMap<String, Registration>()
    private val held = HashMap<String, Held>()
    private val points = AtomicInteger(0)
    private val total = AtomicInteger(0)
    private val saveFailureCount = AtomicInteger(0)

    private var structVersion = 0L
    private var compaction: Compaction? = null
    private var dirty = false
    private var clearAfterLoad = false
    private var idsVersion = 0L
    private var idsWritten = 0L
    private var deadCount = 0

    private lateinit var queue: TripQueue
    private lateinit var ids: EncryptedLines
    private lateinit var deadLetters: EncryptedLines

    @Volatile
    var loaded = false
        private set

    /**
     * 지금 점을 올리고 있는 트립의 서버 id(주행 중 지도의 잠정 색칠 조회용). 트립 생성·점 전송이 성공하면 그 트립으로 바뀌고, 그 트립의 End가 올라가면 비운다.
     * 마지막 점 업로드가 성공한 벽시계 시각은 [lastPointsUploadedAtMs](실시간 반영 지연 측정용 로그에 쓴다).
     */
    @Volatile
    var liveTripId: String? = null
        private set

    @Volatile
    var lastPointsUploadedAtMs = 0L
        private set

    /** 점 업로드가 성공할 때마다(주행 지도가 그 직후 잠정 색칠을 한 번 묻는다). 예외는 업로드에 영향을 주지 않는다. 워커 스레드에서 불린다. */
    @Volatile
    var onPointsUploaded: () -> Unit = {}

    /** 서버가 End를 받았을 때(서버 트립 id). 도로 색칠 결과 폴링을 시작하는 데 쓴다. 호출 예외는 업로드에 영향을 주지 않는다. */
    @Volatile
    var onTripEnded: (serverId: String, localId: String?) -> Unit = { _, _ -> }

    /**
     * 암호화 키를 쓸 수 없어(일시 오류로 unwrap 실패, DEK 저장 실패) 이번 실행은 디스크를 읽지도 쓰지도 않고 메모리 큐로만 동작한다.
     * 기존 파일은 그대로 두고 다음 실행에서 다시 읽는다.
     */
    @Volatile
    var memoryOnly = false
        private set

    /** 진행 중인 Create의 localId. 그 사이 상한 정리가 그 트립을 지웠는지([creatingDropped]) 알아 등록을 남기려는 것이다. lock으로 보호한다. */
    private var creatingLocalId: String? = null
    private var creatingDropped = false

    /** 복호화·해석에 실패해 건너뛴 줄 수(큐·server-ids). 이번 실행 동안 누적이 아니라 로드 때 센 값이다. */
    @Volatile
    var corruptLines = 0
        private set

    /** 새 DEK로 바뀌어 읽을 수 없게 돼 폐기한 줄 수. */
    @Volatile
    var discardedLines = 0
        private set

    /** 큐 파일 쓰기·인코딩에 실패한 횟수(누적). 0보다 크면 화면에 '저장 실패'를 보인다. */
    val saveFailures: Int get() = saveFailureCount.get()

    val pendingPoints: Int get() = points.get()
    val pendingEntries: Int get() = total.get()

    // 로드 ---------------------------------------------------------------

    /** 암호화 준비(Keystore unwrap)와 파일 읽기·복호화를 한다. **워커 스레드에서** 부른다. 여러 번 불러도 한 번만 한다. */
    fun load() {
        synchronized(loadLock) {
            if (loaded) return
            val setup = try {
                cipherSetup()
            } catch (t: Throwable) {
                Log.w(TAG, "암호화 준비 예외, 임시 키로 진행: ${t.javaClass.simpleName}")
                CipherSetup(AesGcmCipher.fromBytes(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }), 0, false, true)
            }
            memoryOnly = !setup.persistent
            discardedLines = setup.discardedLines
            queue = TripQueue(queueFile, setup.cipher)
            ids = EncryptedLines(idsFile, setup.cipher)
            deadLetters = EncryptedLines(deadLetterFile, setup.cipher)
            var corrupt = 0
            val fileEntries: MutableList<QueueEntry> = if (memoryOnly) {
                ArrayList() // 임시 키로는 기존 파일을 읽을 수 없고, 읽은 줄을 '손상'으로 세어 다시 쓰면 안 되므로 건드리지 않는다
            } else try {
                queue.load().also { corrupt += it.corrupt }.entries
            } catch (t: Exception) {
                Log.w(TAG, "큐 파일 읽기 실패: ${t.javaClass.simpleName}")
                saveFailureCount.incrementAndGet()
                ArrayList()
            }
            val regs = if (memoryOnly) LinkedHashMap() else try {
                loadRegistrations().also { corrupt += it.second }.first
            } catch (t: Exception) {
                Log.w(TAG, "server-ids 읽기 실패: ${t.javaClass.simpleName}")
                LinkedHashMap()
            }
            synchronized(deadLock) { deadCount = if (memoryOnly) 0 else try { deadLetters.countLines() } catch (t: Exception) { 0 } }
            corruptLines = corrupt
            if (corrupt > 0) Log.w(TAG, "복호화·해석 실패로 건너뛴 줄: ${corrupt}줄(큐·server-ids)")

            // 로드 전에 들어온 항목을 암호화해 파일에 잇는다. 암호화는 lock 밖에서 하고, 그 사이 더 들어왔으면 한 번 더 돈다.
            var done = false
            while (!done) {
                val batch = synchronized(lock) { early.toList() }
                val lines = if (memoryOnly) emptyList() else batch.mapNotNull { e -> try { queue.encode(e) } catch (t: Exception) { null } }
                var removedVictims = false
                synchronized(lock) {
                    if (early.size != batch.size) return@synchronized
                    if (clearAfterLoad) {
                        fileEntries.clear()
                        regs.clear()
                        dirty = true
                    }
                    entries.addAll(fileEntries)
                    entries.addAll(early)
                    points.addAndGet(fileEntries.count { it is QueueEntry.Point })
                    total.addAndGet(fileEntries.size)
                    registrations.putAll(regs)
                    try {
                        queue.appendEncrypted(lines)
                    } catch (t: Exception) {
                        saveFailureCount.incrementAndGet()
                    }
                    early.clear()
                    // 저장된 Alias(보내기 전에 종료된 경우 포함)를 아직 안 보낸 Start에 다시 적용한다.
                    entries.filterIsInstance<QueueEntry.Alias>().forEach { applyAlias(it) }
                    if (corrupt > 0) dirty = true
                    removedVictims = enforceCap()
                    loaded = true
                    done = true
                }
                if (done && removedVictims) saveRegistrations()
            }
            Log.i(TAG, "큐 로드 ${total.get()}항목, 손상 $corrupt, 폐기 ${setup.discardedLines}, 키 영속=${setup.persistent}")
        }
    }

    // 쓰기 ---------------------------------------------------------------

    /**
     * 항목을 큐에 넣는다. 인코딩 예외(NaN 등)는 그 항목만 버리고, 파일 쓰기 예외는 메모리에는 남긴다(이번 실행에서는 업로드된다).
     * 어느 쪽이든 [saveFailures]를 올리고 false를 돌려줄 뿐 예외를 던지지 않는다.
     */
    fun enqueue(vararg added: QueueEntry): Boolean {
        if (added.isEmpty()) return true
        var ok = true
        val canEncrypt = loaded && !memoryOnly
        val prepared = ArrayList<Pair<QueueEntry, String?>>(added.size)
        for (e in added) {
            try {
                prepared.add(e to if (canEncrypt) queue.encode(e) else QueueCodec.encode(e).let { null })
            } catch (t: Exception) {
                ok = false
                saveFailureCount.incrementAndGet()
                Log.w(TAG, "큐 항목 인코딩 실패, 버림: ${t.javaClass.simpleName}")
            }
        }
        var victims = false
        synchronized(lock) {
            val accepted = ArrayList<Pair<QueueEntry, String?>>(prepared.size)
            for (p in prepared) {
                val e = p.first
                // 같은 트립의 End는 하나만 둔다(복구 End와 원래 End가 겹치는 경우).
                if (e is QueueEntry.End && hasEnd(e.localId, accepted)) {
                    Log.i(TAG, "이미 End가 큐에 있어 건너뜀")
                    continue
                }
                accepted.add(p)
            }
            if (accepted.isEmpty()) return ok
            val newEntries = accepted.map { it.first }
            points.addAndGet(newEntries.count { it is QueueEntry.Point })
            total.addAndGet(newEntries.size)
            if (!loaded) {
                early.addAll(newEntries)
                return ok
            }
            entries.addAll(newEntries)
            newEntries.filterIsInstance<QueueEntry.Alias>().forEach { applyAlias(it) }
            if (!memoryOnly) {
                // 로드 직전에 경합해 아직 암호화하지 못한 항목은 여기서 암호화한다(드문 경우).
                val lines = accepted.mapNotNull { p -> p.second ?: try { queue.encode(p.first) } catch (t: Exception) { null } }
                try {
                    queue.appendEncrypted(lines)
                } catch (t: Exception) {
                    ok = false
                    saveFailureCount.incrementAndGet()
                    Log.w(TAG, "큐 파일 쓰기 실패: ${t.javaClass.simpleName}")
                }
                compaction?.tail?.addAll(lines)
            }
            victims = enforceCap()
        }
        if (victims) saveRegistrations()
        return ok
    }

    /**
     * lock을 잡고 부른다. 큐에 남은(아직 서버에 안 보낸) Start 중 차량 ID가 [alias]의 from인 것을 to로 바꾼다.
     * 이미 서버에 올라간 트립은 서버의 alias 테이블이 잇는다. 파일은 다음 컴팩션(dirty)에서 바뀐다. 바꾼 개수를 돌려준다.
     */
    private fun applyAlias(alias: QueueEntry.Alias): Int {
        var changed = 0
        fun swap(list: MutableList<QueueEntry>) {
            for (i in list.indices) {
                val e = list[i]
                if (e is QueueEntry.Start && e.vehicleId == alias.fromVehicleId) {
                    list[i] = e.copy(
                        vehicleId = alias.toVehicleId,
                        driverId = if (e.driverId == alias.fromVehicleId) alias.toVehicleId else e.driverId,
                    )
                    changed++
                }
            }
        }
        swap(entries)
        swap(early)
        if (changed > 0) {
            structVersion++
            dirty = true
        }
        return changed
    }

    /** lock을 잡고 부른다. */
    private fun hasEnd(localId: String, pending: List<Pair<QueueEntry, String?>>): Boolean =
        entries.any { it is QueueEntry.End && it.localId == localId } ||
            early.any { it is QueueEntry.End && it.localId == localId } ||
            pending.any { it.first is QueueEntry.End && it.first.localId == localId }

    fun clear() {
        synchronized(lock) {
            entries.clear()
            early.clear()
            registrations.clear()
            held.clear()
            points.set(0)
            total.set(0)
            liveTripId = null
            structVersion++
            if (loaded) {
                dirty = false
                try {
                    if (!memoryOnly) queue.rewrite(emptyList())
                } catch (t: Exception) {
                    Log.w(TAG, "큐 비우기 실패: ${t.javaClass.simpleName}")
                }
            } else {
                clearAfterLoad = true
            }
        }
        saveRegistrations()
    }

    /**
     * 시작했으나 End를 못 보낸 트립(이전 프로세스가 죽은 경우)에 마지막 샘플 시각으로 End를 큐에 넣는다. 만든 End 수를 돌려준다.
     * 큐에 그 트립의 End가 이미 있으면 건너뛰고, [exclude]한 트립(지금 진행 중인 트립)은 건드리지 않는다. 로드 전에는 아무것도 하지 않는다.
     */
    fun recoverUnfinished(exclude: Set<String> = emptySet()): Int {
        val recovered = synchronized(lock) {
            if (!loaded) return 0
            val ended = entries.filterIsInstance<QueueEntry.End>().map { it.localId }.toSet()
            val started = LinkedHashMap<String, Pair<Long, Long?>>() // localId -> (startedAt, 마지막 점 시각)
            registrations.forEach { (id, r) -> started[id] = r.start.startedAtMillis to r.lastPointTs }
            entries.filterIsInstance<QueueEntry.Start>().forEach { started.putIfAbsent(it.localId, it.startedAtMillis to null) }
            val list = ArrayList<QueueEntry>()
            for ((id, info) in started) {
                if (id in ended || id in exclude) continue
                val lastQueued = entries.filterIsInstance<QueueEntry.Point>().filter { it.localId == id }.maxOfOrNull { it.point.sample.tsMillis }
                val endedAt = listOfNotNull(info.first, info.second, lastQueued).max()
                list.add(QueueEntry.End(id, endedAt, null))
            }
            list
        }
        if (recovered.isEmpty()) return 0
        Log.i(TAG, "미종료 트립 ${recovered.size}건 복구(End 추가)")
        enqueue(*recovered.toTypedArray())
        return recovered.size
    }

    /** dead-letter 파일의 내용(점마다 한 줄: 사유와 원본). 진단·테스트용. */
    fun readDeadLetters(): List<String> = synchronized(deadLock) { deadLetters.readAll() }

    // 컴팩션 -------------------------------------------------------------

    /** 큐 파일을 지금 메모리 상태로 바꿔 쓴다. 예외를 던지지 않고, 못 했으면 false(다음에 다시 시도한다). */
    fun compact(): Boolean {
        val snapshot: List<QueueEntry>
        val version: Long
        synchronized(lock) {
            if (!loaded || memoryOnly || compaction != null) return false
            snapshot = entries.toList()
            version = structVersion
            compaction = Compaction()
            dirty = false
        }
        var tmp: File? = null
        try {
            val encrypted = queue.encryptAll(snapshot) // lock 밖
            val file = queue.writeTmp(encrypted) // lock 밖(fsync 포함)
            tmp = file
            var committed = false
            while (!committed) {
                var tail: List<String> = emptyList()
                synchronized(lock) {
                    if (structVersion != version) {
                        // 그 사이 상한 정리·clear로 목록이 바뀌었다. 이 스냅샷으로는 교체하지 않는다.
                        compaction = null
                        dirty = true
                        file.delete()
                        return false
                    }
                    val pending = compaction!!.tail
                    if (pending.isEmpty()) {
                        queue.commit(file) // rename만 lock 안
                        compaction = null
                        committed = true
                        return@synchronized
                    }
                    tail = ArrayList(pending)
                    pending.clear()
                }
                if (!committed) queue.appendTmp(file, tail) // lock 밖
            }
            queue.syncDir() // rename을 디스크에 남기는 fsync는 lock 밖. 실패해도 컴팩션은 성공이다(FileIo가 삼킨다)
            return true
        } catch (t: Throwable) {
            Log.w(TAG, "컴팩션 실패(다음에 다시 시도): ${t.javaClass.simpleName}")
            synchronized(lock) {
                compaction = null
                dirty = true
            }
            try {
                tmp?.delete()
            } catch (e: Exception) {
                // 지우지 못해도 다음 컴팩션이 덮어쓴다
            }
            return false
        }
    }

    // drain --------------------------------------------------------------

    fun drain(): DrainResult {
        load()
        var uploaded = 0
        var ended = 0
        var removed = 0
        var currentBatch = batchSize
        val recreated = HashSet<String>()
        try {
            while (true) {
                val step = synchronized(lock) { snapshot(currentBatch, nowMs()) }
                if (step == null) {
                    val heldTrips = synchronized(lock) { heldTripCount(nowMs()) }
                    return if (heldTrips > 0) {
                        DrainResult(DrainKind.HELD, uploaded, "HELD ${heldTrips}건")
                    } else {
                        DrainResult(DrainKind.OK, uploaded, summary(uploaded, ended), ended)
                    }
                }
                try {
                    when (step) {
                        is Step.Create -> {
                            synchronized(lock) {
                                creatingLocalId = step.start.localId
                                creatingDropped = false
                            }
                            val serverId = try {
                                api.createTrip(step.start)
                            } catch (t: Throwable) {
                                synchronized(lock) { creatingLocalId = null }
                                throw t
                            }
                            var save = false
                            synchronized(lock) {
                                val dropped = creatingDropped
                                creatingLocalId = null
                                creatingDropped = false
                                if (removeEntry(step.entry)) {
                                    registrations[step.start.localId] = Registration(serverId, step.start, null)
                                    held.remove(step.start.localId)
                                    removed++
                                    save = true
                                } else if (dropped) {
                                    // 서버에는 트립이 만들어졌는데 그 사이 상한 정리가 큐 항목을 지웠다. 등록은 남겨 다음 시작 때 복구가 End를 보내게 한다.
                                    registrations[step.start.localId] = Registration(serverId, step.start, null)
                                    held.remove(step.start.localId)
                                    save = true
                                }
                            }
                            if (save) saveRegistrations()
                            liveTripId = serverId
                        }
                        is Step.Alias -> {
                            api.aliasVehicle(step.alias)
                            synchronized(lock) {
                                if (removeEntry(step.alias)) {
                                    held.remove(step.alias.localId)
                                    removed++
                                }
                            }
                        }
                        is Step.Points -> {
                            api.postPoints(step.serverId, step.batch.map { it.point })
                            var save = false
                            synchronized(lock) {
                                if (removeEntry(step.batch.first())) {
                                    for (i in 1 until step.batch.size) removeEntry(step.batch[i])
                                    removed += step.batch.size
                                    held.remove(step.localId)
                                    registrations[step.localId]?.let {
                                        registrations[step.localId] = it.copy(lastPointTs = step.batch.last().point.sample.tsMillis)
                                        save = true
                                    }
                                }
                            }
                            if (save) saveRegistrations()
                            liveTripId = step.serverId
                            lastPointsUploadedAtMs = System.currentTimeMillis()
                            Log.i(TAG, "점 업로드 성공 ${step.batch.size}개 wall=$lastPointsUploadedAtMs")
                            try {
                                onPointsUploaded()
                            } catch (t: Throwable) {
                                Log.w(TAG, "점 업로드 알림 예외: ${t.javaClass.simpleName}")
                            }
                            uploaded += step.batch.size
                            currentBatch = batchSize // 이분할 뒤 성공했으면 원래 크기로 복원
                        }
                        is Step.Finish -> {
                            api.endTrip(step.serverId, step.end)
                            var save = false
                            synchronized(lock) {
                                if (removeEntry(step.end)) {
                                    registrations.remove(step.end.localId)
                                    held.remove(step.end.localId)
                                    removed++
                                    save = true
                                }
                            }
                            if (save) saveRegistrations()
                            ended++
                            if (liveTripId == step.serverId) liveTripId = null
                            try {
                                onTripEnded(step.serverId, step.end.localId)
                            } catch (t: Throwable) {
                                Log.w(TAG, "종료 알림 예외: ${t.javaClass.simpleName}")
                            }
                        }
                        is Step.Orphan -> {
                            if (step.entry is QueueEntry.Point) deadLetter(step.entry, "트립 정보 없음")
                            Log.w(TAG, "트립 정보 없는 항목 정리: ${step.entry.javaClass.simpleName}")
                            synchronized(lock) { if (removeEntry(step.entry)) removed++ }
                        }
                    }
                    if (removed >= compactEvery) {
                        compact()
                        removed = 0
                    }
                } catch (e: HttpFailure) {
                    val action = try {
                        classify(step, e, recreated)
                    } catch (t: Exception) {
                        Action.Stop(DrainKind.RETRY, "RETRY ${t.javaClass.simpleName}")
                    }
                    when (action) {
                        is Action.Stop -> return DrainResult(action.kind, uploaded, action.message)
                        is Action.Hold -> hold(action.localId, action.message)
                        is Action.Retry -> currentBatch = action.batchSize ?: currentBatch
                        is Action.Isolate -> {
                            deadLetter(step.firstEntry, "HTTP ${e.status}")
                            var save = false
                            synchronized(lock) {
                                if (removeEntry(step.firstEntry)) {
                                    removed++
                                    if (step is Step.Finish) {
                                        // 격리한 End의 트립은 더 복구할 것이 없다. 등록을 남기면 다음 시작 때 End를 또 만들어 같은 일을 반복한다.
                                        registrations.remove(step.end.localId)
                                        held.remove(step.end.localId)
                                        save = true
                                    }
                                }
                            }
                            if (save) saveRegistrations()
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
            if (removed > 0 || synchronized(lock) { dirty }) compact()
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

        class Alias(val alias: QueueEntry.Alias) : Step {
            override val firstEntry get() = alias
        }

        class Orphan(val entry: QueueEntry) : Step {
            override val firstEntry get() = entry
        }
    }

    private sealed interface Action {
        class Stop(val kind: DrainKind, val message: String) : Action
        class Hold(val localId: String, val message: String) : Action
        class Retry(val batchSize: Int?) : Action
        object Isolate : Action
    }

    private fun isHeld(localId: String, now: Long): Boolean = held[localId]?.let { it.retryAtMs > now } ?: false

    /** lock을 잡고 부른다. 남은 항목 중 지금 보류 중인 트립 수. */
    private fun heldTripCount(now: Long): Int = entries.asSequence().map { it.localId }.distinct().count { isHeld(it, now) }

    private fun hold(localId: String, message: String) {
        synchronized(lock) {
            val failures = (held[localId]?.failures ?: 0) + 1
            held[localId] = Held(nowMs() + backoffMillis(failures), failures)
        }
        Log.w(TAG, "트립 보류($message)")
    }

    /** lock을 잡고 부른다. 보류 중이 아닌 첫 항목에서 다음 전송 단위를 정한다(보류 트립의 항목은 건너뛴다). */
    private fun snapshot(batch: Int, now: Long): Step? {
        val head = entries.firstOrNull { !isHeld(it.localId, now) } ?: return null
        return when (head) {
            is QueueEntry.Start -> Step.Create(head)
            is QueueEntry.Alias -> Step.Alias(head)
            is QueueEntry.Point -> {
                val reg = registrations[head.localId] ?: return Step.Orphan(head)
                val run = ArrayList<QueueEntry.Point>()
                for (e in entries) {
                    if (e.localId != head.localId) continue // 다른 트립(보류 중인 것 포함)은 건너뛴다
                    if (e !is QueueEntry.Point || run.size >= batch) break
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

    private fun classify(step: Step, e: HttpFailure, recreated: MutableSet<String>): Action {
        val s = e.status
        if (isRetryable(s)) return Action.Stop(DrainKind.RETRY, "RETRY HTTP $s")
        val id = step.firstEntry.localId
        return when (step) {
            is Step.Create -> Action.Hold(id, "HELD HTTP $s")
            is Step.Points -> when {
                s == 404 -> recreate(step.localId, recreated)
                s == 400 || s == 413 || s == 422 ->
                    if (step.batch.size > 1) Action.Retry(maxOf(1, step.batch.size / 2)) else Action.Isolate
                else -> Action.Hold(id, "HELD HTTP $s")
            }
            is Step.Finish -> when {
                s == 404 -> recreate(step.end.localId, recreated)
                s == 400 || s == 413 || s == 422 -> Action.Isolate
                else -> Action.Hold(id, "HELD HTTP $s")
            }
            is Step.Alias -> when {
                // 400·409 등은 다시 보내도 같으니 dead-letter로 격리한다(보류하면 영영 재시도한다). 404(서버가 아직 모름)는 보류.
                s == 404 -> Action.Hold(id, "HELD HTTP $s")
                else -> Action.Isolate
            }
            is Step.Orphan -> Action.Stop(DrainKind.RETRY, "RETRY HTTP $s")
        }
    }

    private fun isRetryable(s: Int) = s == 408 || s == 425 || s == 429 || s >= 500

    /**
     * 서버에 트립이 없다(404). 저장해 둔 Start로 같은 localId의 트립을 다시 만들고 재전송한다. 이미 한 번 해 봤으면 재시도로 넘긴다.
     * 다시 만드는 호출의 예외는 HTTP든 네트워크·JSON이든 여기서 분류해 밖으로 새지 않는다.
     */
    private fun recreate(localId: String, recreated: MutableSet<String>): Action {
        if (!recreated.add(localId)) return Action.Stop(DrainKind.RETRY, "RETRY HTTP 404")
        val reg = synchronized(lock) { registrations[localId] } ?: return Action.Stop(DrainKind.RETRY, "RETRY HTTP 404")
        return try {
            val newId = api.createTrip(reg.start)
            var save = false
            synchronized(lock) {
                registrations[localId]?.let {
                    registrations[localId] = it.copy(serverId = newId)
                    save = true
                }
            }
            if (save) saveRegistrations()
            Action.Retry(null)
        } catch (ex: HttpFailure) {
            if (isRetryable(ex.status)) Action.Stop(DrainKind.RETRY, "RETRY HTTP ${ex.status}") else Action.Hold(localId, "HELD HTTP ${ex.status}")
        } catch (ex: Exception) {
            Action.Stop(DrainKind.RETRY, "RETRY ${ex.javaClass.simpleName}")
        }
    }

    /** lock을 잡고 부른다. [expected]와 같은 객체를 목록에서 찾아 지운다(그 사이 clear·정리로 사라졌으면 건드리지 않는다). */
    private fun removeEntry(expected: QueueEntry): Boolean {
        // Start는 그 사이 [applyAlias]로 차량 ID만 바뀐 사본으로 교체됐을 수 있어 localId로도 찾는다.
        val i = entries.indexOfFirst { it === expected || (expected is QueueEntry.Start && it is QueueEntry.Start && it.localId == expected.localId) }
        if (i < 0) return false
        val e = entries.removeAt(i)
        structVersion++
        total.decrementAndGet()
        if (e is QueueEntry.Point) points.decrementAndGet()
        return true
    }

    private fun summary(uploaded: Int, ended: Int) = "OK $uploaded" + if (ended > 0) " END $ended" else ""

    /** 격리 항목을 dead-letter 파일에 남긴다. 파일은 [deadLetterMax]줄까지만 두고 넘으면 오래된 줄부터 버린다. 실패해도 던지지 않는다. */
    private fun deadLetter(entry: QueueEntry, reason: String) {
        Log.w(TAG, "dead-letter: $reason")
        if (memoryOnly) return // 디스크에 쓰지 않는 실행이다
        try {
            val line = JSONObject().put("reason", reason).put("entry", QueueCodec.encode(entry)).toString()
            synchronized(deadLock) {
                deadLetters.append(listOf(line))
                deadCount++
                if (deadCount > deadLetterMax) {
                    val keep = deadLetters.readAll().takeLast(deadLetterMax)
                    deadLetters.rewrite(keep)
                    deadCount = keep.size
                }
            }
        } catch (t: Exception) {
            Log.w(TAG, "dead-letter 기록 실패: ${t.javaClass.simpleName}")
        }
    }

    /**
     * lock을 잡고 부른다. 점이 상한을 넘으면 가장 오래된 종료 트립부터 통째로 메모리에서 지운다. 파일은 다음 컴팩션(dirty)에서 줄인다.
     * 등록을 지웠으면 true(호출자가 lock 밖에서 [saveRegistrations]).
     */
    private fun enforceCap(): Boolean {
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
            held.remove(victim)
            if (victim == creatingLocalId) creatingDropped = true
            dropped = true
            Log.w(TAG, "큐 상한 $maxPoints 초과: 가장 오래된 종료 트립 제거(점 ${before - points.get()}개)")
        }
        if (dropped) {
            structVersion++
            dirty = true
        }
        return dropped
    }

    private fun loadRegistrations(): Pair<MutableMap<String, Registration>, Int> {
        val map = LinkedHashMap<String, Registration>()
        val read = ids.read()
        var corrupt = read.corrupt
        for (line in read.lines) {
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
                corrupt++
            }
        }
        return map to corrupt
    }

    /** lock 밖에서 부른다. lock 안에서 JSON만 만들고, 암호화·fsync·rename은 [idsLock]으로 순서만 지킨다. */
    private fun saveRegistrations() {
        if (memoryOnly) return
        val lines: List<String>
        val version: Long
        synchronized(lock) {
            lines = registrations.map { (id, r) ->
                JSONObject()
                    .put("id", id)
                    .put("serverId", r.serverId)
                    .put("vehicleId", r.start.vehicleId)
                    .put("driverId", r.start.driverId)
                    .put("startedAt", r.start.startedAtMillis)
                    .put("odo", r.start.odometerStartKm ?: JSONObject.NULL)
                    .put("lastPointTs", r.lastPointTs ?: JSONObject.NULL)
                    .toString()
            }
            version = ++idsVersion
        }
        synchronized(idsLock) {
            if (version < idsWritten) return // 더 새 스냅샷이 이미 저장됐다
            try {
                ids.rewrite(lines)
                idsWritten = version
            } catch (t: Exception) {
                Log.w(TAG, "server-ids 저장 실패: ${t.javaClass.simpleName}")
            }
        }
    }

    private companion object {
        const val TAG = "NubiUpload"
    }
}
