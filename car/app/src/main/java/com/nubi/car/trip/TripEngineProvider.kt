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

    fun get(context: Context): TripEngine =
        instance ?: synchronized(this) { instance ?: create(context.applicationContext).also { instance = it } }

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
        return TripEngine(clock, scheduler, Executors.newSingleThreadExecutor(), VehicleInfo(context, resolver), store, uploader)
    }
}
