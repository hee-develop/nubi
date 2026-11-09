package com.nubi.car.trip

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.nubi.car.BuildConfig
import com.nubi.car.signals.VehicleInfo
import java.io.File
import java.util.concurrent.Executors

/** 프로세스에 하나뿐인 [TripEngine]에 실제 Android 의존성을 꽂는다. */
object TripEngineProvider {
    @Volatile
    private var instance: TripEngine? = null

    @Volatile
    private var tracker: CoverageTracker? = null

    @Volatile
    private var resolver: VehicleIdResolver? = null

    fun get(context: Context): TripEngine =
        instance ?: synchronized(this) { instance ?: create(context.applicationContext).also { instance = it } }

    /**
     * debug 전용: 차량 SDK 대신 [vin]으로 서버 차량 ID를 받는다(E2E가 `pm clear` 뒤에도 서버 발급 ID를 쓰게 한다. 에뮬레이터의 VIN은 서버 형식 검사에 걸려 등록이 400이다).
     * release에서는 아무것도 하지 않는다.
     */
    fun debugInjectVin(context: Context, vin: String) {
        if (!BuildConfig.DEBUG) return
        get(context)
        resolver?.onVin(vin)
    }

    /** 도로 색칠 결과(종료 한 줄)·전국 완료율 상태. 엔진과 같은 수명이다. */
    fun coverage(context: Context): CoverageTracker {
        get(context)
        return tracker!!
    }

    private fun create(context: Context): TripEngine {
        val main = Handler(Looper.getMainLooper())
        val scheduler = object : Scheduler {
            override fun post(block: () -> Unit) {
                main.post(block)
            }

            override fun postDelayed(delayMs: Long, block: () -> Unit): Cancellable {
                val r = Runnable(block)
                main.postDelayed(r, delayMs)
                return Cancellable { main.removeCallbacks(r) }
            }
        }
        val clock = object : Clock {
            override fun elapsedMs() = SystemClock.elapsedRealtime()
            override fun wallMs() = System.currentTimeMillis()
        }
        val prefs = context.getSharedPreferences("nubi", Context.MODE_PRIVATE)
        val store = object : KeyValueStore {
            override fun getString(key: String) = prefs.getString(key, null)
            override fun putString(key: String, value: String) {
                prefs.edit().putString(key, value).apply()
            }
        }
        val dir = File(context.filesDir, "trips").apply { mkdirs() }
        // Keystore unwrap·파일 읽기는 워커에서 한다. 메인 스레드는 아무것도 기다리지 않는다.
        val setup = lazy { KeystoreCipher.create(dir) }
        val uploader = Uploader(
            queueFile = File(dir, "queue.jsonl"),
            idsFile = File(dir, "server-ids.jsonl"),
            deadLetterFile = File(dir, "dead-letter.jsonl"),
            api = HttpTripApi(BuildConfig.SERVER_URL),
            cipherSetup = { setup.value },
        )
        val resolver = VehicleIdResolver(
            store = VehicleIdStore(File(dir, "vehicle-id.enc"), { setup.value.persistent }) { setup.value.cipher },
            api = HttpVehicleApi(BuildConfig.SERVER_URL),
            executor = Executors.newSingleThreadExecutor(),
        )
        this.resolver = resolver
        val vehicle = VehicleInfo(context, resolver)
        val coverage = CoverageTracker(HttpCoverageApi(BuildConfig.SERVER_URL), Executors.newCachedThreadPool(), { vehicle.vehicleId }, cache = store)
        uploader.onTripEnded = coverage::onTripEnded
        tracker = coverage
        return TripEngine(clock, scheduler, Executors.newSingleThreadExecutor(), vehicle, store, uploader).also { it.onTripStarted = coverage::onTripStarted }
    }
}
