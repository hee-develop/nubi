package com.nubi.car.trip

import java.io.File
import java.io.IOException
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.Executor
import javax.crypto.KeyGenerator

fun testCipher(): LineCipher = AesGcmCipher(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey())

fun newUploader(
    dir: File,
    api: TripApi,
    cipher: LineCipher,
    batchSize: Int = 100,
    maxPoints: Int = 50_000,
    compactEvery: Int = 1_000,
    deadLetterMax: Int = 5_000,
    nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
    load: Boolean = true,
) = Uploader(
    queueFile = File(dir, "queue.jsonl"),
    idsFile = File(dir, "server-ids.jsonl"),
    deadLetterFile = File(dir, "dead-letter.jsonl"),
    api = api,
    cipherSetup = { CipherSetup(cipher) },
    batchSize = batchSize,
    maxPoints = maxPoints,
    compactEvery = compactEvery,
    deadLetterMax = deadLetterMax,
    nowMs = nowMs,
).also { if (load) it.load() }

/** Keystore 대신 소프트웨어 AES 키로 DEK를 감싸는 테스트용 래퍼. */
class SoftwareKeyWrapper(private val key: javax.crypto.SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()) : KeyWrapper {
    var failUnwrap = false
    var failWrap = false
    var unwrapCalls = 0

    override fun wrap(dek: ByteArray): ByteArray {
        if (failWrap) throw IllegalStateException("wrap 실패")
        val c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply { init(javax.crypto.Cipher.ENCRYPT_MODE, key) }
        return c.iv + c.doFinal(dek)
    }

    override fun unwrap(blob: ByteArray): ByteArray {
        unwrapCalls++
        if (failUnwrap) throw IllegalStateException("unwrap 실패")
        val c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
            .apply { init(javax.crypto.Cipher.DECRYPT_MODE, key, javax.crypto.spec.GCMParameterSpec(128, blob, 0, 12)) }
        return c.doFinal(blob, 12, blob.size - 12)
    }
}

/** 암호화 한 줄마다 [perLineNanos]만큼 느려지는 가짜 cipher(실제 암호화는 위임). 컴팩션이 lock을 쥐고 있는지 확인하는 용도. */
class SlowCipher(private val inner: LineCipher) : LineCipher {
    @Volatile
    var perLineNanos = 0L

    /** 느리게 만들 스레드 조건. 기본은 모든 스레드. */
    @Volatile
    var slowWhen: () -> Boolean = { true }

    @Volatile
    var onEncrypt: (Int) -> Unit = {}
    val encryptCount = java.util.concurrent.atomic.AtomicInteger()

    override fun encrypt(plain: String): String {
        val n = encryptCount.incrementAndGet()
        onEncrypt(n)
        if (perLineNanos > 0 && slowWhen()) java.util.concurrent.locks.LockSupport.parkNanos(perLineNanos)
        return inner.encrypt(plain)
    }

    override fun decrypt(line: String): String? = inner.decrypt(line)
}

fun point(seq: Int, ts: Long = 1_000L * seq, lat: Double = 37.5 + seq * 0.0001) = TripPoint(seq, Sample(ts, lat, 127.0, gear = Gear.D))

fun points(localId: String, range: IntRange) = range.map { QueueEntry.Point(localId, point(it)) }.toTypedArray()

fun start(localId: String, startedAt: Long = 0L, vehicleId: String = "veh") = QueueEntry.Start(localId, vehicleId, vehicleId, startedAt, null)

/** 서버 흉내. 같은 localId는 같은 tripId를 돌려주고, 점은 (tripId, seq)로 중복 제거한다. 훅으로 실패를 만든다. */
class FakeServer : TripApi {
    val tripIdByLocalId = LinkedHashMap<String, String>()
    val pointsByTrip = HashMap<String, MutableMap<Int, TripPoint>>()
    val ended = HashMap<String, Long>()
    val events = ArrayList<String>()
    var createCalls = 0

    var onCreate: (QueueEntry.Start) -> Unit = {}
    var onPoints: (String, List<TripPoint>) -> Unit = { _, _ -> }
    var onEnd: (String, QueueEntry.End) -> Unit = { _, _ -> }

    @Synchronized
    override fun createTrip(e: QueueEntry.Start): String {
        createCalls++
        onCreate(e)
        val id = tripIdByLocalId.getOrPut(e.localId) { UUID.randomUUID().toString() }
        events.add("create ${e.localId} startedAt=${e.startedAtMillis} vehicle=${e.vehicleId}")
        return id
    }

    override fun postPoints(tripId: String, points: List<TripPoint>) {
        onPoints(tripId, points)
        synchronized(this) {
            if (tripId !in tripIdByLocalId.values) throw HttpFailure(404, "no trip")
            val map = pointsByTrip.getOrPut(tripId) { sortedMapOf() }
            points.forEach { map.putIfAbsent(it.seq, it) }
            events.add("points $tripId ${points.map { it.seq }}")
        }
    }

    override fun endTrip(tripId: String, e: QueueEntry.End) {
        onEnd(tripId, e)
        synchronized(this) {
            if (tripId !in tripIdByLocalId.values) throw HttpFailure(404, "no trip")
            ended.putIfAbsent(tripId, e.endedAtMillis)
            events.add("end $tripId endedAt=${e.endedAtMillis}")
        }
    }

    fun seqs(localId: String): List<Int> = pointsByTrip[tripIdByLocalId[localId]]?.keys?.toList() ?: emptyList()
}

class FakeClock(var elapsed: Long = 10_000, var wall: Long = 1_700_000_000_000) : Clock {
    override fun elapsedMs() = elapsed
    override fun wallMs() = wall
}

/** 수동 스케줄러. post는 FIFO, postDelayed는 [advance]로 시계를 옮길 때 기한 순으로 실행한다. */
class ManualScheduler(private val clock: FakeClock) : Scheduler {
    private class Timer(val due: Long, val block: () -> Unit) {
        var cancelled = false
    }

    private val posted = ArrayDeque<() -> Unit>()
    private val timers = ArrayList<Timer>()

    val pendingTimers: Int get() = timers.count { !it.cancelled }

    override fun post(block: () -> Unit) {
        posted.addLast(block)
    }

    override fun postDelayed(delayMs: Long, block: () -> Unit): Cancellable {
        val t = Timer(clock.elapsed + delayMs, block)
        timers.add(t)
        return Cancellable { t.cancelled = true }
    }

    fun runPosted() {
        while (posted.isNotEmpty()) posted.removeFirst().invoke()
    }

    /** 시계를 [ms]만큼(벽시계 포함) 옮기며 그 사이 기한이 된 타이머를 순서대로 실행한다. */
    fun advance(ms: Long) {
        val target = clock.elapsed + ms
        runPosted()
        while (true) {
            val next = timers.filter { !it.cancelled && it.due <= target }.minByOrNull { it.due } ?: break
            timers.remove(next)
            val step = maxOf(0, next.due - clock.elapsed)
            clock.elapsed += step
            clock.wall += step
            next.block()
            runPosted()
        }
        val rest = target - clock.elapsed
        clock.elapsed += rest
        clock.wall += rest
        runPosted()
    }
}

class FakeVehicle : VehicleSource {
    override var vehicleId: String? = null
    var odometer: Double? = 0.0
    var started = 0
    var stopped = 0

    override fun start() {
        started++
    }

    override fun stop() {
        stopped++
    }

    override fun readOdometerKm(callback: (Double?) -> Unit) = callback(odometer)
}

class MapStore : KeyValueStore {
    val map = HashMap<String, String>()
    override fun getString(key: String) = map[key]
    override fun putString(key: String, value: String) {
        map[key] = value
    }
}

val directExecutor = Executor { it.run() }

class FailingApi(private val error: () -> Throwable) : TripApi {
    override fun createTrip(e: QueueEntry.Start): String = throw error()
    override fun postPoints(tripId: String, points: List<TripPoint>) = throw error()
    override fun endTrip(tripId: String, e: QueueEntry.End) = throw error()
}

val networkDown = FailingApi { IOException("down") }

/** JDK 모듈(jdk.httpserver)이 없는 환경에서도 쓰는 최소 HTTP 서버. 요청마다 (경로, 본문)을 핸들러에 넘기고 (상태, 본문)을 돌려준다. */
class TinyHttpServer(private val handler: (String, String) -> Pair<Int, String>) : AutoCloseable {
    private val socket = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
    val port: Int get() = socket.localPort
    private val thread = Thread {
        while (!socket.isClosed) {
            try {
                socket.accept().use { c ->
                    val input = c.getInputStream().buffered()
                    fun line(): String {
                        val sb = StringBuilder()
                        while (true) {
                            val b = input.read()
                            if (b < 0 || b == '\n'.code) break
                            if (b != '\r'.code) sb.append(b.toChar())
                        }
                        return sb.toString()
                    }
                    val path = line().split(" ").getOrElse(1) { "/" }
                    var length = 0
                    while (true) {
                        val h = line()
                        if (h.isEmpty()) break
                        if (h.startsWith("Content-Length:", ignoreCase = true)) length = h.substringAfter(":").trim().toInt()
                    }
                    val body = String(input.readNBytes(length), Charsets.UTF_8)
                    val (status, response) = handler(path, body)
                    val bytes = response.toByteArray()
                    c.getOutputStream().apply {
                        write("HTTP/1.1 $status X\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(bytes)
                        flush()
                    }
                }
            } catch (e: IOException) {
                // 서버를 닫는 중
            }
        }
    }.apply {
        isDaemon = true
        start()
    }

    override fun close() {
        socket.close()
    }
}
