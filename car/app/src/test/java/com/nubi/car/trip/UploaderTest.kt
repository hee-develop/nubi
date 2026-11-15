package com.nubi.car.trip

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class UploaderTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val cipher = testCipher()
    private lateinit var dir: File

    private fun uploader(
        api: TripApi,
        batchSize: Int = 100,
        maxPoints: Int = 50_000,
        compactEvery: Int = 1_000,
        deadLetterMax: Int = 5_000,
        nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
        load: Boolean = true,
    ): Uploader {
        if (!::dir.isInitialized) dir = tmp.newFolder("trips")
        return newUploader(dir, api, cipher, batchSize, maxPoints, compactEvery, deadLetterMax, nowMs, load)
    }

    private fun queueLines() = File(dir, "queue.jsonl").let { if (it.exists()) it.readLines().count { l -> l.isNotBlank() } else 0 }

    @Test
    fun 정상이면_Start_점_End가_순서대로_올라가고_큐_파일이_비워진다() {
        val server = FakeServer()
        val u = uploader(server, batchSize = 2)
        u.enqueue(start("a", 5_000), *points("a", 0..4), QueueEntry.End("a", 9_000, 1.5))
        assertEquals(5, u.pendingPoints)
        val r = u.drain()
        assertEquals(DrainKind.OK, r.kind)
        assertEquals(5, r.uploadedPoints)
        assertEquals(listOf(0, 1, 2, 3, 4), server.seqs("a"))
        assertEquals(9_000L, server.ended.values.single())
        assertEquals(0, u.pendingEntries)
        assertEquals(0, u.pendingPoints)
        assertEquals(0, queueLines())
    }

    // 예외 분류 ----------------------------------------------------------

    @Test
    fun 어떤_예외든_재시도로_분류하고_항목은_남는다() {
        for (error in listOf<() -> Throwable>({ IOException("down") }, { IllegalStateException("boom") }, { org.json.JSONException("bad json") })) {
            dir = tmp.newFolder()
            val u = uploader(FailingApi(error))
            u.enqueue(start("a"), *points("a", 0..1))
            val r = u.drain() // 던지지 않는다
            assertEquals(DrainKind.RETRY, r.kind)
            assertEquals(3, u.pendingEntries)
        }
    }

    @Test
    fun 성공_상태인데_JSON이_아닌_응답은_재시도로_분류하고_크래시하지_않는다() {
        TinyHttpServer { _, _ -> 200 to "<html>captive portal</html>" }.use { http ->
            val u = uploader(HttpTripApi("http://127.0.0.1:${http.port}"))
            u.enqueue(start("a"), *points("a", 0..1))
            val r = u.drain()
            assertEquals(DrainKind.RETRY, r.kind)
            assertEquals(3, u.pendingEntries)
        }
    }

    @Test
    fun HttpTripApi는_localId를_본문에_싣는다() {
        var received = ""
        TinyHttpServer { _, body ->
            received = body
            201 to """{"tripId":"t1"}"""
        }.use { http ->
            val id = HttpTripApi("http://127.0.0.1:${http.port}").createTrip(start("local-9", 5_000))
            assertEquals("t1", id)
            assertEquals("local-9", JSONObject(received).getString("localId"))
        }
    }

    @Test
    fun 요청_시간초과_429_5xx는_재시도하고_다음_drain에서_성공한다() {
        for (status in listOf(408, 425, 429, 503)) {
            dir = tmp.newFolder()
            val server = FakeServer()
            var fail = true
            server.onPoints = { _, _ -> if (fail) throw HttpFailure(status, "HTTP $status") }
            val u = uploader(server)
            u.enqueue(start("a"), *points("a", 0..2), QueueEntry.End("a", 1, null))
            val first = u.drain()
            assertEquals("status=$status", DrainKind.RETRY, first.kind)
            assertEquals(4, u.pendingEntries) // Start는 올라갔고 점·End가 남음
            assertEquals(3, u.pendingPoints)
            fail = false
            assertEquals(DrainKind.OK, u.drain().kind)
            assertEquals(listOf(0, 1, 2), server.seqs("a"))
        }
    }

    @Test
    fun 점_배치가_400이면_반으로_나눠_보내고_1점까지_400이면_그_점만_dead_letter로_격리한다() {
        val server = FakeServer()
        server.onPoints = { _, batch -> if (batch.any { it.seq == 5 }) throw HttpFailure(400, "bad point") }
        val u = uploader(server, batchSize = 8)
        u.enqueue(start("a"), *points("a", 0..9), QueueEntry.End("a", 1, null))
        val r = u.drain()
        assertEquals(DrainKind.OK, r.kind)
        assertEquals((0..9).filter { it != 5 }, server.seqs("a"))
        assertEquals(1, server.ended.size) // 이후 항목(End)까지 막히지 않고 진행
        assertEquals(0, u.pendingEntries)
        val dead = u.readDeadLetters()
        assertEquals(1, dead.size)
        val entry = QueueCodec.decode(JSONObject(dead.single()).getString("entry")) as QueueEntry.Point
        assertEquals(5, entry.point.seq)
        assertTrue(JSONObject(dead.single()).getString("reason").contains("400"))
        // dead-letter 파일도 암호화돼 있다
        assertFalse(File(dir, "dead-letter.jsonl").readText().contains("seq"))
    }

    @Test
    fun Start가_4xx면_버리지_않고_그_트립만_보류하고_백오프_뒤_다시_시도한다() {
        var now = 0L
        val server = FakeServer()
        var reject = true
        server.onCreate = { if (reject && it.localId == "a") throw HttpFailure(400, "bad start") }
        val u = uploader(server, nowMs = { now })
        u.enqueue(start("a"), *points("a", 0..2), QueueEntry.End("a", 1, null))
        val r = u.drain()
        assertEquals(DrainKind.HELD, r.kind)
        assertEquals(5, u.pendingEntries)
        assertEquals(3, u.pendingPoints)
        assertTrue(u.readDeadLetters().isEmpty())
        val calls = server.createCalls
        assertEquals("백오프 안에서는 다시 보내지 않는다", DrainKind.HELD, u.drain().kind)
        assertEquals(calls, server.createCalls)
        reject = false
        now += 2_000
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(listOf(0, 1, 2), server.seqs("a"))
    }

    @Test
    fun 보류된_트립이_앞에_있어도_뒤의_다른_트립은_계속_올라간다() {
        var now = 0L
        val server = FakeServer()
        server.onCreate = { if (it.localId == "a") throw HttpFailure(422, "bad start") }
        val u = uploader(server, nowMs = { now })
        u.enqueue(start("a"), *points("a", 0..1), QueueEntry.End("a", 1, null))
        u.enqueue(start("b"), *points("b", 0..2), QueueEntry.End("b", 2, null))
        val r = u.drain()
        assertEquals(DrainKind.HELD, r.kind)
        assertEquals(listOf(0, 1, 2), server.seqs("b"))
        assertEquals(1, server.ended.size)
        assertEquals(4, u.pendingEntries) // a의 Start·점 2·End만 남음
        assertEquals(2, u.pendingPoints)
    }

    @Test
    fun 점_End의_그_밖의_4xx도_그_트립만_보류한다() {
        val server = FakeServer()
        server.onPoints = { id, _ -> if (id == server.tripIdByLocalId["a"]) throw HttpFailure(403, "forbidden") }
        val u = uploader(server)
        u.enqueue(start("a"), *points("a", 0..1), QueueEntry.End("a", 1, null))
        u.enqueue(start("b"), *points("b", 0..1), QueueEntry.End("b", 2, null))
        assertEquals(DrainKind.HELD, u.drain().kind)
        assertEquals(listOf(0, 1), server.seqs("b"))
        assertEquals(3, u.pendingEntries)
    }

    @Test
    fun 점이_404면_같은_localId로_트립을_다시_만들고_재전송한다() {
        val server = FakeServer()
        val u = uploader(server)
        u.enqueue(start("a", 7_000), *points("a", 0..1))
        assertEquals(DrainKind.OK, u.drain().kind)
        val oldTripId = server.tripIdByLocalId.getValue("a")
        // 서버가 트립을 잃었다
        server.tripIdByLocalId.clear()
        server.pointsByTrip.clear()
        u.enqueue(*points("a", 2..4), QueueEntry.End("a", 9_000, null))
        val r = u.drain()
        assertEquals(DrainKind.OK, r.kind)
        assertEquals(2, server.createCalls)
        val newTripId = server.tripIdByLocalId.getValue("a")
        assertTrue(newTripId != oldTripId)
        assertEquals(listOf(2, 3, 4), server.seqs("a"))
        assertEquals(9_000L, server.ended[newTripId])
        assertTrue(server.events.any { it == "create a startedAt=7000 vehicle=veh" })
        assertEquals(0, u.pendingEntries)
    }

    @Test
    fun 재생성_뒤에도_404면_무한_반복하지_않고_재시도로_넘긴다() {
        val server = FakeServer()
        val u = uploader(server)
        u.enqueue(start("a"), *points("a", 0..1))
        assertEquals(DrainKind.OK, u.drain().kind)
        server.onPoints = { _, _ -> throw HttpFailure(404, "always") }
        u.enqueue(*points("a", 2..3))
        assertEquals(DrainKind.RETRY, u.drain().kind)
        assertEquals(2, u.pendingPoints)
    }

    @Test
    fun 응답이_유실돼_Start를_다시_보내도_서버에_트립이_하나만_생긴다_멱등_localId() {
        val server = FakeServer()
        var lost = true
        // 서버는 트립을 만들었지만 응답이 유실됐다
        server.onCreate = { }
        val flaky = object : TripApi by server {
            override fun createTrip(e: QueueEntry.Start): String {
                val id = server.createTrip(e)
                if (lost) {
                    lost = false
                    throw IOException("응답 유실 $id")
                }
                return id
            }
        }
        val first = uploader(flaky)
        first.enqueue(start("a"), *points("a", 0..1))
        assertEquals(DrainKind.RETRY, first.drain().kind)
        // 프로세스가 죽었다 다시 뜬 것처럼 같은 파일로 새 Uploader를 만든다
        val second = uploader(flaky)
        assertEquals(3, second.pendingEntries)
        assertEquals(DrainKind.OK, second.drain().kind)
        assertEquals(1, server.tripIdByLocalId.size)
        assertEquals(2, server.createCalls)
        assertEquals(listOf(0, 1), server.seqs("a"))
    }

    // 동시성 -------------------------------------------------------------

    @Test
    fun 네트워크_호출_중에도_enqueue는_막히지_않는다() {
        val server = FakeServer()
        val inPost = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.onPoints = { _, _ ->
            inPost.countDown()
            release.await(5, TimeUnit.SECONDS)
        }
        val u = uploader(server)
        u.enqueue(start("a"), *points("a", 0..1))
        val pool = Executors.newSingleThreadExecutor()
        try {
            val drain = pool.submit<DrainResult> { u.drain() }
            assertTrue("postPoints에 들어가야 한다", inPost.await(5, TimeUnit.SECONDS))
            // 전송이 막혀 있는 동안(최대 5초) enqueue·카운터 조회가 바로 끝나야 한다
            val begin = System.nanoTime()
            u.enqueue(*points("a", 2..3))
            val pending = u.pendingPoints
            val tookMs = (System.nanoTime() - begin) / 1_000_000
            assertTrue("enqueue가 ${tookMs}ms 걸렸다(lock 안에서 네트워크 호출 의심)", tookMs < 500)
            assertEquals(4, pending)
            release.countDown()
            assertEquals(DrainKind.OK, drain.get(5, TimeUnit.SECONDS).kind)
            // 전송 중 들어온 점도 같은 drain 안에서 이어서 올라간다
            assertEquals(listOf(0, 1, 2, 3), server.seqs("a"))
            assertEquals(0, u.pendingPoints)
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
    }

    // 큐 상한·컴팩션 ------------------------------------------------------

    @Test
    fun 점이_상한을_넘으면_가장_오래된_종료_트립부터_통째로_제거한다() {
        val u = uploader(networkDown, maxPoints = 10)
        u.enqueue(start("old"), *points("old", 0..3), QueueEntry.End("old", 1, null))
        u.enqueue(start("mid"), *points("mid", 0..3), QueueEntry.End("mid", 1, null))
        assertEquals(8, u.pendingPoints)
        u.enqueue(start("live"), *points("live", 0..3)) // 12점 > 10 → old 제거
        assertEquals(8, u.pendingPoints)
        // old(Start+4점+End=6항목)가 통째로 빠지고 mid(6)·live(5)가 남는다
        assertEquals(11, u.pendingEntries)
    }

    @Test
    fun 종료_트립이_없으면_진행_중_트립은_지우지_않는다() {
        val u = uploader(networkDown, maxPoints = 5)
        u.enqueue(start("live"), *points("live", 0..9))
        assertEquals(10, u.pendingPoints)
    }

    @Test
    fun 재시작하면_암호화된_큐를_다시_읽고_카운터가_맞다() {
        val u = uploader(networkDown)
        u.enqueue(start("a"), *points("a", 0..2))
        val reopened = uploader(networkDown)
        assertEquals(4, reopened.pendingEntries)
        assertEquals(3, reopened.pendingPoints)
        assertFalse(File(dir, "queue.jsonl").readText().contains("37.5"))
    }

    @Test
    fun 보낸_항목은_컴팩션으로_파일에서_빠진다() {
        val server = FakeServer()
        val u = uploader(server, batchSize = 2, compactEvery = 3)
        u.enqueue(start("a"), *points("a", 0..5))
        assertEquals(7, queueLines())
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(0, queueLines())
    }

    // 복구·고아 ----------------------------------------------------------

    @Test
    fun 시작했으나_End를_못_보낸_트립은_마지막_샘플_시각으로_End를_넣는다() {
        val server = FakeServer()
        // 트립 a: 점은 큐에 남아 있고 Start도 큐에 있음. 트립 b: 이미 서버에 올라갔고 큐는 비었음. 트립 c: 이미 End가 큐에 있음
        val first = uploader(server)
        first.enqueue(start("b", 100), *points("b", 0..2))
        assertEquals(DrainKind.OK, first.drain().kind)
        first.enqueue(start("a", 50), QueueEntry.Point("a", point(0, ts = 70)), QueueEntry.Point("a", point(1, ts = 90)))
        first.enqueue(start("c", 10), QueueEntry.End("c", 33, null))
        val restarted = uploader(server)
        assertEquals(2, restarted.recoverUnfinished())
        assertEquals(0, restarted.recoverUnfinished()) // 두 번 불러도 중복으로 넣지 않는다
        assertEquals(DrainKind.OK, restarted.drain().kind)
        assertEquals(setOf("a", "b", "c"), server.tripIdByLocalId.keys)
        assertEquals(90L, server.ended[server.tripIdByLocalId.getValue("a")])
        assertEquals(2_000L, server.ended[server.tripIdByLocalId.getValue("b")]) // 마지막으로 올린 점(seq 2)의 ts
        assertEquals(33L, server.ended[server.tripIdByLocalId.getValue("c")])
    }

    @Test
    fun 트립_정보가_없는_점은_버리지_않고_dead_letter로_옮긴다() {
        val server = FakeServer()
        val u = uploader(server)
        u.enqueue(*points("ghost", 0..1))
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(2, u.readDeadLetters().size)
        assertNotNull(u.readDeadLetters().first())
    }

    // 이분할·404 재생성 ----------------------------------------------------

    @Test
    fun 이분할_뒤_성공하면_배치_크기를_원래대로_되돌린다() {
        val server = FakeServer()
        val sizes = ArrayList<Int>()
        server.onPoints = { _, b ->
            sizes.add(b.size)
            if (sizes.size <= 2) throw HttpFailure(413, "too big")
        }
        val u = uploader(server, batchSize = 8)
        u.enqueue(start("a"), *points("a", 0..7))
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(listOf(8, 4, 2, 6), sizes) // 2점으로 줄여 성공한 뒤 다시 최대 크기(남은 6점)
        assertEquals((0..7).toList(), server.seqs("a"))
    }

    @Test
    fun 재생성_createTrip이_네트워크_JSON_예상밖_예외를_던져도_크래시하지_않고_재시도로_분류한다() {
        for (error in listOf<() -> Throwable>({ IOException("down") }, { org.json.JSONException("bad") }, { IllegalStateException("boom") })) {
            dir = tmp.newFolder()
            val server = FakeServer()
            val u = uploader(server)
            u.enqueue(start("a"), *points("a", 0..1))
            assertEquals(DrainKind.OK, u.drain().kind)
            server.tripIdByLocalId.clear()
            server.pointsByTrip.clear()
            server.onCreate = { throw error() }
            u.enqueue(*points("a", 2..3))
            val r = u.drain() // 404 → 재생성에서 예외. 던지지 않는다
            assertEquals(DrainKind.RETRY, r.kind)
            assertEquals(2, u.pendingPoints)
        }
    }

    // HTTP 변환 ----------------------------------------------------------

    @Test
    fun HttpTripApi는_실제_HTTP_400을_HttpFailure_400으로_바꾼다() {
        TinyHttpServer { _, _ -> 400 to """{"error":"invalid_body"}""" }.use { http ->
            val api = HttpTripApi("http://127.0.0.1:${http.port}")
            val calls = listOf<() -> Unit>(
                { api.createTrip(start("a")) },
                { api.postPoints("t", listOf(point(0))) },
                { api.endTrip("t", QueueEntry.End("a", 1, null)) },
            )
            for (call in calls) {
                val e = org.junit.Assert.assertThrows(HttpFailure::class.java) { call() }
                assertEquals(400, e.status)
            }
        }
    }

    @Test
    fun HttpVehicleApi는_VIN을_본문으로_보내고_vehicleId를_받는다() {
        var path = ""
        var body = ""
        TinyHttpServer { p, b ->
            path = p
            body = b
            200 to """{"vehicleId":"abc123"}"""
        }.use { http ->
            assertEquals("abc123", HttpVehicleApi("http://127.0.0.1:${http.port}").register("VIN9"))
            assertEquals("/vehicles/register", path)
            assertEquals("VIN9", JSONObject(body).getString("vin"))
        }
        TinyHttpServer { _, _ -> 400 to """{"error":"invalid_body"}""" }.use { http ->
            assertEquals(400, org.junit.Assert.assertThrows(HttpFailure::class.java) { HttpVehicleApi("http://127.0.0.1:${http.port}").register("x") }.status)
        }
    }

    // End dead-letter·복구·dead-letter 상한 ---------------------------------

    @Test
    fun End가_영구_4xx로_dead_letter가_되면_등록도_지워져_복구_루프가_생기지_않는다() {
        val server = FakeServer()
        server.onEnd = { _, _ -> throw HttpFailure(400, "bad end") }
        val u = uploader(server)
        u.enqueue(start("a"), *points("a", 0..1), QueueEntry.End("a", 5, null))
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(1, u.readDeadLetters().size)
        assertTrue(u.readDeadLetters().single().contains("end"))
        assertEquals("격리한 End의 트립은 복구 대상이 아니다", 0, u.recoverUnfinished())
        val restarted = uploader(server)
        assertEquals(0, restarted.recoverUnfinished()) // 재시작 뒤에도 End를 다시 만들지 않는다
        assertEquals(0, restarted.pendingEntries)
    }

    @Test
    fun dead_letter_파일은_상한을_넘으면_오래된_줄부터_버린다() {
        val u = uploader(FakeServer(), deadLetterMax = 5)
        u.enqueue(*points("ghost", 0..7)) // 고아 점 8개가 차례로 dead-letter가 된다
        assertEquals(DrainKind.OK, u.drain().kind)
        val seqs = u.readDeadLetters().map { (QueueCodec.decode(JSONObject(it).getString("entry")) as QueueEntry.Point).point.seq }
        assertEquals(listOf(3, 4, 5, 6, 7), seqs)
    }

    @Test
    fun 복구는_진행_중인_트립을_건드리지_않고_큐에_End가_이미_있으면_건너뛴다() {
        val u = uploader(FakeServer())
        u.enqueue(start("live", 10), QueueEntry.Point("live", point(0, ts = 20)))
        u.enqueue(start("dead", 5), QueueEntry.Point("dead", point(0, ts = 8)))
        assertEquals(1, u.recoverUnfinished(setOf("live")))
        assertEquals(0, u.recoverUnfinished(setOf("live"))) // 두 번째는 End가 이미 있다
        // 진행 중이던 트립이 원래 End를 넣는다
        u.enqueue(QueueEntry.End("live", 30, 7.0))
        // 이미 End가 있는 트립에 End를 또 넣어도 하나만 남는다
        u.enqueue(QueueEntry.End("dead", 99, 9.0))
        val server = FakeServer()
        val sender = uploader(server)
        assertEquals(DrainKind.OK, sender.drain().kind)
        assertEquals(2, server.events.count { it.startsWith("end ") })
    }

    // 저장 실패·손상·로드 ---------------------------------------------------

    @Test
    fun 인코딩_예외_NaN은_그_항목만_버리고_저장_실패로_센다_크래시하지_않는다() {
        val u = uploader(FakeServer())
        val ok = u.enqueue(
            QueueEntry.Point("a", TripPoint(0, Sample(1_000, Double.NaN, 127.0))),
            QueueEntry.Point("a", TripPoint(1, Sample(2_000, 37.5, Double.POSITIVE_INFINITY))),
        )
        assertFalse(ok)
        assertEquals(0, u.pendingEntries)
        assertEquals(2, u.saveFailures)
        assertTrue(u.enqueue(start("a")))
        assertEquals(1, u.pendingEntries)
    }

    @Test
    fun 파일_append가_IOException이면_저장_실패로_세지만_메모리_항목은_업로드된다() {
        dir = tmp.newFolder("trips")
        File(dir, "queue.jsonl").mkdir() // 파일 자리에 디렉터리가 있어 읽기·쓰기 모두 실패한다
        val server = FakeServer()
        val u = uploader(server)
        val before = u.saveFailures
        assertFalse(u.enqueue(start("a"), *points("a", 0..1)))
        assertTrue(u.saveFailures > before)
        assertEquals(3, u.pendingEntries)
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(listOf(0, 1), server.seqs("a"))
    }

    @Test
    fun 복호화에_실패한_줄은_세어_보고하고_컴팩션에서_파일에서도_사라진다() {
        val first = uploader(networkDown)
        first.enqueue(start("a"), *points("a", 0..1))
        File(dir, "queue.jsonl").appendText("garbage-line\nanother-bad-line\n")
        val server = FakeServer()
        val second = uploader(server)
        assertEquals(2, second.corruptLines)
        assertEquals(3, second.pendingEntries)
        assertEquals(DrainKind.OK, second.drain().kind)
        assertEquals(listOf(0, 1), server.seqs("a"))
        assertEquals(0, queueLines())
        assertEquals(0, uploader(networkDown).corruptLines)
    }

    @Test
    fun 로드_전에_들어온_항목은_메모리에_쌓였다가_로드_때_파일_뒤에_이어진다() {
        val first = uploader(networkDown)
        first.enqueue(start("a"), *points("a", 0..1))
        val second = uploader(networkDown, load = false)
        assertTrue(second.enqueue(*points("a", 2..3)))
        assertFalse(second.loaded)
        assertEquals(2, second.pendingEntries)
        second.load()
        assertTrue(second.loaded)
        assertEquals(5, second.pendingEntries)
        assertEquals(4, second.pendingPoints)
        val onDisk = TripQueue(File(dir, "queue.jsonl"), cipher).load().entries.filterIsInstance<QueueEntry.Point>().map { it.point.seq }
        assertEquals(listOf(0, 1, 2, 3), onDisk)
    }

    // 컴팩션 -------------------------------------------------------------

    @Test
    fun 큐_5000줄_컴팩션_중에도_enqueue는_50ms_안에_끝나고_그_사이_들어온_항목도_파일에_남는다() {
        dir = tmp.newFolder("trips")
        val slow = SlowCipher(cipher)
        val u = newUploader(dir, networkDown, slow)
        u.enqueue(start("a"), *points("a", 0..4_998))
        assertEquals(5_000, u.pendingEntries)
        val base = slow.encryptCount.get()
        val midCompaction = CountDownLatch(1)
        slow.perLineNanos = 200_000 // 줄당 0.2ms → 컴팩션 전체 약 1초
        slow.slowWhen = { Thread.currentThread().name == "compactor" } // 컴팩션 스레드의 암호화만 느리게
        slow.onEncrypt = { n -> if (n - base > 300) midCompaction.countDown() }
        val pool = Executors.newSingleThreadExecutor { Thread(it, "compactor") }
        try {
            val compaction = pool.submit<Boolean> { u.compact() }
            assertTrue("컴팩션이 진행 중이어야 한다", midCompaction.await(10, TimeUnit.SECONDS))
            assertFalse(compaction.isDone)
            val begin = System.nanoTime()
            val ok = u.enqueue(*points("a", 5_000..5_002))
            val tookMs = (System.nanoTime() - begin) / 1_000_000.0
            println("컴팩션 중 enqueue 소요: ${tookMs}ms (큐 5000줄, 줄당 암호화 0.2ms 가짜 cipher)")
            assertTrue(ok)
            assertTrue("컴팩션 중 enqueue가 ${tookMs}ms 걸렸다(lock 안 암호화·쓰기 의심)", tookMs < 50)
            assertFalse("enqueue가 끝났을 때도 컴팩션은 진행 중이어야 한다", compaction.isDone)
            assertTrue(compaction.get(30, TimeUnit.SECONDS))
        } finally {
            pool.shutdownNow()
        }
        val reopened = newUploader(dir, networkDown, cipher)
        assertEquals(5_003, reopened.pendingEntries)
        assertEquals(5_002, reopened.pendingPoints)
    }

    @Test
    fun 컴팩션_중_IO_실패는_큐를_그대로_두고_다음에_다시_시도한다() {
        val server = FakeServer()
        val u = uploader(server)
        u.enqueue(start("a"), *points("a", 0..3), QueueEntry.End("a", 1, null))
        val tmpDir = File(dir, "queue.compact.tmp").apply { mkdir() } // 컴팩션 임시 파일 자리에 디렉터리 → 컴팩션 쓰기가 실패한다
        assertEquals(DrainKind.OK, u.drain().kind) // drain은 컴팩션 실패에 영향받지 않는다
        assertEquals(listOf(0, 1, 2, 3), server.seqs("a"))
        assertEquals("컴팩션이 실패했으므로 파일은 그대로", 6, queueLines())
        tmpDir.delete()
        assertTrue(u.compact())
        assertEquals(0, queueLines())
        assertEquals(0, uploader(networkDown).pendingEntries)
    }

    @Test
    fun 컴팩션_중_상한_정리가_일어나면_옛_스냅샷으로_교체하지_않는다() {
        dir = tmp.newFolder("trips")
        val slow = SlowCipher(cipher)
        val u = newUploader(dir, networkDown, slow, maxPoints = 20)
        u.enqueue(start("old"), *points("old", 0..9), QueueEntry.End("old", 1, null))
        slow.perLineNanos = 20_000_000 // 줄당 20ms(컴팩션 스레드만)
        slow.slowWhen = { Thread.currentThread().name == "compactor" }
        val inside = CountDownLatch(1)
        val base = slow.encryptCount.get()
        slow.onEncrypt = { n -> if (n - base > 2) inside.countDown() }
        val pool = Executors.newSingleThreadExecutor { Thread(it, "compactor") }
        try {
            val compaction = pool.submit<Boolean> { u.compact() }
            assertTrue(inside.await(5, TimeUnit.SECONDS))
            u.enqueue(start("live"), *points("live", 0..14)) // 25점 > 20 → old 정리
            assertFalse("정리로 목록이 바뀌었으니 컴팩션은 교체를 포기한다", compaction.get(30, TimeUnit.SECONDS))
        } finally {
            pool.shutdownNow()
        }
        assertEquals(15, u.pendingPoints)
        assertTrue(u.compact()) // 다음 컴팩션은 정리된 상태를 반영한다
        val reopened = uploader(networkDown)
        assertEquals(16, reopened.pendingEntries)
        assertEquals(15, reopened.pendingPoints)
    }

    @Test
    fun drain_중에_상한_정리가_진행_중_트립을_지워도_카운터가_맞고_끝까지_올라간다() {
        val server = FakeServer()
        val inPost = CountDownLatch(1)
        val release = CountDownLatch(1)
        var first = true
        server.onPoints = { _, _ ->
            if (first) {
                first = false
                inPost.countDown()
                release.await(5, TimeUnit.SECONDS)
            }
        }
        val u = uploader(server, maxPoints = 10)
        u.enqueue(start("old"), *points("old", 0..3), QueueEntry.End("old", 1, null))
        u.enqueue(start("mid"), *points("mid", 0..3), QueueEntry.End("mid", 2, null))
        val pool = Executors.newSingleThreadExecutor()
        try {
            val drain = pool.submit<DrainResult> { u.drain() }
            assertTrue(inPost.await(5, TimeUnit.SECONDS))
            u.enqueue(start("live"), *points("live", 0..3)) // 12점 > 10 → 전송 중인 old를 통째로 정리
            release.countDown()
            assertEquals(DrainKind.OK, drain.get(10, TimeUnit.SECONDS).kind)
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
        assertEquals(0, u.pendingPoints)
        assertEquals(0, u.pendingEntries)
        assertEquals(listOf(0, 1, 2, 3), server.seqs("mid"))
        assertEquals(listOf(0, 1, 2, 3), server.seqs("live"))
        assertEquals(0, uploader(networkDown).pendingEntries) // 파일도 일치
    }

    // 암호화 키 손상 -------------------------------------------------------

    private fun dekUploader(wrapper: SoftwareKeyWrapper) = Uploader(
        queueFile = File(dir, "queue.jsonl"),
        idsFile = File(dir, "server-ids.jsonl"),
        deadLetterFile = File(dir, "dead-letter.jsonl"),
        api = networkDown,
        cipherSetup = { DekCipherFactory(dir, wrapper).setup() },
    ).also { it.load() }

    @Test
    fun DEK가_손상되면_새_DEK로_재생성하고_기존_큐는_폐기_개수를_남기며_크래시하지_않는다() {
        dir = tmp.newFolder("trips")
        val wrapper = SoftwareKeyWrapper()
        val first = dekUploader(wrapper)
        first.enqueue(start("a"), *points("a", 0..2))
        assertEquals(0, first.discardedLines)
        val second = dekUploader(wrapper)
        assertEquals(4, second.pendingEntries) // 같은 DEK면 그대로 읽힌다
        File(dir, "dek.bin").writeText("깨진 DEK")
        val third = dekUploader(wrapper)
        assertEquals(0, third.pendingEntries)
        assertEquals(4, third.discardedLines)
        assertTrue(third.enqueue(start("b")))
        val fourth = dekUploader(wrapper)
        assertEquals(1, fourth.pendingEntries) // 새 DEK가 저장돼 다음 시작에는 읽힌다
        assertEquals(0, fourth.discardedLines)
    }

    @Test
    fun Keystore_영구_손실과_wrap_실패에서도_크래시하지_않는다() {
        dir = tmp.newFolder("trips")
        val wrapper = SoftwareKeyWrapper()
        dekUploader(wrapper).enqueue(start("a"))
        wrapper.failUnwrapLost = KeyPermanentlyLostException("키 없음") // Keystore 키가 사라진 경우
        val lost = dekUploader(wrapper)
        assertEquals(0, lost.pendingEntries)
        assertEquals(1, lost.discardedLines)
        assertFalse(lost.memoryOnly)
        assertTrue(lost.enqueue(start("b")))
        // wrap까지 실패하면 이번 실행에만 쓰는 임시 키로 메모리에서만 돈다(디스크에 쓰지 않는다)
        File(dir, "dek.bin").delete()
        wrapper.failUnwrapLost = null
        wrapper.failWrap = true
        val queueBefore = File(dir, "queue.jsonl").readText()
        val ephemeral = dekUploader(wrapper)
        assertTrue(ephemeral.memoryOnly)
        assertTrue(ephemeral.enqueue(start("c"), *points("c", 0..1)))
        assertEquals(3, ephemeral.pendingEntries)
        assertFalse(File(dir, "queue.jsonl").exists() && File(dir, "queue.jsonl").readText() != "")
        assertTrue(queueBefore.isNotEmpty())
    }

    @Test
    fun 일시_키_오류면_기존_파일을_건드리지_않고_메모리_큐로_업로드하며_다음_실행에_다시_읽는다() {
        dir = tmp.newFolder("trips")
        val wrapper = SoftwareKeyWrapper()
        dekUploader(wrapper).enqueue(start("old"), *points("old", 0..2), QueueEntry.End("old", 5, null))
        val queueBefore = File(dir, "queue.jsonl").readText()
        val dekBefore = File(dir, "dek.bin").readText()
        wrapper.failUnwrap = true
        val server = FakeServer()
        val u = Uploader(
            File(dir, "queue.jsonl"), File(dir, "server-ids.jsonl"), File(dir, "dead-letter.jsonl"), server,
            { DekCipherFactory(dir, wrapper, sleep = {}).setup() },
        )
        u.load()
        assertTrue(u.memoryOnly)
        assertEquals(0, u.corruptLines) // 읽지 않았으므로 '손상'으로 세지 않는다
        assertEquals(0, u.discardedLines)
        assertTrue(u.enqueue(start("new"), *points("new", 0..1), QueueEntry.End("new", 9, null)))
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(listOf(0, 1), server.seqs("new")) // 메모리 큐는 업로드된다
        assertTrue(u.compact().not()) // 디스크 컴팩션은 하지 않는다
        assertEquals(queueBefore, File(dir, "queue.jsonl").readText())
        assertEquals(dekBefore, File(dir, "dek.bin").readText())
        assertFalse(File(dir, "dek.bin.stale").exists())
        // 키가 돌아온 다음 실행: 옛 큐가 그대로 읽힌다
        wrapper.failUnwrap = false
        val next = dekUploader(wrapper)
        assertFalse(next.memoryOnly)
        assertEquals(5, next.pendingEntries)
    }

    @Test
    fun alias는_큐의_미전송_Start_차량_ID를_바꾸고_서버에_한_번_보낸다() {
        val server = FakeServer()
        val u = uploader(server, load = false)
        u.load()
        u.enqueue(start("t1", vehicleId = "uuid-1"), *points("t1", 0..1))
        u.enqueue(start("t2", vehicleId = "other"))
        u.enqueue(QueueEntry.Alias("uuid-1", "server-1"))
        // 파일도 바뀐다(다음 컴팩션 뒤). 다시 로드해도 Alias가 남아 있으면 같은 결과다.
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(listOf("alias uuid-1->server-1"), server.events.filter { it.startsWith("alias") })
        assertEquals(1, server.events.count { it == "create t1 startedAt=0 vehicle=server-1" })
        assertEquals(1, server.events.count { it == "create t2 startedAt=0 vehicle=other" })
        assertEquals(0, u.pendingEntries)
        assertEquals(0, uploader(networkDown).pendingEntries)
    }

    @Test
    fun 재시작해도_저장된_Alias가_미전송_Start에_다시_적용된다() {
        val server = FakeServer()
        val u = uploader(networkDown)
        u.enqueue(start("t1", vehicleId = "uuid-1"), QueueEntry.Alias("uuid-1", "server-1"))
        // 컴팩션 전에 죽었다고 보고 파일을 원래 순서(Start가 옛 ID)로 되돌린다
        val restart = File(dir, "queue.jsonl")
        restart.writeText(
            listOf(start("t1", vehicleId = "uuid-1"), QueueEntry.Alias("uuid-1", "server-1"))
                .joinToString("") { cipher.encrypt(QueueCodec.encode(it)) + "\n" },
        )
        val again = uploader(server)
        assertEquals(DrainKind.OK, again.drain().kind)
        assertTrue(server.events.contains("create t1 startedAt=0 vehicle=server-1"))
        assertEquals(1, server.aliases.size)
    }

    @Test
    fun alias_영구_4xx는_dead_letter로_격리하고_큐를_막지_않는다() {
        val server = FakeServer().apply { onAlias = { throw HttpFailure(409, "conflict") } }
        val u = uploader(server)
        u.enqueue(QueueEntry.Alias("a", "b"), start("t"))
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(1, u.readDeadLetters().size)
        assertTrue(server.events.any { it.startsWith("create t") })
        // 일시 오류는 항목을 남긴다
        val s2 = FakeServer().apply { onAlias = { throw HttpFailure(503, "down") } }
        val u2 = uploader(s2)
        u2.enqueue(QueueEntry.Alias("c", "d"))
        assertEquals(DrainKind.RETRY, u2.drain().kind)
        assertEquals(1, u2.pendingEntries)
    }

    @Test
    fun Create_성공_직후_상한_정리로_항목이_사라져도_등록을_남겨_복구가_End를_보낼_수_있다() {
        val server = FakeServer()
        val u = uploader(server, maxPoints = 5)
        server.onCreate = { e ->
            // 서버 응답을 기다리는 사이(lock 밖) 다른 트립이 점을 쌓아 상한을 넘기고, 가장 오래된 종료 트립(= a)이 통째로 지워진다
            if (e.localId == "a") u.enqueue(start("b"), *points("b", 0..5))
        }
        u.enqueue(start("a"), QueueEntry.End("a", 3, null))
        server.onPoints = { _, _ -> throw HttpFailure(503, "stop") } // 이후는 멈춰서 상태만 본다
        assertEquals(DrainKind.RETRY, u.drain().kind)
        assertEquals(1, server.createCalls.coerceAtMost(1))
        // 다음 시작: 큐에는 a가 없지만 등록이 남아 있어 End가 만들어진다
        val restarted = uploader(server)
        val recovered = restarted.recoverUnfinished()
        assertTrue("등록이 남아 a의 End를 복구해야 한다", recovered >= 1)
        server.onPoints = { _, _ -> }
        assertEquals(DrainKind.OK, restarted.drain().kind)
        assertTrue(server.ended.containsKey(server.tripIdByLocalId["a"]))
    }

    @Test
    fun 컴팩션은_queue_compact_tmp를_쓰고_clear의_임시_파일과_겹치지_않는다() {
        val u = uploader(networkDown)
        u.enqueue(start("a"))
        assertEquals("queue.compact.tmp", FileIo.compactTmpOf(File(dir, "queue.jsonl")).name)
        assertEquals("queue.jsonl.tmp", FileIo.tmpOf(File(dir, "queue.jsonl")).name)
        assertTrue(u.compact())
        assertFalse(File(dir, "queue.compact.tmp").exists())
    }
}
