package com.nubi.car.trip

import com.nubi.car.BuildConfig
import com.nubi.car.signals.VehicleInfo
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
    fun 차량_ID는_앱_고정_pepper를_붙인_SHA256이다() {
        // echo -n "nubi-pepper" + "VIN123" | shasum -a 256 과 같은 값
        val expected = java.security.MessageDigest.getInstance("SHA-256").digest("pepperVIN123".toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals(expected, VehicleInfo.hashVin("VIN123", "pepper"))
        assertNotEquals(VehicleInfo.hashVin("VIN123", "pepper"), VehicleInfo.hashVin("VIN123", "other"))
        assertEquals(64, VehicleInfo.hashVin("VIN123").length)
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
        vehicle.vinHash = "hash"
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

        vehicle.vinHash = "hash-1"
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
    fun VIN이_오면_UUID를_만들지_않고_해시를_차량_ID로_쓴다() {
        val e = engine()
        e.onServiceStart()
        e.onGear(Gear.D)
        e.drive(3)
        scheduler.advance(1_000)
        vehicle.vinHash = "hash-2"
        scheduler.advance(2_000)
        assertNull(store.getString("vehicleId"))
        scheduler.advance(61_000)
        assertTrue(server.events.any { it.endsWith("vehicle=hash-2") })
    }

    @Test
    fun 업로드_워커가_예외를_던져도_다음_업로드가_막히지_않는다() {
        vehicle.vinHash = "hash"
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
        vehicle.vinHash = "hash"
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
        vehicle.vinHash = "hash"
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
}
