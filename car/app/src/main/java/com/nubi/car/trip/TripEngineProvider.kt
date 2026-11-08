package com.nubi.car.trip

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
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
        val cipher = KeystoreCipher.create()
        val uploader = Uploader(
            queue = TripQueue(File(dir, "queue.jsonl"), cipher),
            idsFile = File(dir, "server-ids.jsonl"),
            deadLetterFile = File(dir, "dead-letter.jsonl"),
            api = HttpTripApi(BuildConfig.SERVER_URL),
            cipher = cipher,
        )
        Log.i("NubiTrip", "엔진 생성, 대기 항목 ${uploader.pendingEntries}")
        return TripEngine(clock, scheduler, Executors.newSingleThreadExecutor(), VehicleInfo(context), store, uploader)
    }
}
