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
    /** 서버가 발급한 차량 ID(`POST /vehicles/register`, 저장해 재사용). VIN을 못 읽었거나 아직 못 받았으면 null. */
    val vehicleId: String?
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
 * 모든 입구 메서드는 [Scheduler]로 넘겨 순서대로 처리하고, 네트워크와 큐 파일 로드·복호화는 [worker]에서만 한다.
 * 생성하면 바로 워커에서 큐 로드를 시작하고(그동안 [TripStatus.loading]), 끝나면 미종료 트립 복구를 한 번 한다(서비스 시작 성공 여부와 무관).
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

    /** 지금 기록 중인 트립의 로컬 id(없으면 null). 지도가 '이 정산이 지금 트립의 것인가'를 가릴 때 쓴다. */
    @Volatile
    var recordingLocalId: String? = null
        private set
    private var failures = 0
    private var nextAttemptElapsed = 0L
    private var draining = false
    private var redrain = false
    private var lastUpload = UploadStatus()
    private var serviceStartedElapsed = clock.elapsedMs()
    private var tickJob: Cancellable? = null
    private var uploadJob: Cancellable? = null

    /** 서비스를 못 띄운 상태는 재시작해도 남도록 저장한다(다음 화면 진입 때 안내하려고). */
    private var serviceFailed = store.getString(KEY_HEALTH) == RecorderHealth.SERVICE_FAILED.name
    private var unsupported = false

    /** Start가 큐에 들어갔거나 곧 들어갈 트립 중 End가 아직 큐에 없는 것. 미종료 트립 복구가 건드리면 안 된다. */
    private val liveTrips = HashSet<String>()

    /** debug 위치 주입을 쓰는 동안 false로 두어 실제 위치 콜백을 무시한다(주입 경로와 섞이지 않게). */
    @Volatile
    var acceptRealLocation: Boolean = true
        private set

    /**
     * 채택한 위치 샘플 하나가 처리될 때마다(좌표, 시각 epoch ms, 지금 기록 중인지). 주행 지도의 로컬 궤적이 화면이 아니라 이 위치 콜백에서 쌓이게 한다.
     * 엔진 스레드에서 불린다. 위치는 로그에 남기지 않는다.
     */
    @Volatile
    var onLocationSample: (lat: Double, lon: Double, tsMillis: Long, recording: Boolean) -> Unit = { _, _, _, _ -> }

    /** 새 트립이 시작됐다(상태기계 Started). 이전 트립의 종료 줄을 치우는 데 쓴다. 엔진 스레드에서 불린다. */
    @Volatile
    var onTripStarted: () -> Unit = {}

    /**
     * 정차 조회 시점이다: 기어가 P가 아닌 값에서 P로 바뀌었고 위치를 알 때, 또는 위치를 모른 채 P가 된 뒤 처음 위치가 들어왔을 때(콜드 스타트). 엔진 스레드에서 불린다.
     */
    @Volatile
    var onParked: () -> Unit = {}

    /**
     * 기록 멈춤(서버 설정 `recordingPaused` 또는 위치정보 동의 철회). true인 동안 새 위치 샘플은 상태기계에 넣지 않고 버린다(새 트립도 시작하지 않는다).
     * 기어는 계속 읽는다. 값은 설정 조회가 정한다([com.nubi.car.screens.ExtrasController]).
     */
    @Volatile
    var recordingPaused: Boolean = false

    /** 트립이 끝났다(상태기계 Ended). 하차 요약 카드가 그 트립의 궤적 범위를 떠 두는 데 쓴다. 엔진 스레드에서 불린다. */
    @Volatile
    var onTripEnded: () -> Unit = {}

    /** 기어가 바뀌었다(화면이 QR·메뉴를 바로 닫으려고 쓴다). 엔진 스레드에서 불린다. */
    @Volatile
    var onGearChange: (Gear?) -> Unit = {}

    /** P가 됐을 때 위치를 아직 몰라 조회를 미룬 상태. 첫 위치가 오면 [onParked]를 한 번 부른다. */
    private var parkedAwaitingLocation = false

    /**
     * 미전송분이 있을 때 업로드를 시도하는 간격(ms). 기본 60초, 주행 중 지도를 켠 경우 20초(계약서 05 3장, 점 100개 기준은 그대로).
     * 값을 바꾸면 다음에 타이머를 걸 때부터 적용된다.
     */
    @Volatile
    var uploadIntervalMillis: Long = UPLOAD_INTERVAL_MILLIS

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
        startLoading()
    }

    private fun startLoading() {
        try {
            worker.execute {
                try {
                    uploader.load()
                } catch (t: Throwable) {
                    Log.w(TAG, "큐 로드 예외: ${t.javaClass.simpleName}")
                }
                scheduler.post { onLoaded() }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "큐 로드 작업 등록 실패: ${t.javaClass.simpleName}")
        }
    }

    /** 큐 로드가 끝났다. 이전 프로세스가 끝내지 못한 트립에 End를 넣고(진행 중인 트립은 제외) 업로드를 시도한다. */
    private fun onLoaded() {
        uploader.recoverUnfinished(HashSet(liveTrips))
        checkVehicleAlias()
        requestUpload(force = false)
        publish()
    }

    /** 엔진이 쓰는 현재 시각(epoch ms). debug `now=` 주입을 따른다(화면의 24시간 판정이 트립 시각과 같은 시계를 쓰도록). */
    fun nowMillis(): Long = wall()

    private fun elapsed() = clock.elapsedMs() + clockOffsetMillis
    private fun wall() = clock.wallMs() + clockOffsetMillis

    // 서비스 수명 ---------------------------------------------------------

    /** 서비스가 시작될 때. 차량 정보를 열고 저장된 '서비스 실패' 표시를 지운다. 미종료 트립 복구는 큐 로드가 끝날 때 한다([onLoaded]). */
    fun onServiceStart() {
        scheduler.post {
            serviceStartedElapsed = clock.elapsedMs()
            machine.reset()
            parkedAwaitingLocation = false
            unsupported = false
            setServiceFailed(false)
            vehicle.start()
            checkVehicleAlias()
            requestUpload(force = false)
            publish()
        }
    }

    /** 포그라운드 서비스를 못 띄웠다(권한·백그라운드 시작 제한 등). 상태를 저장해 다음 화면 진입 때 안내한다. */
    fun onServiceFailed() {
        scheduler.post {
            setServiceFailed(true)
            publish()
        }
    }

    /** 이 차량은 위치 기능을 쓸 수 없다(FusedLocation 미지원·초기화 실패). 위치 콜백을 등록하지 않는다. */
    fun onLocationUnsupported() {
        scheduler.post {
            unsupported = true
            publish()
        }
    }

    private fun setServiceFailed(failed: Boolean) {
        if (serviceFailed == failed) return
        serviceFailed = failed
        try {
            store.putString(KEY_HEALTH, if (failed) RecorderHealth.SERVICE_FAILED.name else RecorderHealth.OK.name)
        } catch (t: Throwable) {
            Log.w(TAG, "상태 저장 실패: ${t.javaClass.simpleName}")
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
        // 좌표가 NaN·무한대·범위 밖이면 샘플 단계에서 버린다(큐 인코딩·서버 검증까지 가면 트립 전체가 막힌다).
        if (!lat.isFinite() || !lon.isFinite() || lat !in -90.0..90.0 || lon !in -180.0..180.0) {
            Log.w(TAG, "유효하지 않은 좌표 샘플 버림")
            return
        }
        val heading = headingDeg?.takeIf { it.isFinite() }
        val conf = confidence?.takeIf { it.isFinite() }
        scheduler.post {
            if (recordingPaused) return@post // 기록 멈춤: 샘플을 버린다
            val ts = tsMillis?.takeIf { kotlin.math.abs(it - wall()) < 24 * 3_600_000L } ?: wall()
            handle(machine.onLocation(Sample(ts, lat, lon, heading, conf), elapsed()))
            publish()
            try {
                onLocationSample(lat, lon, ts, machine.state == TripState.RECORDING)
            } catch (t: Throwable) {
                Log.w(TAG, "위치 샘플 알림 예외: ${t.javaClass.simpleName}")
            }
            if (parkedAwaitingLocation && machine.gear == Gear.P) {
                parkedAwaitingLocation = false
                notifyParked()
            }
        }
    }

    private fun notifyParked() {
        try {
            onParked()
        } catch (t: Throwable) {
            Log.w(TAG, "정차 알림 예외: ${t.javaClass.simpleName}")
        }
    }

    fun onGear(gear: Gear?) {
        scheduler.post {
            val before = machine.gear
            handle(machine.onGear(gear, elapsed()))
            publish()
            if (gear == Gear.P && before != Gear.P) {
                if (machine.lastRaw == null) parkedAwaitingLocation = true else notifyParked()
            } else if (gear != Gear.P) {
                parkedAwaitingLocation = false
            }
            try {
                onGearChange(gear)
            } catch (t: Throwable) {
                Log.w(TAG, "기어 알림 예외: ${t.javaClass.simpleName}")
            }
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
            parkedAwaitingLocation = false
            active = null
            recordingLocalId = null
            clockOffsetMillis = 0
            failures = 0
            nextAttemptElapsed = 0
            lastUpload = UploadStatus()
            liveTrips.clear()
            uploader.clear()
            publish()
        }
    }

    // 내부 ---------------------------------------------------------------

    private fun onTick() {
        checkVehicleAlias()
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
                    try {
                        onTripStarted()
                    } catch (t: Throwable) {
                        Log.w(TAG, "트립 시작 알림 예외: ${t.javaClass.simpleName}")
                    }
                    val ctx = TripCtx(UUID.randomUUID().toString(), e.startedAtMillis)
                    liveTrips.add(ctx.localId)
                    ctx.held.addAll(e.points)
                    active = ctx
                    recordingLocalId = ctx.localId
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
                    recordingLocalId = null
                    try {
                        onTripEnded()
                    } catch (t: Throwable) {
                        Log.w(TAG, "트립 종료 알림 예외: ${t.javaClass.simpleName}")
                    }
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
            liveTrips.remove(ctx.localId)
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
            liveTrips.remove(ctx.localId)
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
                    block(km?.takeIf { it.isFinite() })
                    publish()
                }
            }
        }
        vehicle.readOdometerKm(finish)
        scheduler.postDelayed(ODOMETER_TIMEOUT_MILLIS) { finish(null) }
    }

    /**
     * 차량 ID는 서버가 VIN으로 발급한 ID다(차량 앱은 VIN을 서버에 한 번 보내 받고 암호화 저장해 재사용한다).
     * 그 ID를 받기 전에는 UUID를 만들거나 저장하지 않고 null(업로드 보류)을 돌려준다.
     * 서비스 시작 후 [VIN_WAIT_MILLIS]가 지나도 ID가 없을 때만(또는 [force]) UUID로 대체해 저장한다(이때는 서버 등록을 하지 않는다).
     * 서버 ID를 나중에 받으면 [reconcileVehicleId]가 UUID를 서버 ID에 잇는다.
     */
    private fun resolveVehicleId(force: Boolean): String? {
        vehicle.vehicleId?.let {
            reconcileVehicleId(it)
            return it
        }
        val waited = clock.elapsedMs() - serviceStartedElapsed >= VIN_WAIT_MILLIS
        if (!waited && !force) return null
        return store.getString(KEY_VEHICLE_ID) ?: UUID.randomUUID().toString().also { store.putString(KEY_VEHICLE_ID, it) }
    }

    /** 서버 발급 차량 ID를 이미 받았으면 UUID 대체 ID가 남아 있는지 확인한다. */
    private fun checkVehicleAlias() {
        vehicle.vehicleId?.let { reconcileVehicleId(it) }
    }

    /**
     * UUID로 대체해 쓰던 차량 ID가 저장돼 있는데 서버 ID를 이제야 받았다면, 큐에 남은 미전송 Start의 차량 ID를 서버 ID로 바꾸고
     * 서버에 alias(`POST /vehicles/alias`)를 큐 항목으로 보낸다(재시도 가능). 둘 다 [Uploader.enqueue]가 한다.
     * 저장된 UUID는 서버 ID로 바꿔 한 번만 한다(큐에 넣은 뒤 저장하므로, 그 사이 죽으면 다시 넣는다. 서버 alias는 멱등).
     */
    private fun reconcileVehicleId(serverId: String) {
        val old = store.getString(KEY_VEHICLE_ID) ?: return
        if (old == serverId) return
        Log.i(TAG, "UUID 차량 ID를 서버 ID로 전환(alias 큐 등록)")
        uploader.enqueue(QueueEntry.Alias(old, serverId))
        store.putString(KEY_VEHICLE_ID, serverId)
        requestUpload(force = false)
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
                DrainKind.OK ->
                    if (result.uploadedPoints == 0 && result.endedTrips > 0) UploadStatus(UploadKind.END_SENT) else UploadStatus(UploadKind.OK, result.uploadedPoints)
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
            gear = machine.gear,
            sampleCount = machine.sampleCount,
            distanceM = machine.distanceM.toInt(),
            upload = lastUpload,
            pendingPoints = uploader.pendingPoints,
            loading = !uploader.loaded,
            health = when {
                serviceFailed -> RecorderHealth.SERVICE_FAILED
                unsupported -> RecorderHealth.UNSUPPORTED
                else -> RecorderHealth.OK
            },
            saveFailures = uploader.saveFailures,
            corruptLines = uploader.corruptLines,
            discardedLines = uploader.discardedLines,
            storageHeld = uploader.memoryOnly,
            lastLocation = machine.lastRaw?.let { LatLon(it.lat, it.lon) },
        )
        updateTimers()
    }

    /** 5초 tick은 기록 중일 때만, 업로드 타이머(기본 60초, 지도를 켜면 20초)는 큐에 미전송분이 있을 때만 돈다(놀 때는 아무것도 깨우지 않는다). */
    private fun updateTimers() {
        if (machine.state == TripState.RECORDING) {
            if (tickJob == null) tickJob = scheduler.postDelayed(TICK_MILLIS) { tickJob = null; onTick() }
        } else {
            tickJob?.cancel()
            tickJob = null
        }
        if (uploader.pendingEntries > 0) {
            if (uploadJob == null) {
                uploadJob = scheduler.postDelayed(uploadIntervalMillis) {
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

        /** 주행 중 지도를 켠 경우의 업로드 간격(서버 잠정 색칠이 지나온 길을 따라오게). */
        const val MAP_UPLOAD_INTERVAL_MILLIS = 20_000L
        const val UPLOAD_BATCH_POINTS = 100
        const val ODOMETER_TIMEOUT_MILLIS = 2_000L
        const val VIN_WAIT_MILLIS = 10_000L
        const val RETRY_MILLIS = 1_000L
        const val KEY_VEHICLE_ID = "vehicleId"
        const val KEY_HEALTH = "recorderHealth"

        /** 기록 멈춤 마지막 값(서버 설정을 받기 전에도 재시작 직후 기록하지 않게). */
        const val KEY_PAUSED = "recordingPaused"
    }
}
