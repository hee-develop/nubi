package com.nubi.car.trip

import com.nubi.car.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.Executor

class TripEngineTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val cipher = testCipher()
    private val clock = FakeClock()
    private val scheduler = ManualScheduler(clock)
    private val vehicle = FakeVehicle()
    private val store = MapStore()
    private val server = FakeServer()
    private lateinit var dir: File

    private fun uploader(api: TripApi = server): Uploader {
        if (!::dir.isInitialized) dir = tmp.newFolder("trips")
        return newUploader(dir, api, cipher)
    }

    private fun engine(uploader: Uploader = uploader(), worker: Executor = directExecutor) =
        TripEngine(clock, scheduler, worker, vehicle, store, uploader)

    /** 위도 0.000225도 ≈ 25m 간격으로 1초마다 한 점씩 넣는다. 세 번째 점에서 변위 50m가 돼 트립이 시작된다. */
    private fun TripEngine.drive(count: Int, firstIndex: Int = 0) {
        for (i in firstIndex until firstIndex + count) {
            onLocation(37.5 + i * 0.000225, 127.0, null, null)
            scheduler.advance(1_000)
        }
    }

    @Test
    fun 기록_멈춤이면_샘플을_버리고_새_트립을_시작하지_않는다() {
        vehicle.vehicleId = "hash"
        val e = engine()
        e.recordingPaused = true
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(6)
        assertEquals(TripState.IDLE, e.status.state)
        assertEquals(0, e.status.sampleCount)
        assertNull(e.status.lastLocation)
        assertEquals("기어는 계속 읽는다", Gear.D, e.status.gear)
        scheduler.advance(120_000)
        assertTrue(server.events.isEmpty())
        // 풀리면 다시 기록한다
        e.recordingPaused = false
        e.drive(4, firstIndex = 10)
        assertEquals(TripState.RECORDING, e.status.state)
    }

    @Test
    fun 데이터_삭제_뒤에는_멈춤을_켜고_저장한_뒤_진행_중_트립과_큐를_모두_버린다() {
        vehicle.vehicleId = "hash"
        val failing = FakeServer().apply { onPoints = { _, _ -> throw HttpFailure(503, "down") } } // 업로드가 안 돼 큐가 쌓인다
        val e = engine(uploader(failing))
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(8)
        assertEquals(TripState.RECORDING, e.status.state)
        assertTrue(e.status.pendingPoints > 0)
        assertNotNull(e.recordingLocalId)
        e.purgeAfterDataDeletion()
        assertTrue("멈춤은 즉시 켜진다", e.recordingPaused)
        assertEquals("저장도 한다", "1", store.getString(TripEngine.KEY_PAUSED))
        scheduler.runPosted()
        assertEquals(0, e.status.pendingPoints)
        assertEquals(TripState.IDLE, e.status.state)
        assertNull(e.recordingLocalId)
        assertEquals(0, e.status.sampleCount)
        // 이후 위치 샘플은 버려져 새 트립이 시작되지 않는다
        e.drive(6, firstIndex = 20)
        assertEquals(TripState.IDLE, e.status.state)
        assertTrue(failing.events.none { it.startsWith("end") })
    }

    @Test
    fun 기록_멈춤을_켜면_진행_중_트립을_End로_먼저_끝내고_이후_샘플은_버린다() {
        vehicle.vehicleId = "hash"
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(8)
        assertEquals(TripState.RECORDING, e.status.state)
        e.pauseRecording()
        scheduler.runPosted()
        scheduler.advance(5_000)
        assertTrue(e.recordingPaused)
        assertEquals("멈춤 켜기 순간 진행 중 트립이 End로 끝난다", 1, server.ended.size)
        assertTrue(server.events.any { it.startsWith("end ") })
        assertTrue(e.status.state != TripState.RECORDING)
        // 이후 샘플은 버려져 새 트립이 시작되지 않는다
        val creates = server.createCalls
        e.drive(6, firstIndex = 30)
        assertEquals(creates, server.createCalls)
        assertTrue(e.status.state != TripState.RECORDING)
    }

    @Test
    fun 데이터_삭제_뒤_지연_콜백이_옛_트립으로_큐를_다시_채우지_않는다() {
        vehicle.vehicleId = null // 차량 ID를 아직 몰라 Start가 재시도 대기 중
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        e.purgeAfterDataDeletion()
        scheduler.runPosted()
        scheduler.advance(30_000) // VIN 대기가 지나 UUID로 대체되는 시각
        assertEquals(0, server.createCalls)
        assertEquals(0, e.status.pendingPoints)
    }

    @Test
    fun 오도미터_응답이_삭제_뒤에_늦게_와도_큐가_비어_있다() {
        vehicle.vehicleId = "hash"
        vehicle.deferOdometer = true
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        e.purgeAfterDataDeletion()
        scheduler.runPosted()
        vehicle.releaseOdometer()
        scheduler.runPosted()
        scheduler.advance(5_000)
        assertEquals(0, server.createCalls)
    }

    @Test
    fun 기어가_바뀌면_알린다() {
        val e = engine()
        val seen = ArrayList<Gear?>()
        e.onGearChange = { seen.add(it) }
        e.onServiceStart()
        e.onGear(Gear.D)
        val viaListener = ArrayList<Gear?>()
        e.addGearListener { viaListener.add(it) }
        e.onGear(Gear.P)
        scheduler.runPosted()
        assertEquals(listOf<Gear?>(Gear.D, Gear.P), seen)
        assertEquals(listOf<Gear?>(Gear.D, Gear.P), viaListener)
    }

    @Test
    fun 놀_때는_타이머가_하나도_돌지_않는다() {
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.P)
        scheduler.advance(1_000)
        assertEquals(0, scheduler.pendingTimers)
        assertEquals(TripState.IDLE, e.status.state)
    }

    @Test
    fun 기록_중에는_tick이_돌고_끝나_업로드가_비면_다시_멈춘다() {
        vehicle.vehicleId = "hash"
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        assertEquals(TripState.RECORDING, e.status.state)
        assertTrue(scheduler.pendingTimers >= 1)
        e.onGear(Gear.P)
        scheduler.advance(5 * 60_000 + 10_000)
        assertEquals(TripState.ENDED, e.status.state)
        scheduler.advance(120_000)
        assertEquals(0, e.status.pendingPoints)
        assertEquals(0, scheduler.pendingTimers)
        assertEquals(1, server.ended.size)
    }

    @Test
    fun startPending_중에_Ended가_와도_Start는_시작_시각으로_End는_종료_시각으로_올라간다() {
        assumeTrue(BuildConfig.DEBUG) // setClock은 debug 전용
        // VIN이 아직 안 와서 Start가 큐에 못 올라간 채로 트립이 끝나는 상황. 시계를 옮겨 P 5분을 건너뛴다(실제 경과는 10초 미만).
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4) // ts: base, +1s, +2s, +3s
        val firstTs = 1_700_000_000_000L
        e.onGear(Gear.P)
        e.setClock(clock.wall + 6 * 60_000)
        scheduler.runPosted()
        assertEquals(TripState.ENDED, e.status.state)
        assertTrue("VIN 전이라 아직 아무것도 올라가면 안 된다", server.events.isEmpty())
        assertNull("VIN 전에는 UUID를 저장하지 않는다", store.getString("vehicleId"))

        vehicle.vehicleId = "hash-1"
        scheduler.advance(1_000)

        assertEquals("create ${server.tripIdByLocalId.keys.single()} startedAt=$firstTs vehicle=hash-1", server.events.first())
        val localId = server.tripIdByLocalId.keys.single()
        assertEquals(listOf(0, 1, 2, 3), server.seqs(localId))
        val tripId = server.tripIdByLocalId.getValue(localId)
        // End는 Start 시각이 아니라 마지막 채택 샘플(+3초) 시각
        assertEquals(firstTs + 3_000, server.ended[tripId])
        assertNotEquals(firstTs, server.ended[tripId])
        assertEquals(0, e.status.pendingPoints)
        assertNull(store.getString("vehicleId"))
    }

    @Test
    fun 시작했으나_End를_못_보낸_트립은_서비스_시작_때_마지막_샘플_시각으로_End를_넣는다() {
        // 이전 프로세스: 서버에 닿지 않는 채로 트립이 시작돼 Start·점이 큐에 남았고 End 없이 프로세스가 죽었다
        val before = uploader(networkDown)
        before.enqueue(start("crashed", 1_000, "hash"), QueueEntry.Point("crashed", point(0, ts = 1_500)), QueueEntry.Point("crashed", point(1, ts = 2_500)))
        // 새 프로세스
        val e = engine(uploader())
        e.onServiceStart()
        scheduler.runPosted()
        assertEquals(setOf("crashed"), server.tripIdByLocalId.keys)
        assertEquals(listOf(0, 1), server.seqs("crashed"))
        assertEquals(2_500L, server.ended[server.tripIdByLocalId.getValue("crashed")])
        assertEquals(0, e.status.pendingPoints)
    }

    @Test
    fun VIN_콜백_전에는_UUID를_저장하지_않고_업로드를_보류하며_10초_뒤에만_UUID로_대체한다() {
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        assertEquals(TripState.RECORDING, e.status.state)
        scheduler.advance(5_000) // 서비스 시작 후 약 9초
        assertNull(store.getString("vehicleId"))
        assertTrue(server.events.isEmpty())
        scheduler.advance(1_500) // 10초 경과
        val uuid = store.getString("vehicleId")
        assertNotNull(uuid)
        scheduler.advance(61_000) // 60초 업로드 타이머
        assertTrue(server.events.first().endsWith("vehicle=$uuid"))
    }

    @Test
    fun UUID로_대체한_뒤_서버_ID를_받으면_미전송_Start를_서버_ID로_바꾸고_alias를_한_번_보낸다() {
        var down = true
        server.onCreate = { if (down) throw java.io.IOException("down") }
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        scheduler.advance(7_000) // 10초 경과: UUID로 대체해 Start가 큐에 올라가지만 서버가 내려가 있다
        val uuid = store.getString("vehicleId")
        assertNotNull(uuid)
        assertTrue(server.events.isEmpty())
        vehicle.vehicleId = "server-issued" // 이제야 서버 ID를 받았다
        scheduler.advance(10_000) // tick이 전환을 확인한다
        assertEquals("server-issued", store.getString("vehicleId"))
        down = false
        scheduler.advance(6 * 60_000)
        assertEquals(listOf(QueueEntry.Alias(uuid!!, "server-issued")), server.aliases)
        assertTrue(server.events.any { it.startsWith("create ") && it.endsWith("vehicle=server-issued") })
        assertTrue(server.events.none { it.contains("vehicle=$uuid") && it.startsWith("create") })
        // 이미 전환했으므로 다음 확인에서 alias를 또 보내지 않는다
        scheduler.advance(60_000)
        assertEquals(1, server.aliases.size)
    }

    @Test
    fun 서버_ID가_처음부터_있으면_alias를_보내지_않는다() {
        vehicle.vehicleId = "server-issued"
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        scheduler.advance(120_000)
        assertTrue(server.aliases.isEmpty())
    }

    @Test
    fun VIN이_오면_UUID를_만들지_않고_해시를_차량_ID로_쓴다() {
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(3)
        scheduler.advance(1_000)
        vehicle.vehicleId = "hash-2"
        scheduler.advance(2_000)
        assertNull(store.getString("vehicleId"))
        scheduler.advance(61_000)
        assertTrue(server.events.any { it.endsWith("vehicle=hash-2") })
    }

    @Test
    fun 업로드_워커가_예외를_던져도_다음_업로드가_막히지_않는다() {
        vehicle.vehicleId = "hash"
        var calls = 0
        val flaky = Executor { job ->
            calls++
            if (calls == 1) throw java.util.concurrent.RejectedExecutionException("shutdown") else job.run()
        }
        val e = engine(worker = flaky)
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        e.onGear(Gear.P)
        scheduler.advance(5 * 60_000 + 10_000) // End 때 강제 업로드 → 1번째 execute는 거부됨
        assertEquals(TripState.ENDED, e.status.state)
        scheduler.advance(120_000) // 60초 타이머로 다시 시도되어 성공
        assertEquals(0, e.status.pendingPoints)
        assertEquals(1, server.ended.size)
    }

    @Test
    fun drain에서_예상_밖_예외가_나도_실패로_기록하고_계속_재시도한다() {
        vehicle.vehicleId = "hash"
        var broken = true
        val api = object : TripApi by server {
            override fun createTrip(e: QueueEntry.Start): String {
                if (broken) throw IllegalStateException("예상 밖")
                return server.createTrip(e)
            }
        }
        val e = engine(uploader(api))
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        e.onGear(Gear.P)
        scheduler.advance(5 * 60_000 + 10_000)
        assertEquals(UploadKind.FAILED, e.status.upload.kind)
        broken = false
        scheduler.advance(10 * 60_000)
        assertEquals(UploadKind.OK, e.status.upload.kind)
        assertEquals(1, server.ended.size)
    }

    @Test
    fun 서비스_종료는_마지막_채택_샘플_시각으로_트립을_끝내고_차량_SDK를_해제한다() {
        vehicle.vehicleId = "hash"
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        e.onServiceStop()
        scheduler.advance(1_000)
        assertEquals(1, vehicle.stopped)
        assertEquals(1_700_000_000_000L + 3_000, server.ended.values.single())
    }

    @Test
    fun debug_훅은_release에서_동작하지_않는다() {
        // BuildConfig.DEBUG가 false인 빌드에서만 의미가 있다. debug 단위 테스트에서는 동작함을 확인한다.
        val e = engine()
        e.setRealLocationAccepted(false)
        assertEquals(!BuildConfig.DEBUG, e.acceptRealLocation)
    }

    // 로드·상태 -------------------------------------------------------------

    /** 워커 작업을 쌓아 두었다가 [pump]로 돌리는 수동 실행기. */
    private class ManualWorker : Executor {
        val jobs = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) {
            jobs.addLast(command)
        }
    }

    private fun pump(worker: ManualWorker) {
        scheduler.runPosted()
        while (worker.jobs.isNotEmpty()) {
            worker.jobs.removeFirst().run()
            scheduler.runPosted()
        }
    }

    @Test
    fun 큐_로드는_워커에서_하고_끝나기_전에는_불러오는_중이다() {
        if (!::dir.isInitialized) dir = tmp.newFolder("trips")
        val seed = newUploader(dir, networkDown, cipher)
        seed.enqueue(start("old", 1_000, "hash"), QueueEntry.Point("old", point(0, ts = 1_500)))
        val worker = ManualWorker()
        val loading = newUploader(dir, server, cipher, load = false)
        val e = engine(loading, worker)
        assertTrue("생성자는 파일을 읽지 않는다", !loading.loaded)
        assertTrue(e.status.loading)
        assertEquals(1, worker.jobs.size) // 로드가 워커에 올라가 있다
        pump(worker)
        assertTrue(!e.status.loading)
        // 로드 뒤 미종료 트립 복구와 업로드가 이어진다
        assertEquals(1_500L, server.ended[server.tripIdByLocalId.getValue("old")])
    }

    @Test
    fun 서비스_시작_실패는_저장돼_다시_열어도_보이고_복구는_서비스_시작과_무관하게_돈다() {
        if (!::dir.isInitialized) dir = tmp.newFolder("trips")
        newUploader(dir, networkDown, cipher).enqueue(start("crashed", 1_000, "hash"), QueueEntry.Point("crashed", point(0, ts = 2_000)))
        val e = engine(uploader())
        e.onServiceFailed() // onServiceStart는 부르지 않는다
        scheduler.runPosted()
        assertEquals(RecorderHealth.SERVICE_FAILED, e.status.health)
        assertEquals(TripStatus.SERVICE_FAILED, e.status.health)
        assertEquals("SERVICE_FAILED", store.getString("recorderHealth"))
        assertEquals(2_000L, server.ended[server.tripIdByLocalId.getValue("crashed")])
        // 프로세스가 다시 떠도(새 엔진, 같은 저장소) 남아 있다
        val reopened = engine(uploader())
        assertEquals(RecorderHealth.SERVICE_FAILED, reopened.status.health)
        // 서비스가 다시 뜨면 지운다
        reopened.onServiceStart()
        scheduler.runPosted()
        assertEquals(RecorderHealth.OK, reopened.status.health)
        assertEquals("OK", store.getString("recorderHealth"))
    }

    @Test
    fun 위치_미지원이면_UNSUPPORTED로_둔다() {
        val e = engine()
        e.onServiceStart()
        e.onLocationUnsupported()
        scheduler.runPosted()
        assertEquals(RecorderHealth.UNSUPPORTED, e.status.health)
        assertEquals(TripStatus.UNSUPPORTED, e.status.health)
        // 서비스 실패가 더 우선한다
        e.onServiceFailed()
        scheduler.runPosted()
        assertEquals(RecorderHealth.SERVICE_FAILED, e.status.health)
    }

    @Test
    fun NaN_무한대_범위밖_좌표는_샘플_단계에서_버린다() {
        vehicle.vehicleId = "hash"
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.onLocation(Double.NaN, 127.0, null, null)
        e.onLocation(37.5, Double.POSITIVE_INFINITY, null, null)
        e.onLocation(91.0, 127.0, null, null)
        e.onLocation(37.5, 127.0, Float.NaN, Float.NEGATIVE_INFINITY) // heading·confidence는 null로 바꿔 채택
        scheduler.advance(1_000)
        e.drive(3, firstIndex = 1) // 25m 간격 정상 샘플 3개 → 변위 75m로 트립 시작
        assertEquals(TripState.RECORDING, e.status.state)
        assertEquals(4, e.status.sampleCount) // 잘못된 샘플 3개는 세지 않고, heading·confidence가 NaN인 샘플은 채택
        assertEquals(0, e.status.saveFailures)
    }

    @Test
    fun 큐_저장_실패는_상태에_나타난다() {
        vehicle.vehicleId = "hash"
        if (!::dir.isInitialized) dir = tmp.newFolder("trips")
        File(dir, "queue.jsonl").mkdir() // 파일 쓰기가 실패한다
        val e = engine(uploader())
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        assertTrue(e.status.saveFailures > 0)
        assertEquals(TripState.RECORDING, e.status.state) // 크래시 없이 기록 계속
    }

    @Test
    fun 손상_줄과_폐기_줄은_상태로_올라간다() {
        if (!::dir.isInitialized) dir = tmp.newFolder("trips")
        newUploader(dir, networkDown, cipher).enqueue(start("a"))
        File(dir, "queue.jsonl").appendText("garbage\n")
        val e = engine(uploader())
        scheduler.runPosted()
        assertEquals(1, e.status.corruptLines)
        assertEquals(0, e.status.discardedLines)
    }

    @Test
    fun 서버가_발급한_차량_ID를_Start에_쓰고_UUID를_만들지_않는다() {
        vehicle.vehicleId = "server-issued"
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        e.onGear(Gear.P)
        scheduler.advance(5 * 60_000 + 10_000)
        assertTrue(server.events.first().endsWith("vehicle=server-issued"))
        assertNull(store.getString("vehicleId"))
    }

    @Test
    fun 로드_중에_시작한_진행_중_트립에_복구_End를_넣지_않는다() {
        vehicle.vehicleId = "hash"
        if (!::dir.isInitialized) dir = tmp.newFolder("trips")
        val worker = ManualWorker()
        val e = engine(newUploader(dir, server, cipher, load = false), worker)
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4) // 로드가 끝나기 전에 트립이 시작돼 Start·점이 로드 전 버퍼에 쌓인다
        pump(worker) // 로드 → 복구(진행 중인 트립은 제외)
        e.drive(1, firstIndex = 4)
        assertEquals(TripState.RECORDING, e.status.state)
        e.onGear(Gear.P)
        scheduler.advance(5 * 60_000 + 10_000)
        pump(worker)
        scheduler.advance(120_000)
        pump(worker)
        assertEquals(1, server.ended.size)
        assertEquals(1, server.events.count { it.startsWith("end ") })
        val localId = server.tripIdByLocalId.keys.single()
        assertEquals(listOf(0, 1, 2, 3, 4), server.seqs(localId))
    }

    @Test
    fun 숫자는_기어가_P일_때만_보이고_기어를_못_읽는_차량은_기록_중이_아닐_때만_보인다() {
        for (state in TripState.values()) {
            assertEquals("D $state", false, numbersVisible(Gear.D, state))
            assertEquals("R $state", false, numbersVisible(Gear.R, state))
            assertEquals("N $state", false, numbersVisible(Gear.N, state))
            // 기어가 P면 상태기계 상태와 무관하게 보인다(기록 중이어도)
            assertEquals("P $state", true, numbersVisible(Gear.P, state))
            assertEquals("null $state", state != TripState.RECORDING, numbersVisible(null, state))
        }
    }

    @Test
    fun 상태는_기어를_그대로_담아_D_IDLE에서는_숨기고_P에서는_보인다() {
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        scheduler.runPosted()
        assertEquals(TripState.IDLE, e.status.state)
        assertEquals(Gear.D, e.status.gear)
        assertEquals("기어 D·IDLE에서는 숨김", false, numbersVisible(e.status.gear, e.status.state))
        e.onGear(Gear.P)
        scheduler.runPosted()
        assertEquals(true, numbersVisible(e.status.gear, e.status.state))
    }

    @Test
    fun 기어를_못_읽는_차량도_변위로_재개하면_새_트립_시작을_알려_이전_종료_줄을_치울_수_있다() {
        vehicle.vehicleId = "hash"
        val e = engine()
        var started = 0
        e.onTripStarted = { started++ }
        e.onServiceStart()
        e.drive(4) // 기어 null
        assertEquals(1, started)
        assertNull(e.status.gear)
        assertEquals(false, numbersVisible(e.status.gear, e.status.state)) // 기록 중
        scheduler.advance(5 * 60_000 + 10_000) // 5분 정지 → 종료
        assertEquals(TripState.ENDED, e.status.state)
        assertEquals(true, numbersVisible(e.status.gear, e.status.state))
        e.drive(4, firstIndex = 100) // 새 변위 50m → 기어 없이 새 트립
        assertEquals(TripState.RECORDING, e.status.state)
        assertEquals(2, started)
    }

    @Test
    fun 점은_이미_올라갔고_End만_보낸_업로드는_종료_전송_완료로_표시한다() {
        vehicle.vehicleId = "hash"
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(4)
        scheduler.advance(61_000) // 60초 업로드 타이머: Start와 점이 올라간다
        assertEquals(UploadKind.OK, e.status.upload.kind)
        assertEquals(4, e.status.upload.points)
        e.onGear(Gear.P)
        scheduler.advance(5 * 60_000 + 10_000)
        assertEquals(TripState.ENDED, e.status.state)
        scheduler.advance(10_000)
        assertEquals(1, server.ended.size)
        assertEquals(UploadKind.END_SENT, e.status.upload.kind)
        assertEquals(0, e.status.upload.points)
    }

    // 정차 조회 시점(onParked) ----------------------------------------------------

    private fun TripEngine.loc(lat: Double = 37.5) {
        onLocation(lat, 127.0, null, null)
        scheduler.runPosted()
    }

    @Test
    fun 위치를_안_채로_P가_되면_정차_알림이_한_번_온다() {
        val e = engine()
        var parked = 0
        e.onParked = { parked++ }
        e.onServiceStart()
        scheduler.runPosted()
        e.loc()
        e.onGear(Gear.P)
        scheduler.runPosted()
        assertEquals(1, parked)
        e.onGear(Gear.P) // 이미 P라면 다시 알리지 않는다
        scheduler.runPosted()
        assertEquals(1, parked)
        e.onGear(Gear.D)
        e.onGear(Gear.P)
        scheduler.runPosted()
        assertEquals(2, parked)
        assertEquals(37.5, e.status.lastLocation!!.lat, 0.0)
    }

    @Test
    fun P로_콜드_스타트하면_첫_위치가_들어올_때_한_번만_알린다() {
        val e = engine()
        var parked = 0
        e.onParked = { parked++ }
        e.onServiceStart()
        scheduler.runPosted()
        e.onGear(Gear.P)
        scheduler.runPosted()
        assertEquals(0, parked) // 위치를 아직 모른다
        assertNull(e.status.lastLocation)
        e.loc()
        assertEquals(1, parked)
        assertEquals(37.5, e.status.lastLocation!!.lat, 0.0) // 기어 P라 트립에는 안 들어가지만 위치는 보관
        assertEquals(0, e.status.sampleCount)
        e.loc(37.6)
        assertEquals(1, parked)
    }

    @Test
    fun 위치를_기다리던_중_P를_벗어나면_알리지_않는다() {
        val e = engine()
        var parked = 0
        e.onParked = { parked++ }
        e.onServiceStart()
        scheduler.runPosted()
        e.onGear(Gear.P)
        e.onGear(Gear.D)
        scheduler.runPosted()
        e.loc()
        assertEquals(0, parked)
    }

    @Test
    fun 서비스를_다시_시작하면_마지막_위치를_잊는다() {
        val e = engine()
        e.onServiceStart()
        scheduler.runPosted()
        e.loc()
        assertNotNull(e.status.lastLocation)
        e.onServiceStart()
        scheduler.runPosted()
        assertNull(e.status.lastLocation)
    }

    @Test
    fun 업로드_타이머는_기본_60초이고_주행_중_지도를_켜면_20초다() {
        vehicle.vehicleId = "v"
        val slow = engine()
        assertEquals(60_000L, slow.uploadIntervalMillis)
        slow.onServiceStart()
        slow.onGear(Gear.D)
        slow.drive(5)
        scheduler.advance(20_000)
        assertTrue(server.events.none { it.startsWith("points") })
        scheduler.advance(50_000)
        assertTrue(server.events.any { it.startsWith("points") })
    }

    @Test
    fun 주행_중_지도를_켜면_20초_뒤에_점이_올라가고_점_100개_기준은_그대로다() {
        vehicle.vehicleId = "v"
        val e = engine()
        e.uploadIntervalMillis = TripEngine.MAP_UPLOAD_INTERVAL_MILLIS
        assertEquals(20_000L, e.uploadIntervalMillis)
        assertEquals(100, TripEngine.UPLOAD_BATCH_POINTS)
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(5)
        scheduler.advance(10_000)
        assertTrue(server.events.none { it.startsWith("points") })
        scheduler.advance(15_000)
        assertTrue(server.events.any { it.startsWith("points") })
    }
}
