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

    private fun uploader(api: TripApi, batchSize: Int = 100, maxPoints: Int = 50_000, compactEvery: Int = 1_000): Uploader {
        if (!::dir.isInitialized) dir = tmp.newFolder("trips")
        return newUploader(dir, api, cipher, batchSize, maxPoints, compactEvery)
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
    fun Start가_4xx면_버리지_않고_보류한다() {
        val server = FakeServer()
        var reject = true
        server.onCreate = { if (reject) throw HttpFailure(400, "bad start") }
        val u = uploader(server)
        u.enqueue(start("a"), *points("a", 0..2), QueueEntry.End("a", 1, null))
        val r = u.drain()
        assertEquals(DrainKind.HELD, r.kind)
        assertEquals(5, u.pendingEntries)
        assertEquals(3, u.pendingPoints)
        assertTrue(u.readDeadLetters().isEmpty())
        reject = false
        assertEquals(DrainKind.OK, u.drain().kind)
        assertEquals(listOf(0, 1, 2), server.seqs("a"))
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
}
