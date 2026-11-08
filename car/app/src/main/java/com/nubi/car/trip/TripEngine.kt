package com.nubi.car.trip

import android.util.Log
import com.nubi.car.BuildConfig
import java.util.UUID
import java.util.concurrent.Executor

interface Clock {
    /** SystemClock.elapsedRealtime(). 경과 시간 판정에만 쓴다. */
    fun elapsedMs(): Long

    /** 벽시계(epoch ms). 샘플 `ts`에만 쓴다. */
    fun wallMs(): Long
}

fun interface Cancellable {
    fun cancel()
}

/** 모든 엔진 로직이 도는 단일 스레드(Android에서는 메인 루퍼). */
interface Scheduler {
    fun post(block: () -> Unit)
    fun postDelayed(delayMs: Long, block: () -> Unit): Cancellable
}

interface VehicleSource {
    /** `SHA-256(pepper + VIN)`. VIN 콜백이 오기 전이거나 실패하면 null. */
    val vinHash: String?
    fun start()
    fun stop()
    fun readOdometerKm(callback: (Double?) -> Unit)
}

interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
}

/**
 * 상태기계·큐·업로드를 묶는 엔진. Android에 의존하지 않아 JVM에서 테스트한다([TripEngineProvider]가 실제 의존성을 꽂는다).
 * 모든 입구 메서드는 [Scheduler]로 넘겨 순서대로 처리하고, 네트워크는 [worker]에서만 한다.
 */
class TripEngine(
    private val clock: Clock,
    private val scheduler: Scheduler,
    private val worker: Executor,
    private val vehicle: VehicleSource,
    private val store: KeyValueStore,
    private val uploader: Uploader,
) {
    private val machine = TripStateMachine()

    /** debug에서 `now=`로 옮긴 시계 차이. 상태기계에 넘기는 elapsed·벽시계에만 더한다(재시도 간격은 실제 시계로 잰다). */
    private var clockOffsetMillis = 0L
    private var active: TripCtx? = null
    private var failures = 0
    private var nextAttemptElapsed = 0L
    private var draining = false
    private var redrain = false
    private var lastUpload = UploadStatus()
    private var serviceStartedElapsed = clock.elapsedMs()
    private var tickJob: Cancellable? = null
    private var uploadJob: Cancellable? = null

    /** debug 위치 주입을 쓰는 동안 false로 두어 실제 위치 콜백을 무시한다(주입 경로와 섞이지 않게). */
    @Volatile
    var acceptRealLocation: Boolean = true
        private set

    @Volatile
    var status: TripStatus = TripStatus()
        private set

    /** 한 트립이 서버 큐에 올라가기까지의 임시 상태. Start는 오도미터·차량 ID가 준비돼야 큐에 들어간다. */
    private class TripCtx(val localId: String, val startedAtMillis: Long) {
        val held = ArrayList<TripPoint>()
        var startPending = true
        var odoReady = false
        var odoStart: Double? = null
        var ended = false
        var endedAtMillis = 0L
        var odoEnd: Double? = null
    }

    init {
        publish()
    }

    private fun elapsed() = clock.elapsedMs() + clockOffsetMillis
    private fun wall() = clock.wallMs() + clockOffsetMillis

    // 서비스 수명 ---------------------------------------------------------

    /** 서비스가 시작될 때. 차량 정보를 열고, 이전 프로세스가 끝내지 못한 트립에 End를 넣는다. */
    fun onServiceStart() {
        scheduler.post {
            serviceStartedElapsed = clock.elapsedMs()
            machine.reset()
            vehicle.start()
            uploader.recoverUnfinished()
            requestUpload(force = false)
            publish()
        }
    }

    /** 서비스 onDestroy·onTaskRemoved. 기록 중이면 마지막 채택 샘플 시각으로 트립을 끝내고 차량 SDK를 해제한다. */
    fun onServiceStop() {
        scheduler.post {
            handle(machine.onStop(), immediate = true)
            vehicle.stop()
            publish()
        }
    }

    // 입구 ---------------------------------------------------------------

    fun onLocation(lat: Double, lon: Double, headingDeg: Float?, confidence: Float?, tsMillis: Long? = null) {
        scheduler.post {
            val ts = tsMillis?.takeIf { kotlin.math.abs(it - wall()) < 24 * 3_600_000L } ?: wall()
            handle(machine.onLocation(Sample(ts, lat, lon, headingDeg, confidence), elapsed()))
            publish()
        }
    }

    fun onGear(gear: Gear?) {
        scheduler.post {
            handle(machine.onGear(gear, elapsed()))
            publish()
        }
    }

    // debug 전용 훅(main에 있어도 release에서는 동작하지 않는다) ---------------------

    /** 시계를 [epochMillis]로 맞추고(이후 시계가 그 시각에서 흐른다) 바로 종료 조건을 확인한다. */
    fun setClock(epochMillis: Long) {
        if (!BuildConfig.DEBUG) return
        scheduler.post {
            clockOffsetMillis = epochMillis - clock.wallMs()
            onTick()
        }
    }

    /** 실제 위치 콜백 수신 여부. 호출 즉시 반영한다(reset·gpx 시작과 순서가 엇갈리지 않게 큐를 거치지 않는다). */
    fun setRealLocationAccepted(accepted: Boolean) {
        if (!BuildConfig.DEBUG) return
        acceptRealLocation = accepted
    }

    fun flush() {
        if (!BuildConfig.DEBUG) return
        scheduler.post { requestUpload(force = true) }
    }

    /**
     * 상태기계·큐·시계를 모두 비우고 실제 위치 수신을 끈다(이후 gpx·loc 주입만 받는다. 다시 켜려면 [setRealLocationAccepted]).
     * 끄는 일은 즉시 하고, 비우는 일은 큐에 넣는다. 그래서 reset 뒤에 시작한 gpx 샘플은 비운 뒤에 처리된다.
     */
    fun reset() {
        if (!BuildConfig.DEBUG) return
        acceptRealLocation = false
        scheduler.post {
            machine.reset()
            active = null
            clockOffsetMillis = 0
            failures = 0
            nextAttemptElapsed = 0
            lastUpload = UploadStatus()
            uploader.clear()
            publish()
        }
    }

    // 내부 ---------------------------------------------------------------

    private fun onTick() {
        handle(machine.onTick(elapsed()))
        publish()
    }

    private fun handle(events: List<TripEvent>, immediate: Boolean = false) {
        for (e in events) {
            Log.i(TAG, "이벤트 ${e.javaClass.simpleName} " + when (e) {
                is TripEvent.Started -> "points=${e.points.size}"
                is TripEvent.PointsAccepted -> "seq=${e.points.first().seq} ${coordForLog(e.points.first().sample.lat, e.points.first().sample.lon)}"
                is TripEvent.Ended -> "endedAt=${e.endedAtMillis}"
            })
            when (e) {
                is TripEvent.Started -> {
                    val ctx = TripCtx(UUID.randomUUID().toString(), e.startedAtMillis)
                    ctx.held.addAll(e.points)
                    active = ctx
                    withOdometer { km ->
                        ctx.odoStart = km
                        ctx.odoReady = true
                        tryBegin(ctx, force = false)
                    }
                }
                is TripEvent.PointsAccepted -> {
                    val ctx = active ?: continue
                    if (ctx.startPending) ctx.held.addAll(e.points) else enqueuePoints(ctx, e.points)
                }
                is TripEvent.Ended -> {
                    val ctx = active ?: continue
                    active = null
                    if (immediate) {
                        // 서비스가 곧 사라진다. 오도미터를 기다리지 않고 바로 큐에 남긴다.
                        finishTrip(ctx, e.endedAtMillis, null, force = true)
                    } else {
                        withOdometer { km -> finishTrip(ctx, e.endedAtMillis, km, force = false) }
                    }
                }
            }
        }
    }

    /**
     * Start와 보류 중이던 점을 큐에 올린다. 오도미터를 읽었고 차량 ID가 정해졌을 때만 한다. 아니면 1초 뒤 다시 본다.
     * 트립이 이미 끝났으면(Ended가 먼저 온 경우) 보관해 둔 종료 시각으로 End까지 이어서 올린다.
     */
    private fun tryBegin(ctx: TripCtx, force: Boolean) {
        if (!ctx.startPending) return
        if (!ctx.odoReady && !force) return
        val vehicleId = resolveVehicleId(force)
        if (vehicleId == null) {
            scheduler.postDelayed(RETRY_MILLIS) { tryBegin(ctx, force = false); publish() }
            return
        }
        ctx.startPending = false
        uploader.enqueue(QueueEntry.Start(ctx.localId, vehicleId, vehicleId, ctx.startedAtMillis, ctx.odoStart))
        enqueuePoints(ctx, ctx.held.toList())
        ctx.held.clear()
        if (ctx.ended) {
            uploader.enqueue(QueueEntry.End(ctx.localId, ctx.endedAtMillis, ctx.odoEnd))
            requestUpload(force = true)
        }
    }

    private fun finishTrip(ctx: TripCtx, endedAtMillis: Long, odoEnd: Double?, force: Boolean) {
        ctx.ended = true
        ctx.endedAtMillis = endedAtMillis
        ctx.odoEnd = odoEnd
        if (ctx.startPending) {
            // Start가 아직 큐에 못 올라갔다. 올라가는 순간 이 종료 시각으로 End를 잇는다(Start 시각과 섞지 않는다).
            tryBegin(ctx, force)
        } else {
            uploader.enqueue(QueueEntry.End(ctx.localId, endedAtMillis, odoEnd))
            requestUpload(force = true)
        }
        publish()
    }

    private fun enqueuePoints(ctx: TripCtx, points: List<TripPoint>) {
        if (points.isEmpty()) return
        uploader.enqueue(*points.map { QueueEntry.Point(ctx.localId, it) }.toTypedArray())
        if (uploader.pendingPoints >= UPLOAD_BATCH_POINTS) requestUpload(force = false)
    }

    /** 오도미터를 읽어 [block]을 엔진 스레드에서 부른다. 2초 안에 못 읽으면 null로 진행한다. */
    private fun withOdometer(block: (Double?) -> Unit) {
        var done = false
        val finish: (Double?) -> Unit = { km ->
            scheduler.post {
                if (!done) {
                    done = true
                    block(km)
                    publish()
                }
            }
        }
        vehicle.readOdometerKm(finish)
        scheduler.postDelayed(ODOMETER_TIMEOUT_MILLIS) { finish(null) }
    }

    /**
     * 차량 ID는 VIN 해시다. VIN 콜백이 오기 전에는 UUID를 만들거나 저장하지 않고 null(업로드 보류)을 돌려준다.
     * 서비스 시작 후 [VIN_WAIT_MILLIS]가 지나도 VIN이 없을 때만(또는 [force]) UUID로 대체해 저장한다.
     */
    private fun resolveVehicleId(force: Boolean): String? {
        vehicle.vinHash?.let { return it }
        val waited = clock.elapsedMs() - serviceStartedElapsed >= VIN_WAIT_MILLIS
        if (!waited && !force) return null
        return store.getString(KEY_VEHICLE_ID) ?: UUID.randomUUID().toString().also { store.putString(KEY_VEHICLE_ID, it) }
    }

    private fun requestUpload(force: Boolean) {
        if (draining) {
            // 업로드 중에 들어온 강제 요청은 끝나는 대로 한 번 더 돈다.
            if (force) redrain = true
            return
        }
        if (uploader.pendingEntries == 0) return
        if (!force && clock.elapsedMs() < nextAttemptElapsed) return
        draining = true
        try {
            worker.execute {
                val result = try {
                    uploader.drain()
                } catch (t: Throwable) {
                    // 어떤 예외든 draining이 풀리도록 결과로 바꿔 넘긴다.
                    Log.w(TAG, "drain 예외: ${t.javaClass.simpleName}")
                    DrainResult(DrainKind.RETRY, 0, "RETRY ${t.javaClass.simpleName}")
                }
                scheduler.post { finishDrain(result) }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "업로드 작업 등록 실패: ${t.javaClass.simpleName}")
            draining = false
        }
    }

    private fun finishDrain(result: DrainResult) {
        try {
            val again = redrain && result.ok
            redrain = false
            failures = if (result.ok) 0 else failures + 1
            nextAttemptElapsed = clock.elapsedMs() + backoffMillis(failures)
            lastUpload = when (result.kind) {
                DrainKind.OK -> UploadStatus(UploadKind.OK, result.uploadedPoints)
                DrainKind.RETRY -> UploadStatus(UploadKind.FAILED)
                DrainKind.HELD -> UploadStatus(UploadKind.HELD)
            }
            Log.i(TAG, "업로드 ${result.message}, 대기 ${uploader.pendingEntries}")
            publish()
            if (again) requestUpload(force = true)
        } finally {
            draining = false
        }
    }

    private fun publish() {
        status = TripStatus(
            state = machine.state,
            sampleCount = machine.sampleCount,
            distanceM = machine.distanceM.toInt(),
            upload = lastUpload,
            pendingPoints = uploader.pendingPoints,
        )
        updateTimers()
    }

    /** 5초 tick은 기록 중일 때만, 60초 업로드 타이머는 큐에 미전송분이 있을 때만 돈다(놀 때는 아무것도 깨우지 않는다). */
    private fun updateTimers() {
        if (machine.state == TripState.RECORDING) {
            if (tickJob == null) tickJob = scheduler.postDelayed(TICK_MILLIS) { tickJob = null; onTick() }
        } else {
            tickJob?.cancel()
            tickJob = null
        }
        if (uploader.pendingEntries > 0) {
            if (uploadJob == null) {
                uploadJob = scheduler.postDelayed(UPLOAD_INTERVAL_MILLIS) {
                    uploadJob = null
                    requestUpload(force = false)
                    publish()
                }
            }
        } else {
            uploadJob?.cancel()
            uploadJob = null
        }
    }

    companion object {
        private const val TAG = "NubiTrip"
        const val TICK_MILLIS = 5_000L
        const val UPLOAD_INTERVAL_MILLIS = 60_000L
        const val UPLOAD_BATCH_POINTS = 100
        const val ODOMETER_TIMEOUT_MILLIS = 2_000L
        const val VIN_WAIT_MILLIS = 10_000L
        const val RETRY_MILLIS = 1_000L
        const val KEY_VEHICLE_ID = "vehicleId"
    }
}
