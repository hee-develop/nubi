package com.nubi.car.trip

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.nubi.car.BuildConfig
import com.nubi.car.signals.VehicleInfo
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * 프로세스 하나에 하나. 상태기계·큐·업로드를 묶는다. 서비스(위치·차량 신호 수집)와 debug 주입이 같은 입구를 쓴다.
 * 모든 입구 메서드는 메인 스레드로 넘겨 순서대로 처리한다.
 */
class TripEngine private constructor(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val machine = TripStateMachine()
    private val vehicleInfo = VehicleInfo(context)
    private val uploader: Uploader

    private var clockOffsetMillis = 0L
    private var latestSpeedKph: Float? = null
    private var localId: String? = null
    private var startPending = false
    private val heldPoints = ArrayList<TripPoint>()
    private var failures = 0
    private var nextAttemptAt = 0L
    private var draining = false
    private var lastUpload = "없음"

    /** debug 위치 주입이 시작되면 false로 바뀌어 실제 위치 콜백을 무시한다(주입 경로와 섞이지 않게). */
    @Volatile
    var acceptRealLocation: Boolean = true
        private set

    @Volatile
    var status: TripStatus = TripStatus()
        private set

    init {
        val dir = File(context.filesDir, "trips").apply { mkdirs() }
        uploader = Uploader(TripQueue(File(dir, "queue.jsonl")), File(dir, "server-ids.json"), HttpTripApi(BuildConfig.SERVER_URL))
        vehicleInfo.start()
        main.postDelayed(object : Runnable {
            override fun run() {
                onTick()
                main.postDelayed(this, TICK_MILLIS)
            }
        }, TICK_MILLIS)
        main.postDelayed(object : Runnable {
            override fun run() {
                requestUpload(force = false)
                main.postDelayed(this, UPLOAD_INTERVAL_MILLIS)
            }
        }, UPLOAD_INTERVAL_MILLIS)
        publish()
    }

    fun now(): Long = System.currentTimeMillis() + clockOffsetMillis

    // 입구 ---------------------------------------------------------------

    fun onLocation(lat: Double, lon: Double, headingDeg: Float?, confidence: Float?, tsMillis: Long? = null) {
        main.post {
            val ts = tsMillis?.takeIf { kotlin.math.abs(it - now()) < 24 * 3_600_000L } ?: now()
            handle(machine.onLocation(Sample(ts, lat, lon, headingDeg, confidence, latestSpeedKph)))
            publish()
        }
    }

    fun onGear(gear: Gear?) {
        main.post {
            handle(machine.onGear(gear, now()))
            publish()
        }
    }

    fun onSpeedKph(kph: Float?) {
        main.post { latestSpeedKph = kph }
    }

    /** 서비스 종료·Suspend. 기록 중이면 트립을 끝낸다. */
    fun onStop() {
        main.post {
            handle(machine.onStop())
            publish()
        }
    }

    // debug 전용으로 쓰이지만 동작은 일반 기능이다 -------------------------------

    /** 시계를 [epochMillis]로 맞추고(이후 now()가 그 시각에서 흐른다) 바로 한 번 확인한다. */
    fun setClock(epochMillis: Long) {
        main.post {
            clockOffsetMillis = epochMillis - System.currentTimeMillis()
            onTick()
        }
    }

    fun setRealLocationAccepted(accepted: Boolean) {
        acceptRealLocation = accepted
    }

    fun flush() {
        main.post { requestUpload(force = true) }
    }

    /** 상태기계·큐·시계를 모두 비운다. */
    fun reset() {
        main.post {
            machine.reset()
            localId = null
            startPending = false
            heldPoints.clear()
            latestSpeedKph = null
            clockOffsetMillis = 0
            failures = 0
            nextAttemptAt = 0
            lastUpload = "없음"
            acceptRealLocation = true
            worker.execute {
                uploader.clear()
                main.post { publish() }
            }
            publish()
        }
    }

    // 내부 ---------------------------------------------------------------

    private fun onTick() {
        handle(machine.onTick(now()))
        publish()
    }

    private fun handle(events: List<TripEvent>) {
        for (e in events) {
            when (e) {
                is TripEvent.Started -> {
                    val id = UUID.randomUUID().toString()
                    localId = id
                    startPending = true
                    heldPoints.clear()
                    heldPoints.addAll(e.points)
                    withOdometer { km -> beginTrip(id, e.startedAtMillis, km) }
                }
                is TripEvent.PointsAccepted -> {
                    val id = localId ?: continue
                    if (startPending) heldPoints.addAll(e.points) else enqueuePoints(id, e.points)
                }
                is TripEvent.Ended -> {
                    val id = localId ?: continue
                    withOdometer { km -> finishTrip(id, e.endedAtMillis, km) }
                }
            }
        }
    }

    private fun beginTrip(id: String, startedAt: Long, km: Double?) {
        if (!startPending || localId != id) return
        startPending = false
        val vehicleId = currentVehicleId()
        uploader.enqueue(QueueEntry.Start(id, vehicleId, vehicleId, startedAt, km))
        enqueuePoints(id, heldPoints.toList())
        heldPoints.clear()
    }

    private fun finishTrip(id: String, endedAt: Long, km: Double?) {
        if (startPending && localId == id) beginTrip(id, endedAt, null)
        uploader.enqueue(QueueEntry.End(id, endedAt, km))
        requestUpload(force = true)
        publish()
    }

    private fun enqueuePoints(id: String, points: List<TripPoint>) {
        if (points.isEmpty()) return
        uploader.enqueue(*points.map { QueueEntry.Point(id, it) }.toTypedArray())
        if (uploader.pendingPoints >= UPLOAD_BATCH_POINTS) requestUpload(force = false)
    }

    /** 오도미터를 읽어 메인 스레드에서 [block]을 부른다. 2초 안에 못 읽으면 null로 진행한다. */
    private fun withOdometer(block: (Double?) -> Unit) {
        var done = false
        val finish: (Double?) -> Unit = { km ->
            main.post {
                if (!done) {
                    done = true
                    block(km)
                    publish()
                }
            }
        }
        vehicleInfo.readOdometerKm(finish)
        main.postDelayed({ finish(null) }, ODOMETER_TIMEOUT_MILLIS)
    }

    private fun currentVehicleId(): String = vehicleInfo.vinHash ?: fallbackVehicleId()

    private fun fallbackVehicleId(): String {
        val prefs = context.getSharedPreferences("nubi", Context.MODE_PRIVATE)
        return prefs.getString("vehicleId", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("vehicleId", it).apply() }
    }

    private fun requestUpload(force: Boolean) {
        if (draining || uploader.pendingEntries == 0) return
        if (!force && now0() < nextAttemptAt) return
        draining = true
        worker.execute {
            val result = uploader.drain()
            main.post {
                draining = false
                failures = if (result.ok) 0 else failures + 1
                nextAttemptAt = now0() + backoffMillis(failures)
                lastUpload = "${result.message} (${java.time.LocalTime.now().withNano(0)})"
                Log.i(TAG, "업로드 ${result.message}, 대기 ${uploader.pendingEntries}")
                publish()
            }
        }
    }

    /** 재시도 간격은 가짜 시계가 아니라 실제 시계로 잰다. */
    private fun now0(): Long = System.currentTimeMillis()

    private fun publish() {
        status = TripStatus(
            state = machine.state,
            sampleCount = machine.sampleCount,
            distanceM = machine.distanceM.toInt(),
            lastUpload = lastUpload,
            pendingPoints = uploader.pendingPoints,
            vehicleId = currentVehicleId(),
        )
    }

    companion object {
        private const val TAG = "NubiTrip"
        private const val TICK_MILLIS = 5_000L
        private const val UPLOAD_INTERVAL_MILLIS = 60_000L
        private const val UPLOAD_BATCH_POINTS = 100
        private const val ODOMETER_TIMEOUT_MILLIS = 2_000L

        @Volatile
        private var instance: TripEngine? = null

        fun get(context: Context): TripEngine =
            instance ?: synchronized(this) { instance ?: TripEngine(context.applicationContext).also { instance = it } }
    }
}
